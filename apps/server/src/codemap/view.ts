import type { CodemapView, CodemapViewEdge, CodemapViewNode } from "@t3tools/contracts";

import type { CodemapAnalysis, CodemapAnalysisNode } from "./analyze.ts";

const MAX_TOP = 40;
const MAX_INNER = 8;
const MAX_OUTSIDE = 10;

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
    external: false,
  };
}

const DOC_LANGUAGES = new Set(["Markdown", "JSON", "YAML", "TOML", "HTML"]);
const CONFIG_FILE = /(^|[.-])config\.|^tsconfig|^package\.json$/;

function isMinor(node: CodemapAnalysisNode): boolean {
  if (node.vendored || node.name.startsWith(".")) return true;
  if (node.kind === "file" && CONFIG_FILE.test(node.name)) return true;
  return node.language === null || DOC_LANGUAGES.has(node.language);
}

function biggestFirst(analysis: CodemapAnalysis, ids: ReadonlyArray<string>, limit: number) {
  if (ids.length <= limit) return ids;
  return ids
    .map((id) => analysis.nodes.get(id))
    .filter((node): node is CodemapAnalysisNode => node !== undefined)
    .toSorted((a, b) => Number(isMinor(a)) - Number(isMinor(b)) || b.lines - a.lines)
    .slice(0, limit)
    .map((node) => node.id);
}

export function buildCodemapView(analysis: CodemapAnalysis, focusId: string): CodemapView {
  const focus = analysis.nodes.get(focusId) ?? analysis.nodes.get("");
  if (!focus) return { focusId: "", path: [], nodes: [], edges: [], hiddenChildren: 0 };

  const path: { id: string; name: string }[] = [];
  for (let node: CodemapAnalysisNode | undefined = focus; node;) {
    path.unshift({ id: node.id, name: node.name });
    node = node.parentId === null ? undefined : analysis.nodes.get(node.parentId);
  }

  const top = biggestFirst(analysis, focus.children, MAX_TOP);
  const visible = new Map<string, CodemapViewNode>();
  for (const id of top) {
    const node = analysis.nodes.get(id);
    if (!node) continue;
    visible.set(id, toViewNode(node, null));
    if (node.kind === "file" || node.vendored) continue;
    for (const childId of biggestFirst(analysis, node.children, MAX_INNER)) {
      const child = analysis.nodes.get(childId);
      if (child) visible.set(childId, toViewNode(child, id));
    }
  }

  const lifted = new Map<string, string | null>();
  const liftOf = (id: string): string | null => {
    const cached = lifted.get(id);
    if (cached !== undefined) return cached;
    let current: string | null = id;
    const walked: string[] = [];
    let result: string | null = null;
    while (current !== null) {
      if (visible.has(current)) {
        result = current;
        break;
      }
      const known = lifted.get(current);
      if (known !== undefined) {
        result = known;
        break;
      }
      walked.push(current);
      current = analysis.nodes.get(current)?.parentId ?? null;
    }
    for (const id of walked) lifted.set(id, result);
    return result;
  };

  const pathIds = new Set(path.map((entry) => entry.id));
  const outsideOf = (id: string): string | null => {
    let ownPackage: string | null = null;
    for (let node = analysis.nodes.get(id); node;) {
      if (pathIds.has(node.id) || node.parentId === null) return null;
      if (node.parentId === focus.id) return null;
      if (ownPackage === null && node.kind === "package") ownPackage = node.id;
      if (pathIds.has(node.parentId)) return ownPackage ?? node.id;
      node = analysis.nodes.get(node.parentId);
    }
    return null;
  };
  const outsideWeights = new Map<string, number>();
  const outsideEdges: { source: string; target: string; weight: number }[] = [];

  const topOf = (id: string): string => visible.get(id)?.parentId ?? id;
  const weights = new Map<string, number>();
  for (const [source, targets] of analysis.edges) {
    const inside = liftOf(source);
    const from = inside ?? outsideOf(source);
    if (from === null) continue;
    for (const [target, weight] of targets) {
      const insideTarget = liftOf(target);
      if (inside === null && insideTarget === null) continue;
      const to = insideTarget ?? outsideOf(target);
      if (to === null || to === from) continue;
      if (inside === null || insideTarget === null) {
        const outside = inside === null ? from : to;
        outsideWeights.set(outside, (outsideWeights.get(outside) ?? 0) + weight);
        outsideEdges.push({ source: from, target: to, weight });
        continue;
      }
      if (topOf(from) === topOf(to) && visible.get(from)?.parentId === null) continue;
      if (to === visible.get(from)?.parentId || from === visible.get(to)?.parentId) continue;
      const key = `${from}\u0000${to}`;
      weights.set(key, (weights.get(key) ?? 0) + weight);
    }
  }

  const shownOutside = new Set(
    [...outsideWeights]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, MAX_OUTSIDE)
      .map(([id]) => id),
  );
  for (const id of shownOutside) {
    const node = analysis.nodes.get(id);
    if (node)
      visible.set(id, {
        ...toViewNode(node, null),
        name: node.kind === "package" ? node.name : node.id,
        external: true,
      });
  }
  for (const edge of outsideEdges) {
    if (!shownOutside.has(edge.source) && !shownOutside.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}`;
    weights.set(key, (weights.get(key) ?? 0) + edge.weight);
  }

  const edges: CodemapViewEdge[] = [];
  for (const [key, weight] of weights) {
    const [source = "", target = ""] = key.split("\u0000");
    edges.push({ source, target, weight });
  }

  return {
    focusId: focus.id,
    path,
    nodes: [...visible.values()],
    edges,
    hiddenChildren: focus.children.length - top.length,
  };
}
