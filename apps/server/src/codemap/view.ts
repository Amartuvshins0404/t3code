import type {
  CodemapChange,
  CodemapChangeStatus,
  CodemapView,
  CodemapViewNode,
  RunId,
} from "@t3tools/contracts";

import type { CodemapAnalysis, CodemapAnalysisNode } from "./analyze.ts";

const MAX_TOP = 40;
const MAX_INNER = 12;

function toViewNode(node: CodemapAnalysisNode, parentId: string | null): CodemapViewNode {
  return {
    id: node.id,
    parentId,
    kind: node.kind,
    name: node.name,
    language: node.language,
    files: node.files,
    lines: node.lines,
    childCount: node.children.length,
    vendored: node.vendored,
    minor: isMinor(node),
  };
}

const DOC_LANGUAGES = new Set(["Markdown", "JSON", "YAML", "TOML", "HTML"]);
const CONFIG_FILE = /(^|[.-])config\.|^tsconfig|^package\.json$/;

function isMinor(node: CodemapAnalysisNode): boolean {
  if (node.vendored || node.name.startsWith(".")) return true;
  if (node.kind === "file" && CONFIG_FILE.test(node.name)) return true;
  return node.language === null || DOC_LANGUAGES.has(node.language);
}

export interface RawChange {
  readonly path: string;
  readonly from: string | null;
  readonly status: CodemapChangeStatus;
  readonly additions: number;
  readonly deletions: number;
}

const STATUS_BY_LETTER: Record<string, CodemapChangeStatus> = {
  A: "added",
  D: "deleted",
  R: "renamed",
};

export function parseRawNumstat(output: string, limit: number): ReadonlyArray<RawChange> {
  const fields = output.split("\u0000");
  const statuses = new Map<string, { status: CodemapChangeStatus; from: string | null }>();
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length && changes.length < limit; index += 1) {
    const field = fields[index] ?? "";
    if (field.startsWith(":")) {
      const letter = field.slice(field.lastIndexOf(" ") + 1, field.lastIndexOf(" ") + 2);
      const status = STATUS_BY_LETTER[letter] ?? "modified";
      const twoPaths = letter === "R" || letter === "C";
      const from = twoPaths ? (fields[++index] ?? null) : null;
      statuses.set(fields[++index] ?? "", { status, from });
      continue;
    }
    const counts = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!counts) continue;
    let path = counts[3] ?? "";
    if (path === "") {
      index += 2;
      path = fields[index] ?? "";
    }
    if (path === "") continue;
    const raw = statuses.get(path);
    changes.push({
      path,
      from: raw?.from ?? null,
      status: raw?.status ?? "modified",
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }
  return changes;
}

export function authoredChanges(input: {
  readonly raw: ReadonlyArray<RawChange>;
  readonly runByPath: ReadonlyMap<string, RunId | null>;
  readonly prefix: string;
  readonly analysis: CodemapAnalysis;
  readonly limit: number;
}): ReadonlyArray<CodemapChange> {
  const { runByPath, prefix } = input;
  const local = (file: string) => file.slice(prefix.length);
  return input.raw
    .filter(
      (change) =>
        change.path.startsWith(prefix) &&
        (runByPath.has(change.path) || (change.from !== null && runByPath.has(change.from))),
    )
    .slice(0, input.limit)
    .map((change) => {
      const path = local(change.path);
      const area = areaOf(input.analysis, path);
      return {
        path,
        from: change.from === null ? null : local(change.from),
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        areaId: area.id,
        areaName: area.name,
        runId: runByPath.get(change.path) ?? runByPath.get(change.from ?? "") ?? null,
      };
    });
}

function areaOf(analysis: CodemapAnalysis, path: string): { id: string; name: string } {
  let id = path;
  while (id !== "" && !analysis.nodes.has(id)) {
    const slash = id.lastIndexOf("/");
    id = slash === -1 ? "" : id.slice(0, slash);
  }
  let node = analysis.nodes.get(id);
  let topLevel: CodemapAnalysisNode | undefined;
  while (node && node.parentId !== null) {
    if (node.kind === "package") return { id: node.id, name: node.name };
    if (node.kind !== "file") topLevel = node;
    node = analysis.nodes.get(node.parentId);
  }
  if (topLevel) return { id: topLevel.id, name: topLevel.name };
  const slash = path.indexOf("/");
  return slash === -1
    ? { id: "", name: "" }
    : { id: path.slice(0, slash), name: path.slice(0, slash) };
}

function keptAncestors(analysis: CodemapAnalysis, paths: ReadonlyArray<string>) {
  const kept = new Set<string>();
  for (const file of paths) {
    let id: string | null = file;
    while (id !== null && !analysis.nodes.has(id)) {
      const slash: number = id.lastIndexOf("/");
      id = slash === -1 ? "" : id.slice(0, slash);
    }
    for (let node = id === null ? undefined : analysis.nodes.get(id); node;) {
      if (kept.has(node.id)) break;
      kept.add(node.id);
      node = node.parentId === null ? undefined : analysis.nodes.get(node.parentId);
    }
  }
  return kept;
}

function biggestFirst(
  analysis: CodemapAnalysis,
  ids: ReadonlyArray<string>,
  limit: number,
  kept: ReadonlySet<string>,
) {
  const sorted = ids
    .map((id) => analysis.nodes.get(id))
    .filter((node): node is CodemapAnalysisNode => node !== undefined)
    .toSorted((a, b) => Number(isMinor(a)) - Number(isMinor(b)) || b.lines - a.lines);
  return sorted.filter((node, index) => index < limit || kept.has(node.id));
}

export function buildCodemapView(
  analysis: CodemapAnalysis,
  focusId: string,
  touched: ReadonlyArray<string> = [],
): CodemapView {
  const focus = analysis.nodes.get(focusId) ?? analysis.nodes.get("");
  if (!focus) return { focusId: "", path: [], nodes: [], hiddenChildren: 0 };
  const kept = keptAncestors(analysis, touched);

  const path: { id: string; name: string }[] = [];
  for (let node: CodemapAnalysisNode | undefined = focus; node;) {
    path.unshift({ id: node.id, name: node.name });
    node = node.parentId === null ? undefined : analysis.nodes.get(node.parentId);
  }

  const top = biggestFirst(analysis, focus.children, MAX_TOP, kept);
  const nodes: CodemapViewNode[] = [];
  for (const node of top) {
    nodes.push(toViewNode(node, null));
    if (node.kind === "file" || node.vendored) continue;
    for (const child of biggestFirst(analysis, node.children, MAX_INNER, kept)) {
      nodes.push(toViewNode(child, node.id));
    }
  }

  return {
    focusId: focus.id,
    path,
    nodes,
    hiddenChildren: focus.children.length - top.length,
  };
}

export function dirtyPaths(porcelain: string): ReadonlyArray<string> {
  const fields = porcelain.split("\u0000");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}

export function underPrefix(paths: ReadonlyArray<string>, prefix: string): string[] {
  return paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}
