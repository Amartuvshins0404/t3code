import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { analyzeCodebase, countLines, filesToRead, isManifest } from "./analyze.ts";
import { authoredChanges, buildCodemapView, dirtyPaths, parseRawNumstat } from "./view.ts";

function analyze(files: Record<string, string>) {
  const paths = Object.keys(files);
  const lineCounts = new Map<string, number>();
  const manifests = new Map<string, string>();
  for (const file of filesToRead(paths)) {
    const text = files[file] ?? "";
    lineCounts.set(file, countLines(new TextEncoder().encode(text)));
    if (isManifest(file)) manifests.set(file, text);
  }
  return analyzeCodebase({ files: paths, lineCounts, manifests });
}

describe("analyzeCodebase", () => {
  it("names packages from their manifests, sizes folders by lines and marks vendored code", () => {
    const analysis = analyze({
      "packages/core/package.json": `{"name":"@acme/core"}`,
      "packages/core/src/index.ts": "a\nb\nc",
      "packages/core/src/util.ts": "a",
      "vendor/lib/a.go": "package lib",
    });
    expect(analysis.nodes.get("packages/core")).toMatchObject({
      kind: "package",
      name: "@acme/core",
    });
    expect(analysis.nodes.get("packages/core/src")).toMatchObject({ files: 2, lines: 4 });
    expect(analysis.nodes.get("vendor/lib")?.vendored).toBe(true);
  });
});

describe("dirtyPaths", () => {
  it("reads modified, untracked and renamed paths from git status -z", () => {
    expect(dirtyPaths(" M src/a.ts\0?? new.ts\0R  src/b.ts\0src/old-b.ts\0")).toEqual([
      "src/a.ts",
      "new.ts",
      "src/b.ts",
    ]);
  });
});

describe("buildCodemapView", () => {
  it("keeps a small touched folder that the size limit would cut", () => {
    const files: Record<string, string> = { "src/tiny/new.ts": "export {};" };
    for (let index = 0; index < 20; index += 1) {
      files[`src/big${index}/main.ts`] = "const x = 1;\n".repeat(100 + index);
    }
    const analysis = analyze(files);
    const touched = ["src/tiny/new.ts", "src/big3/main.ts"];

    expect(buildCodemapView(analysis, "").nodes.map((node) => node.id)).not.toContain("src/tiny");
    expect(buildCodemapView(analysis, "", touched).nodes.map((node) => node.id)).toContain(
      "src/tiny",
    );
  });
});

describe("thread changes", () => {
  const gitOutput = [
    ":100644 100644 975fbec 2795c87 M",
    "app/api/src/edit.ts",
    ":100644 000000 587be6b 0000000 D",
    "app/api/src/gone.ts",
    ":100644 100644 71ac1b5 b236ae5 R088",
    "app/api/src/old.ts",
    "app/api/src/moved.ts",
    ":000000 100644 0000000 8ba3a16 A",
    "app/api/src/new.ts",
    ":000000 100644 0000000 8ba3a16 A",
    "app/api/src/pulled.ts",
    "1\t0\tapp/api/src/edit.ts",
    "0\t1\tapp/api/src/gone.ts",
    "1\t0\t",
    "app/api/src/old.ts",
    "app/api/src/moved.ts",
    "1\t0\tapp/api/src/new.ts",
    "40\t0\tapp/api/src/pulled.ts",
    "",
  ].join("\0");

  it("tells new, changed, moved and deleted apart, drops files the thread did not write, and groups by package", () => {
    const analysis = analyze({
      "api/package.json": `{"name":"@acme/api"}`,
      "api/src/edit.ts": "a",
      "api/src/moved.ts": "a",
      "api/src/new.ts": "a",
      "api/src/pulled.ts": "a",
      "web/src/x.ts": "a",
    });
    const runByPath = new Map([
      ["app/api/src/edit.ts", RunId.make("run-1")],
      ["app/api/src/gone.ts", RunId.make("run-1")],
      ["app/api/src/moved.ts", RunId.make("run-2")],
      ["app/api/src/new.ts", RunId.make("run-2")],
    ]);
    const changes = authoredChanges({
      raw: parseRawNumstat(gitOutput, 100),
      runByPath,
      prefix: "app/",
      analysis,
      limit: 100,
    });

    expect(
      changes.map(({ path, from, status, additions, deletions, areaName, runId }) => [
        path,
        from,
        status,
        additions,
        deletions,
        areaName,
        runId,
      ]),
    ).toEqual([
      ["api/src/edit.ts", null, "modified", 1, 0, "@acme/api", "run-1"],
      ["api/src/gone.ts", null, "deleted", 0, 1, "@acme/api", "run-1"],
      ["api/src/moved.ts", "api/src/old.ts", "renamed", 1, 0, "@acme/api", "run-2"],
      ["api/src/new.ts", null, "added", 1, 0, "@acme/api", "run-2"],
    ]);
  });
});
