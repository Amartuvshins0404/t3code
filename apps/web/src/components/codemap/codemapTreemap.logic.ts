import type { CodemapViewNode, RunId } from "@t3tools/contracts";
import type { TurnDiffSummary as ThreadCheckpointSummary } from "~/types";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TouchedFile {
  readonly path: string;
  readonly repoPath: string;
  readonly added: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly runId: RunId;
}

export type PartStatus = "new" | "changed" | null;

export interface MapBox {
  readonly node: CodemapViewNode;
  readonly rect: Rect;
  readonly status: PartStatus;
  readonly touched: number;
  readonly children: ReadonlyArray<MapBox>;
}

const HEADER = 18;
const PAD = 3;
const MIN_INNER = 14;
const LIT_SHARE = 0.05;

function squarify<T>(
  items: ReadonlyArray<{ readonly item: T; readonly weight: number }>,
  rect: Rect,
): Array<{ item: T; rect: Rect }> {
  const queue = items.filter((entry) => entry.weight > 0).toSorted((a, b) => b.weight - a.weight);
  const total = queue.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const out: Array<{ item: T; rect: Rect }> = [];
  let free = rect;
  let row: Array<{ item: T; area: number }> = [];

  const worst = (areas: ReadonlyArray<number>, side: number) => {
    const sum = areas.reduce((acc, area) => acc + area, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const place = () => {
    const area = row.reduce((sum, entry) => sum + entry.area, 0);
    if (free.w >= free.h) {
      const width = free.h > 0 ? area / free.h : 0;
      let y = free.y;
      for (const entry of row) {
        const h = width > 0 ? entry.area / width : 0;
        out.push({ item: entry.item, rect: { x: free.x, y, w: width, h } });
        y += h;
      }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      const height = free.w > 0 ? area / free.w : 0;
      let x = free.x;
      for (const entry of row) {
        const w = height > 0 ? entry.area / height : 0;
        out.push({ item: entry.item, rect: { x, y: free.y, w, h: height } });
        x += w;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
    row = [];
  };

  for (const entry of queue) {
    const next = { item: entry.item, area: entry.weight * scale };
    const side = Math.min(free.w, free.h);
    const areas = row.map((current) => current.area);
    if (row.length === 0 || worst([...areas, next.area], side) <= worst(areas, side)) {
      row.push(next);
    } else {
      place();
      row.push(next);
    }
  }
  if (row.length > 0) place();
  return out;
}

export function touchedFiles(
  checkpoints: ReadonlyArray<ThreadCheckpointSummary>,
  addedPaths: ReadonlyArray<string>,
  pathPrefix: string,
): ReadonlyArray<TouchedFile> {
  const added = new Set(addedPaths);
  const byPath = new Map<string, TouchedFile & { turn: number }>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files) {
      if (!file.path.startsWith(pathPrefix)) continue;
      const path = file.path.slice(pathPrefix.length);
      const previous = byPath.get(path);
      const latest = previous === undefined || checkpoint.checkpointTurnCount >= previous.turn;
      byPath.set(path, {
        path,
        repoPath: file.path,
        added: added.has(path),
        additions: (previous?.additions ?? 0) + file.additions,
        deletions: (previous?.deletions ?? 0) + file.deletions,
        runId: latest ? checkpoint.runId : (previous?.runId ?? checkpoint.runId),
        turn: latest ? checkpoint.checkpointTurnCount : (previous?.turn ?? 0),
      });
    }
  }
  return [...byPath.values()]
    .map(({ turn: _turn, ...file }) => file)
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

function isInside(path: string, nodeId: string): boolean {
  return nodeId === "" || path === nodeId || path.startsWith(`${nodeId}/`);
}

export function filesInside(files: ReadonlyArray<TouchedFile>, nodeId: string) {
  return files.filter((file) => isInside(file.path, nodeId));
}

function statusOf(files: ReadonlyArray<TouchedFile>): PartStatus {
  if (files.length === 0) return null;
  return files.every((file) => file.added) ? "new" : "changed";
}

export function layoutMap(
  nodes: ReadonlyArray<CodemapViewNode>,
  files: ReadonlyArray<TouchedFile>,
  size: { readonly w: number; readonly h: number },
): ReadonlyArray<MapBox> {
  const lit = new Set(
    nodes
      .filter((node) => files.some((file) => isInside(file.path, node.id)))
      .map((node) => node.id),
  );
  const childrenOf = new Map<string | null, CodemapViewNode[]>();
  for (const node of nodes) {
    if (node.minor && !lit.has(node.id)) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentId, siblings);
  }
  const weight = (node: CodemapViewNode) => Math.max(node.lines, node.files, 1);
  const sized = (kids: ReadonlyArray<CodemapViewNode>, rest: number) => {
    const total = kids.reduce((sum, kid) => sum + weight(kid), rest);
    return [
      ...kids.map((kid) => ({
        item: kid as CodemapViewNode | null,
        weight: lit.has(kid.id) ? Math.max(weight(kid), total * LIT_SHARE) : weight(kid),
      })),
      { item: null, weight: rest },
    ];
  };

  const build = (node: CodemapViewNode, rect: Rect, nested: boolean): MapBox => {
    const inside = filesInside(files, node.id);
    const inner = {
      x: rect.x + PAD,
      y: rect.y + HEADER,
      w: rect.w - PAD * 2,
      h: rect.h - HEADER - PAD,
    };
    const kids = nested ? [] : (childrenOf.get(node.id) ?? []);
    const rest = Math.max(0, weight(node) - kids.reduce((sum, kid) => sum + weight(kid), 0));
    const children =
      kids.length === 0 || inner.w < MIN_INNER || inner.h < MIN_INNER
        ? []
        : squarify(sized(kids, rest), inner).flatMap(({ item, rect: childRect }) =>
            item === null ? [] : [build(item, childRect, true)],
          );
    return { node, rect, status: statusOf(inside), touched: inside.length, children };
  };

  return squarify(sized(childrenOf.get(null) ?? [], 0), {
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
  }).flatMap(({ item, rect }) => (item === null ? [] : [build(item, rect, false)]));
}
