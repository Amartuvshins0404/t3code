import type { CodemapView, CodemapViewNode } from "@t3tools/contracts";

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

export function parseNameStatus(output: string, limit: number) {
  const fields = output.split("\u0000");
  const touched: string[] = [];
  const added: string[] = [];
  for (let index = 0; index + 1 < fields.length && touched.length < limit; index += 2) {
    const status = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (file.length === 0) continue;
    touched.push(file);
    if (status === "A") added.push(file);
  }
  return { touched, added };
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
