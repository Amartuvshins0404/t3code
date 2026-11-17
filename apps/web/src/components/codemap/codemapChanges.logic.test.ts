import type { CodemapChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupChanges, kindOf, layoutChanges, riskFlags, toItems } from "./codemapChanges.logic";

function change(path: string, additions: number, overrides: Partial<CodemapChange> = {}) {
  return {
    path,
    from: null,
    status: "modified",
    additions,
    deletions: 0,
    areaId: path.split("/")[0] ?? "",
    areaName: path.split("/")[0] ?? "",
    runId: null,
    ...overrides,
  } satisfies CodemapChange;
}

describe("kindOf", () => {
  it.each([
    ["pnpm-lock.yaml", "noise"],
    ["api/drizzle/meta/0003_snapshot.json", "noise"],
    ["web/dist/index.js", "noise"],
    ["api/drizzle/0003_add_supplier.sql", "database"],
    ["api/src/db/schema.ts", "database"],
    ["api/src/routes/suppliers.ts", "api"],
    ["web/src/pages/Suppliers.tsx", "screens"],
    ["web/src/pages/Suppliers.test.tsx", "tests"],
    ["api/package.json", "settings"],
    ["docs/import.md", "docs"],
    ["api/src/services/import.ts", "logic"],
  ])("%s is %s", (path, kind) => {
    expect(kindOf(path)).toBe(kind);
  });
});

describe("change map", () => {
  it("hides generated files until asked and flags database and package changes", () => {
    const items = toItems([
      change("api/src/db/schema.ts", 40),
      change("api/package.json", 2),
      change("pnpm-lock.yaml", 900),
      change("api/src/old.ts", 0, { status: "deleted", deletions: 30 }),
    ]);
    expect(groupChanges(items, "place", false).flatMap((group) => group.items)).toHaveLength(3);
    expect(groupChanges(items, "place", true).at(-1)?.id).toBe("noise");
    expect(riskFlags(items).map((entry) => entry.flag)).toEqual([
      "database",
      "packages",
      "deleted",
      "no_tests",
    ]);
  });

  it("keeps a 400-file change readable: every file is in exactly one box and no file box is too small to read", () => {
    const changes = Array.from({ length: 400 }, (_, index) =>
      change(`area${index % 7}/src/file${index}.ts`, index === 0 ? 2000 : (index % 13) + 1),
    );
    const frames = layoutChanges(groupChanges(toItems(changes), "place", false), {
      w: 480,
      h: 360,
    });
    const tiles = frames.flatMap((frame) => frame.tiles);
    const placed = tiles.flatMap((tile) => (tile.item === null ? tile.rest : [tile.item]));

    expect(new Set(placed.map((item) => item.path)).size).toBe(400);
    expect(placed).toHaveLength(400);
    for (const tile of tiles.filter((entry) => entry.item !== null)) {
      expect(tile.rect.w * tile.rect.h).toBeGreaterThanOrEqual(44 * 30 * 0.99);
    }
    expect(tiles.length).toBeLessThan(80);
  });
});
