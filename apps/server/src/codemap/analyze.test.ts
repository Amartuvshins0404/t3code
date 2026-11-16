import { describe, expect, it } from "vite-plus/test";

import { analyzeCodebase, filesToRead } from "./analyze.ts";
import { buildCodemapView } from "./view.ts";

function analyze(files: Record<string, string>) {
  const paths = Object.keys(files);
  const readable = new Set(filesToRead(paths));
  const texts = new Map(Object.entries(files).filter(([path]) => readable.has(path)));
  return analyzeCodebase({ files: paths, texts });
}

function linked(analysis: ReturnType<typeof analyze>, from: string, to: string) {
  return analysis.edges.get(from)?.has(to) ?? false;
}

describe("analyzeCodebase", () => {
  it.each([
    {
      language: "TypeScript, relative and workspace package imports",
      files: {
        "packages/core/package.json": `{"name":"@acme/core"}`,
        "packages/core/src/index.ts": "export const x = 1;",
        "apps/web/package.json": `{"name":"@acme/web"}`,
        "apps/web/src/main.ts": `import { x } from "@acme/core";\nimport "./util.js";`,
        "apps/web/src/util.ts": "export {};",
      },
      edges: [
        ["apps/web/src/main.ts", "packages/core"],
        ["apps/web/src/main.ts", "apps/web/src/util.ts"],
      ],
    },
    {
      language: "Python, relative and absolute imports",
      files: {
        "src/pkg/__init__.py": "",
        "src/pkg/models.py": "from .exceptions import Boom\nimport pkg.utils",
        "src/pkg/exceptions.py": "class Boom(Exception): pass",
        "src/pkg/utils.py": "",
      },
      edges: [
        ["src/pkg/models.py", "src/pkg/exceptions.py"],
        ["src/pkg/models.py", "src/pkg/utils.py"],
      ],
    },
    {
      language: "Go, module imports resolve to package folders",
      files: {
        "go.mod": "module example.com/tool\n\ngo 1.22",
        "cmd/main.go": `package main\n\nimport (\n\t"fmt"\n\t"example.com/tool/internal/store"\n)`,
        "internal/store/store.go": "package store",
      },
      edges: [["cmd/main.go", "internal/store"]],
    },
    {
      language: "Rust, mod declarations and crate paths",
      files: {
        "Cargo.toml": `[package]\nname = "tool"`,
        "src/main.rs": "mod config;\nuse crate::search::run;",
        "src/config.rs": "",
        "src/search.rs": "pub fn run() {}",
      },
      edges: [
        ["src/main.rs", "src/config.rs"],
        ["src/main.rs", "src/search.rs"],
      ],
    },
  ])("links files for $language", ({ files, edges }) => {
    const analysis = analyze(files);
    for (const [from = "", to = ""] of edges)
      expect(linked(analysis, from, to), `${from} -> ${to}`).toBe(true);
  });

  it("names workspace packages from their manifests and ignores vendored code", () => {
    const analysis = analyze({
      "packages/core/package.json": `{"name":"@acme/core"}`,
      "packages/core/index.ts": "",
      "node_modules/left-pad/index.js": "",
      "vendor/lib/a.go": "package lib",
    });
    expect(analysis.nodes.get("packages/core")).toMatchObject({
      kind: "package",
      name: "@acme/core",
    });
    expect(analysis.languages.map((entry) => entry.language)).not.toContain("Go");
    expect(analysis.languages).toContainEqual({ language: "TypeScript", files: 1 });
  });
});

describe("buildCodemapView", () => {
  const analysis = analyze({
    "packages/core/package.json": `{"name":"@acme/core"}`,
    "packages/core/src/index.ts": "export const x = 1;",
    "apps/web/package.json": `{"name":"@acme/web"}`,
    "apps/web/src/main.ts": `import { x } from "@acme/core";`,
    "apps/api/package.json": `{"name":"@acme/api"}`,
    "apps/api/src/server.ts": `import { x } from "@acme/core";`,
  });

  it("rolls file imports up to the boxes shown at the root", () => {
    const view = buildCodemapView(analysis, "");
    expect(
      view.nodes
        .filter((node) => node.parentId === null)
        .map((node) => node.id)
        .toSorted(),
    ).toEqual(["apps", "packages/core"]);
    expect(view.edges).toContainEqual({ source: "apps/web", target: "packages/core", weight: 1 });
    expect(view.edges).toContainEqual({ source: "apps/api", target: "packages/core", weight: 1 });
  });

  it("keeps what a zoomed-in box uses as an outside box named by its package", () => {
    const view = buildCodemapView(analysis, "apps/web");
    const outside = view.nodes.find((node) => node.external);
    expect(outside).toMatchObject({ id: "packages/core", name: "@acme/core" });
    expect(view.edges).toContainEqual({
      source: "apps/web/src/main.ts",
      target: "packages/core",
      weight: 1,
    });
    expect(view.nodes.some((node) => node.id.startsWith("apps/api"))).toBe(false);
  });
});
