import { describe, expect, it } from "vite-plus/test";

import { analyzeCodebase, filesToRead } from "./analyze.ts";
import { buildCodemapView, parseNameStatus } from "./view.ts";

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
