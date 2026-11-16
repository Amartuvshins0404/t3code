import { describe, expect, it } from "vite-plus/test";

import { analyzeCodebase, countLines, filesToRead, isManifest } from "./analyze.ts";
import { buildCodemapView, dirtyPaths, parseNameStatus } from "./view.ts";

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
    const { touched, added } = parseNameStatus("A\0src/tiny/new.ts\0M\0src/big3/main.ts\0", 100);

    expect(added).toEqual(["src/tiny/new.ts"]);
    expect(buildCodemapView(analysis, "").nodes.map((node) => node.id)).not.toContain("src/tiny");
    expect(buildCodemapView(analysis, "", touched).nodes.map((node) => node.id)).toContain(
      "src/tiny",
    );
  });
});
