import type { CodemapNodeKind } from "@t3tools/contracts";

export interface CodemapAnalysisNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: CodemapNodeKind;
  readonly name: string;
  readonly language: string | null;
  readonly files: number;
  readonly lines: number;
  readonly children: ReadonlyArray<string>;
  readonly vendored: boolean;
}

export interface CodemapAnalysis {
  readonly nodes: ReadonlyMap<string, CodemapAnalysisNode>;
}

export interface AnalyzeInput {
  readonly files: ReadonlyArray<string>;
  readonly lineCounts: ReadonlyMap<string, number>;
  readonly manifests: ReadonlyMap<string, string>;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  cs: "C#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  m: "Objective-C",
  mm: "Objective-C",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  lua: "Lua",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  sql: "SQL",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  html: "HTML",
  md: "Markdown",
  mdx: "Markdown",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  tf: "Terraform",
  zig: "Zig",
  nim: "Nim",
  clj: "Clojure",
  fs: "F#",
  r: "R",
  jl: "Julia",
};

const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "Package.swift",
  "pubspec.yaml",
  "mix.exs",
  "deno.json",
]);

const SKIPPED_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(min\.js|map|png|jpe?g|gif|webp|ico|icns|svg|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|wav|pdf|zip|gz|tgz|jar|wasm|bin|exe|dll|so|dylib|a|o|lockb|snap|DS_Store)$/i;

const VENDORED_SEGMENT =
  /^(node_modules|vendor|vendored|third_party|third-party|\.repos|external|deps|Pods)$/;

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : "";
}

function languageOf(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface MutableNode {
  id: string;
  parentId: string | null;
  kind: CodemapNodeKind;
  name: string;
  language: string | null;
  files: number;
  lines: number;
  children: string[];
  vendored: boolean;
  languageCounts: Map<string, number>;
}

function manifestName(file: string, text: string): string | null {
  const name = basename(file);
  if (name === "package.json" || name === "composer.json" || name === "deno.json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "name" in parsed) {
        const value = (parsed as { name: unknown }).name;
        return typeof value === "string" && value.length > 0 ? value : null;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (name === "go.mod") return /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
  if (name === "Cargo.toml" || name === "pyproject.toml")
    return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null;
  if (name === "pubspec.yaml") return /^name:\s*(\S+)/m.exec(text)?.[1] ?? null;
  if (name === "pom.xml") return /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1] ?? null;
  if (name === "setup.py") return /name\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null;
  if (name === "mix.exs") return /app:\s*:(\w+)/.exec(text)?.[1] ?? null;
  return null;
}

export function countLines(bytes: Uint8Array): number {
  let lines = 1;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) lines++;
  return lines;
}

export function isManifest(file: string): boolean {
  return MANIFESTS.has(basename(file));
}

const isVendored = (path: string) => path.split("/").some((part) => VENDORED_SEGMENT.test(part));

const keptFiles = (files: ReadonlyArray<string>) =>
  files.filter((file) => !SKIPPED_FILE.test(file)).toSorted();

export function filesToRead(files: ReadonlyArray<string>): ReadonlyArray<string> {
  return keptFiles(files).filter(
    (file) => !isVendored(file) && (isManifest(file) || languageOf(file) !== null),
  );
}

export function analyzeCodebase(input: AnalyzeInput): CodemapAnalysis {
  const files = keptFiles(input.files);
  const packageNames = new Map<string, string>();
  for (const [file, text] of input.manifests) {
    const dir = dirname(file);
    if (!packageNames.has(dir))
      packageNames.set(dir, manifestName(file, text) ?? (basename(dir) || "root"));
  }

  const nodes = new Map<string, MutableNode>();
  const ensureDir = (dir: string): MutableNode => {
    const existing = nodes.get(dir);
    if (existing) return existing;
    const parentId = dir === "" ? null : dirname(dir);
    const node: MutableNode = {
      id: dir,
      parentId,
      kind: dir === "" ? "root" : packageNames.has(dir) ? "package" : "folder",
      name: dir === "" ? "" : basename(dir),
      language: null,
      files: 0,
      lines: 0,
      children: [],
      vendored: isVendored(dir),
      languageCounts: new Map(),
    };
    nodes.set(dir, node);
    if (parentId !== null) ensureDir(parentId).children.push(dir);
    return node;
  };
  ensureDir("");
  for (const file of files) {
    const parent = ensureDir(dirname(file));
    nodes.set(file, {
      id: file,
      parentId: parent.id,
      kind: "file",
      name: basename(file),
      language: languageOf(file),
      files: 1,
      lines: input.lineCounts.get(file) ?? 0,
      children: [],
      vendored: parent.vendored,
      languageCounts: new Map(),
    });
    parent.children.push(file);
  }

  const rollUp = (id: string): MutableNode => {
    const node = nodes.get(id) as MutableNode;
    if (node.kind === "file") {
      if (node.language) node.languageCounts.set(node.language, 1);
      return node;
    }
    node.files = 0;
    node.lines = 0;
    for (const childId of node.children) {
      const child = rollUp(childId);
      node.files += child.files;
      node.lines += child.lines;
      for (const [lang, count] of child.languageCounts)
        node.languageCounts.set(lang, (node.languageCounts.get(lang) ?? 0) + count);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [lang, count] of node.languageCounts)
      if (count > bestCount && lang !== "Markdown" && lang !== "JSON" && lang !== "YAML") {
        best = lang;
        bestCount = count;
      }
    node.language = best;
    return node;
  };
  rollUp("");

  const collapse = (id: string) => {
    const node = nodes.get(id) as MutableNode;
    if (node.kind === "file") return;
    for (let i = 0; i < node.children.length; i++) {
      let childId = node.children[i] as string;
      let child = nodes.get(childId) as MutableNode;
      while (child.kind === "folder" && child.children.length === 1) {
        const only = nodes.get(child.children[0] as string) as MutableNode;
        if (only.kind === "file") break;
        nodes.delete(child.id);
        only.name = `${child.name}/${only.name}`;
        only.parentId = node.id;
        child = only;
        childId = only.id;
      }
      node.children[i] = childId;
      collapse(childId);
    }
  };
  collapse("");

  const frozen = new Map<string, CodemapAnalysisNode>();
  for (const [id, node] of nodes)
    frozen.set(id, {
      id,
      parentId: node.parentId,
      kind: node.kind,
      name: node.kind === "package" ? (packageNames.get(id) ?? node.name) : node.name,
      language: node.language,
      files: node.files,
      lines: node.lines,
      children: node.children,
      vendored: node.vendored,
    });
  return { nodes: frozen };
}
