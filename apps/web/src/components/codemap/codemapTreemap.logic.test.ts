import { CheckpointRef, type CodemapViewNode, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TurnDiffSummary } from "~/types";
import { layoutMap, touchedFiles } from "./codemapTreemap.logic";

function checkpoint(turn: number, files: Array<[string, number, number]>): TurnDiffSummary {
  return {
    runId: RunId.make(`run-${turn}`),
    checkpointTurnCount: turn,
    checkpointRef: CheckpointRef.make(`refs/t3/${turn}`),
    status: "ready",
    files: files.map(([path, additions, deletions]) => ({
      path,
      kind: "modified",
      additions,
      deletions,
    })),
    assistantMessageId: null,
    completedAt: "2026-11-16T00:00:00.000Z",
  };
}

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

describe("touchedFiles", () => {
  it("marks thread-added files new, sums turns, and points at the latest turn", () => {
    const files = touchedFiles(
      [checkpoint(1, [["src/a.ts", 3, 1]]), checkpoint(2, [["src/a.ts", 2, 0], ["src/b.ts", 4, 0]])],
      ["src/b.ts"],
    );
    expect(files).toEqual([
      { path: "src/a.ts", added: false, additions: 5, deletions: 1, runId: "run-2" },
      { path: "src/b.ts", added: true, additions: 4, deletions: 0, runId: "run-2" },
    ]);
  });
});

describe("layoutMap", () => {
  it("lights the touched box and keeps a tiny touched box big enough to see", () => {
    const nodes = [folder("big", null, 100_000), folder("tiny", null, 5)];
    const files = touchedFiles([checkpoint(1, [["tiny/x.ts", 5, 0]])], ["tiny/x.ts"]);
    const boxes = layoutMap(nodes, files, { w: 400, h: 300 });
    const tiny = boxes.find((box) => box.node.id === "tiny");
    expect(tiny?.status).toBe("new");
    expect(boxes.find((box) => box.node.id === "big")?.status).toBeNull();
    expect((tiny?.rect.w ?? 0) * (tiny?.rect.h ?? 0)).toBeGreaterThan(400 * 300 * 0.04);
  });
});
