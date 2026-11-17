import type { CodemapChange } from "@t3tools/contracts";

import { type Rect, squarify } from "./codemapTreemap.logic";

export type ChangeKind =
  | "screens"
  | "api"
  | "database"
  | "logic"
  | "tests"
  | "styles"
  | "settings"
  | "docs"
  | "assets"
  | "noise";

const KIND_LABEL: Record<ChangeKind, string> = {
  screens: "Screens",
  api: "API",
  database: "Database",
  logic: "Logic",
  tests: "Tests",
  styles: "Styles",
  settings: "Settings",
  docs: "Docs",
  assets: "Images and files",
  noise: "Generated and lock files",
};

const NOISE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock|uv\.lock)$|(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.output|node_modules|__generated__|generated|__snapshots__)\/|(^|\/)meta\/[^/]*snapshot[^/]*\.json$|(^|\/)meta\/_journal\.json$|\.(min\.(js|css)|map|snap|lockb)$|\.(gen|generated|pb)\.[a-z]+$|routeTree\.gen\.ts$/i;
const TESTS =
  /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec|e2e)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const DATABASE =
  /(^|\/)(migrations?|drizzle|prisma|db|database|schema)(\/|\.)|\.(sql|prisma)$|(^|\/)[^/]*(schema|model|entity)s?\.[a-z]+$/i;
const API =
  /\/(api|routes?|router|controllers?|handlers?|resolvers?|endpoints?|graphql|trpc)(\/|\.)|\.(graphql|gql|proto)$/i;
const SCREENS =
  /\/(components?|pages?|screens?|views?|ui|app|layouts?|widgets?)\/|\.(tsx|jsx|vue|svelte|astro|html)$/i;
const STYLES = /\.(css|scss|sass|less|styl)$/i;
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const ASSETS = /\.(png|jpe?g|gif|webp|svg|ico|icns|woff2?|ttf|otf|mp3|mp4|mov|webm|wav|pdf|zip)$/i;
const SETTINGS =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|Dockerfile|docker-compose[^/]*|Makefile|\.env[^/]*|\.gitignore|\.gitattributes)$|(^|\/)\.github\/|(^|\/)[^/]*\.config\.[a-z]+$|\.(ya?ml|toml|ini)$|(^|\/)[^/]+rc(\.[a-z]+)?$/i;

export function kindOf(path: string): ChangeKind {
  if (NOISE.test(path)) return "noise";
  if (TESTS.test(path)) return "tests";
  if (ASSETS.test(path)) return "assets";
  if (DOCS.test(path)) return "docs";
  if (STYLES.test(path)) return "styles";
  if (SETTINGS.test(path)) return "settings";
  if (DATABASE.test(path)) return "database";
  if (API.test(path)) return "api";
  if (SCREENS.test(path)) return "screens";
  return "logic";
}

export interface ChangeItem extends CodemapChange {
  readonly kind: ChangeKind;
  readonly weight: number;
}

export interface ChangeGroup {
  readonly id: string;
  readonly name: string;
  readonly items: ReadonlyArray<ChangeItem>;
  readonly additions: number;
  readonly deletions: number;
  readonly summary: string;
}

export type GroupBy = "place" | "kind";

export function toItems(changes: ReadonlyArray<CodemapChange>): ReadonlyArray<ChangeItem> {
  return changes.map((change) => ({
    ...change,
    kind: kindOf(change.path),
    weight: Math.max(1, change.additions + change.deletions),
  }));
}

function plural(count: number, word: string) {
  return `${count} ${word}`;
}

function topKinds(items: ReadonlyArray<ChangeItem>): string {
  const totals = new Map<ChangeKind, number>();
  for (const item of items) totals.set(item.kind, (totals.get(item.kind) ?? 0) + item.weight);
  return [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([kind]) => KIND_LABEL[kind].toLowerCase())
    .join(" and ");
}

function topPlaces(items: ReadonlyArray<ChangeItem>): string {
  const totals = new Map<string, number>();
  for (const item of items)
    totals.set(
      item.areaName || "top level",
      (totals.get(item.areaName || "top level") ?? 0) + item.weight,
    );
  const names = [...totals.entries()].toSorted((a, b) => b[1] - a[1]).map(([name]) => name);
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
    : names.join(" and ");
}

function summarize(items: ReadonlyArray<ChangeItem>, by: GroupBy): string {
  const count = (status: CodemapChange["status"]) =>
    items.filter((item) => item.status === status).length;
  const parts = [
    count("added") > 0 ? plural(count("added"), "new") : null,
    count("modified") > 0 ? plural(count("modified"), "changed") : null,
    count("renamed") > 0 ? plural(count("renamed"), "moved") : null,
    count("deleted") > 0 ? plural(count("deleted"), "deleted") : null,
  ].filter((part) => part !== null);
  const where = by === "place" ? `mostly ${topKinds(items)}` : `in ${topPlaces(items)}`;
  return `${parts.join(", ")} · ${where}`;
}

export function groupChanges(
  items: ReadonlyArray<ChangeItem>,
  by: GroupBy,
  showNoise: boolean,
): ReadonlyArray<ChangeGroup> {
  const buckets = new Map<string, { name: string; items: ChangeItem[] }>();
  for (const item of items) {
    if (item.kind === "noise" && !showNoise) continue;
    const id =
      item.kind === "noise" ? "noise" : by === "place" ? `place:${item.areaId}` : item.kind;
    const name =
      item.kind === "noise" || by === "kind" ? KIND_LABEL[item.kind] : item.areaName || "Top level";
    const bucket = buckets.get(id) ?? { name, items: [] };
    bucket.items.push(item);
    buckets.set(id, bucket);
  }
  const churn = (items: ReadonlyArray<ChangeItem>) =>
    items.reduce((sum, item) => sum + item.weight, 0);
  const ranked = [...buckets.entries()]
    .filter(([id]) => id !== "noise")
    .toSorted((a, b) => churn(b[1].items) - churn(a[1].items));
  const kept = ranked.slice(0, MAX_GROUPS);
  const others = ranked.slice(MAX_GROUPS).flatMap(([, bucket]) => bucket.items);
  const noise = buckets.get("noise");
  return [
    ...kept,
    ...(others.length > 0
      ? [
          [
            "other",
            { name: by === "place" ? "Other places" : "Everything else", items: others },
          ] as const,
        ]
      : []),
    ...(noise ? [["noise", noise] as const] : []),
  ].map(([id, bucket]) => {
    const sorted = bucket.items.toSorted((a, b) => b.weight - a.weight);
    return {
      id,
      name: bucket.name,
      items: sorted,
      additions: sorted.reduce((sum, item) => sum + item.additions, 0),
      deletions: sorted.reduce((sum, item) => sum + item.deletions, 0),
      summary: summarize(sorted, id === "other" && by === "place" ? "kind" : by),
    };
  });
}

const MAX_GROUPS = 8;

export function statusShares(
  items: ReadonlyArray<ChangeItem>,
): ReadonlyArray<{ readonly status: CodemapChange["status"]; readonly share: number }> {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  return (["added", "modified", "renamed", "deleted"] as const)
    .map((status) => ({
      status,
      share:
        total === 0
          ? 0
          : items
              .filter((item) => item.status === status)
              .reduce((sum, item) => sum + item.weight, 0) / total,
    }))
    .filter((entry) => entry.share > 0);
}

export type RiskFlag = "database" | "packages" | "deleted" | "no_tests" | "env_or_ci";

const PACKAGES =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile)$/;
const ENV_OR_CI = /(^|\/)(\.env[^/]*|\.github\/workflows\/[^/]+|Dockerfile[^/]*)$/;

export function riskFlags(items: ReadonlyArray<ChangeItem>): ReadonlyArray<{
  readonly flag: RiskFlag;
  readonly count: number;
}> {
  const count = (test: (item: ChangeItem) => boolean) => items.filter(test).length;
  const code = items.filter((item) => ["screens", "api", "database", "logic"].includes(item.kind));
  const codeLines = code.reduce((sum, item) => sum + item.additions + item.deletions, 0);
  const flags = [
    { flag: "database" as const, count: count((item) => item.kind === "database") },
    { flag: "packages" as const, count: count((item) => PACKAGES.test(item.path)) },
    { flag: "deleted" as const, count: count((item) => item.status === "deleted") },
    { flag: "env_or_ci" as const, count: count((item) => ENV_OR_CI.test(item.path)) },
    {
      flag: "no_tests" as const,
      count: codeLines >= 50 && count((item) => item.kind === "tests") === 0 ? 1 : 0,
    },
  ];
  return flags.filter((entry) => entry.count > 0);
}

export interface ChangeTile {
  readonly key: string;
  readonly rect: Rect;
  readonly item: ChangeItem | null;
  readonly rest: ReadonlyArray<ChangeItem>;
}

export interface GroupFrame {
  readonly group: ChangeGroup;
  readonly rect: Rect;
  readonly tiles: ReadonlyArray<ChangeTile>;
}

const HEADER = 18;
const PAD = 2;
const MIN_TILE_AREA = 44 * 30;
const MIN_GROUP_SHARE = 0.04;

function tilesFor(group: ChangeGroup, inner: Rect): ChangeTile[] {
  if (inner.w <= 4 || inner.h <= 4) {
    return [{ key: `${group.id}:rest`, rect: inner, item: null, rest: group.items }];
  }
  const area = inner.w * inner.h;
  const total = group.items.reduce((sum, item) => sum + item.weight, 0);
  let shown = group.items.length;
  while (shown > 0) {
    const restWeight = group.items.slice(shown).reduce((sum, item) => sum + item.weight, 0);
    const restSlot = shown < group.items.length ? Math.max(restWeight, total * 0.08) : 0;
    const scale = area / (total - restWeight + restSlot);
    const smallest = group.items[shown - 1]!.weight * scale;
    if (smallest >= MIN_TILE_AREA) break;
    shown -= 1;
  }
  const kept = group.items.slice(0, shown);
  const rest = group.items.slice(shown);
  const restWeight = rest.reduce((sum, item) => sum + item.weight, 0);
  const entries: Array<{ item: ChangeItem | null; weight: number }> = kept.map((item) => ({
    item,
    weight: item.weight,
  }));
  if (rest.length > 0) entries.push({ item: null, weight: Math.max(restWeight, total * 0.08) });
  return squarify(entries, inner).map(({ item, rect }) => ({
    key: item === null ? `${group.id}:rest` : `${group.id}:${item.path}`,
    rect,
    item,
    rest: item === null ? rest : [],
  }));
}

export function layoutChanges(
  groups: ReadonlyArray<ChangeGroup>,
  size: { readonly w: number; readonly h: number },
): ReadonlyArray<GroupFrame> {
  const weightOf = (group: ChangeGroup) => group.items.reduce((sum, item) => sum + item.weight, 0);
  const total = groups.reduce((sum, group) => sum + weightOf(group), 0);
  return squarify(
    groups.map((group) => ({
      item: group,
      weight: Math.max(weightOf(group), total * MIN_GROUP_SHARE),
    })),
    { x: 0, y: 0, w: size.w, h: size.h },
  ).map(({ item: group, rect }) => {
    const inner = {
      x: rect.x + PAD,
      y: rect.y + HEADER,
      w: rect.w - PAD * 2,
      h: rect.h - HEADER - PAD,
    };
    return { group, rect, tiles: tilesFor(group, inner) };
  });
}
