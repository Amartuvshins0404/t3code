import type { CodemapViewNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutMap } from "./codemapTreemap.logic";

function folder(id: string, parentId: string | null, lines: number): CodemapViewNode {
  return {
    id,
    parentId,
    kind: "folder",
    name: id,
    language: null,
    files: 1,
    lines,
    childCount: 0,
    vendored: false,
    minor: false,
  };
}

describe("layoutMap", () => {
  it("lights the touched box and keeps a tiny touched box big enough to see", () => {
    const nodes = [folder("big", null, 100_000), folder("tiny", null, 5)];
    const boxes = layoutMap(nodes, [{ path: "tiny/x.ts", added: true }], { w: 400, h: 300 });
    const tiny = boxes.find((box) => box.node.id === "tiny");
    expect(tiny?.status).toBe("new");
    expect(boxes.find((box) => box.node.id === "big")?.status).toBeNull();
    expect((tiny?.rect.w ?? 0) * (tiny?.rect.h ?? 0)).toBeGreaterThan(400 * 300 * 0.04);
  });
});
