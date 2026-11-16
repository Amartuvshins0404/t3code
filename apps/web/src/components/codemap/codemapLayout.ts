import type { CodemapView, CodemapViewNode } from "@t3tools/contracts";

const CHIP_WIDTH = 176;
const CHIP_HEIGHT = 30;
const CHIP_GAP = 8;
const GROUP_PADDING = 12;
const GROUP_HEADER = 44;
const LEAF_WIDTH = 200;
const LEAF_HEIGHT = 52;

export interface LaidOutNode {
  readonly node: CodemapViewNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hiddenChildren: number;
}

export interface LaidOutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly weight: number;
}

export interface CodemapLayout {
  readonly nodes: ReadonlyArray<LaidOutNode>;
  readonly edges: ReadonlyArray<LaidOutEdge>;
  readonly groupEdges: ReadonlyArray<LaidOutEdge>;
}

export function visibleView(view: CodemapView, showMinor: boolean): CodemapView {
  if (showMinor) return view;
  const hiddenTop = new Set(
    view.nodes.filter((node) => node.parentId === null && node.minor).map((node) => node.id),
  );
  const nodes = view.nodes.filter((node) =>
    node.parentId === null ? !hiddenTop.has(node.id) : !node.minor && !hiddenTop.has(node.parentId),
  );
  const kept = new Set(nodes.map((node) => node.id));
  const parentOf = new Map(view.nodes.map((node) => [node.id, node.parentId]));
  const keptEnd = (id: string) => {
    if (kept.has(id)) return id;
    const parent = parentOf.get(id);
    return parent != null && kept.has(parent) ? parent : null;
  };
  const merged = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of view.edges) {
    const source = keptEnd(edge.source);
    const target = keptEnd(edge.target);
    if (source === null || target === null || source === target) continue;
    const key = `${source}\u0000${target}`;
    const existing = merged.get(key);
    if (existing) existing.weight += edge.weight;
    else merged.set(key, { source, target, weight: edge.weight });
  }
  const edges = [...merged.values()];
  const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  return {
    ...view,
    nodes: nodes.filter((node) => !node.external || linked.has(node.id)),
    edges,
  };
}

function groupSize(childCount: number) {
  const columns = childCount <= 1 ? 2 : childCount <= 3 ? childCount : childCount <= 8 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(childCount / columns));
  return {
    columns,
    width: GROUP_PADDING * 2 + columns * CHIP_WIDTH + (columns - 1) * CHIP_GAP,
    height: GROUP_HEADER + GROUP_PADDING + rows * CHIP_HEIGHT + (rows - 1) * CHIP_GAP,
  };
}

type Elk = InstanceType<typeof import("elkjs/lib/elk.bundled.js").default>;

let elkPromise: Promise<Elk> | null = null;

function loadElk() {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return elkPromise;
}

export async function layoutCodemap(view: CodemapView): Promise<CodemapLayout> {
  const top = view.nodes.filter((node) => node.parentId === null);
  const childrenOf = new Map<string, CodemapViewNode[]>();
  for (const node of view.nodes) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  const topOf = new Map<string, string>();
  for (const node of view.nodes) topOf.set(node.id, node.parentId ?? node.id);

  const sizes = new Map(
    top.map((node) => {
      const kids = childrenOf.get(node.id)?.length ?? 0;
      if (kids === 0) return [node.id, { columns: 0, width: LEAF_WIDTH, height: LEAF_HEIGHT }];
      return [node.id, groupSize(kids)];
    }),
  );

  const liftedEdges = new Map<string, number>();
  for (const edge of view.edges) {
    const source = topOf.get(edge.source);
    const target = topOf.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}\u0000${target}`;
    liftedEdges.set(key, (liftedEdges.get(key) ?? 0) + edge.weight);
  }

  const elk = await loadElk();
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.componentComponent": "32",
      "elk.aspectRatio": "1.6",
      "elk.layered.compaction.connectedComponents": "true",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: top.map((node) => ({
      id: node.id,
      width: sizes.get(node.id)?.width ?? LEAF_WIDTH,
      height: sizes.get(node.id)?.height ?? LEAF_HEIGHT,
    })),
    edges: [...liftedEdges.keys()].map((key, index) => {
      const [source = "", target = ""] = key.split("\u0000");
      return { id: `e${index}`, sources: [source], targets: [target] };
    }),
  });

  const positions = new Map((result.children ?? []).map((child) => [child.id, child]));
  const nodes: LaidOutNode[] = [];
  for (const node of top) {
    const size = sizes.get(node.id) ?? { columns: 0, width: LEAF_WIDTH, height: LEAF_HEIGHT };
    const position = positions.get(node.id);
    const kids = childrenOf.get(node.id) ?? [];
    nodes.push({
      node,
      x: position?.x ?? 0,
      y: position?.y ?? 0,
      width: size.width,
      height: size.height,
      hiddenChildren: Math.max(0, node.childCount - kids.length),
    });
    kids.forEach((child, index) => {
      const column = index % size.columns;
      const row = Math.floor(index / size.columns);
      nodes.push({
        node: child,
        x: GROUP_PADDING + column * (CHIP_WIDTH + CHIP_GAP),
        y: GROUP_HEADER + row * (CHIP_HEIGHT + CHIP_GAP),
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT,
        hiddenChildren: 0,
      });
    });
  }

  return {
    nodes,
    edges: view.edges.map((edge) => ({
      id: `${edge.source}\u0000${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
    })),
    groupEdges: [...liftedEdges].map(([key, weight]) => {
      const [source = "", target = ""] = key.split("\u0000");
      return { id: `group:${key}`, source, target, weight };
    }),
  };
}

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#e5c445",
  Python: "#3572a5",
  Go: "#00add8",
  Rust: "#dea584",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Swift: "#f05138",
  "C#": "#178600",
  C: "#8a8a8a",
  "C++": "#f34b7d",
  "Objective-C": "#438eff",
  Ruby: "#cc342d",
  PHP: "#7a86b8",
  Dart: "#00b4ab",
  Shell: "#89e051",
  SQL: "#e38c00",
  CSS: "#a46cd8",
  HTML: "#e34c26",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Elixir: "#6e4a7e",
};

export function languageColor(language: string | null): string {
  return (language && LANGUAGE_COLORS[language]) || "var(--muted-foreground)";
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}
