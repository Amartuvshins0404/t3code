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
  readonly edges: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly languages: ReadonlyArray<{ readonly language: string; readonly files: number }>;
}

export interface AnalyzeInput {
  readonly files: ReadonlyArray<string>;
  readonly texts: ReadonlyMap<string, string>;
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

const PARSED_LANGUAGES = new Set([
  "TypeScript",
  "JavaScript",
  "Vue",
  "Svelte",
  "Python",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "Scala",
  "C#",
  "C",
  "C++",
  "Objective-C",
  "Ruby",
  "PHP",
  "Dart",
  "Swift",
  "CSS",
]);

const MAX_PARSED_BYTES = 400_000;

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

function stripExtension(path: string): string {
  const ext = extensionOf(path);
  return ext === "" ? path : path.slice(0, -(ext.length + 1));
}

function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function join(base: string, rel: string): string | null {
  return normalizePath(base === "" ? rel : `${base}/${rel}`);
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

interface PackageInfo {
  readonly dir: string;
  readonly name: string;
  readonly manifest: string;
  readonly goModule?: string | undefined;
}

class Resolver {
  readonly fileSet: Set<string>;
  readonly bySuffix = new Map<string, string[]>();
  readonly packagesByName = new Map<string, PackageInfo>();
  readonly packageDirs: string[];
  readonly goModules: PackageInfo[];
  readonly csharpNamespaces = new Map<string, Set<string>>();

  constructor(files: ReadonlyArray<string>, packages: ReadonlyArray<PackageInfo>) {
    this.fileSet = new Set(files);
    for (const file of files) {
      const parts = stripExtension(file).split("/");
      for (let i = parts.length - 1; i >= 0; i--) {
        const key = parts.slice(i).join("/");
        const list = this.bySuffix.get(key);
        if (list) list.push(file);
        else this.bySuffix.set(key, [file]);
      }
    }
    for (const pkg of packages) {
      this.packagesByName.set(pkg.name, pkg);
      this.packagesByName.set(pkg.name.replace(/-/g, "_"), pkg);
    }
    this.packageDirs = packages.map((p) => p.dir).toSorted((a, b) => b.length - a.length);
    this.goModules = packages
      .filter((p) => p.goModule !== undefined)
      .toSorted((a, b) => (b.goModule ?? "").length - (a.goModule ?? "").length);
  }

  packageDirOf(file: string): string {
    return this.packageDirs.find((dir) => dir === "" || file.startsWith(`${dir}/`)) ?? "";
  }

  firstExisting(candidates: ReadonlyArray<string>): string | null {
    for (const candidate of candidates) if (this.fileSet.has(candidate)) return candidate;
    return null;
  }

  bySuffixNear(key: string, from: string, extensions: ReadonlySet<string>): string | null {
    const list = this.bySuffix.get(key);
    if (!list) return null;
    const matches = list.filter(
      (file) =>
        extensions.has(extensionOf(file)) &&
        (stripExtension(file) === key || stripExtension(file).endsWith(`/${key}`)),
    );
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0] ?? null;
    let best: string | null = null;
    let bestScore = -1;
    for (const match of matches) {
      let shared = 0;
      while (shared < match.length && shared < from.length && match[shared] === from[shared])
        shared++;
      if (shared > bestScore) {
        bestScore = shared;
        best = match;
      }
    }
    return best;
  }
}

const JS_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "d.ts",
];

function resolveJsPath(resolver: Resolver, base: string): string | null {
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  const candidates = [base];
  for (const ext of JS_EXTENSIONS) candidates.push(`${stripped}.${ext}`);
  for (const ext of JS_EXTENSIONS) candidates.push(`${base}/index.${ext}`);
  return resolver.firstExisting(candidates);
}

function resolveJs(resolver: Resolver, from: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const target = join(dirname(from), spec);
    return target === null ? null : resolveJsPath(resolver, target);
  }
  if (spec.startsWith("~/") || spec.startsWith("@/") || spec.startsWith("#/")) {
    const pkgDir = resolver.packageDirOf(from);
    for (const root of ["src", "app", ""]) {
      const base = join(pkgDir, root === "" ? spec.slice(2) : `${root}/${spec.slice(2)}`);
      const hit = base === null ? null : resolveJsPath(resolver, base);
      if (hit) return hit;
    }
    return null;
  }
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const pkg = resolver.packagesByName.get(pkgName);
  if (!pkg) return null;
  const sub = spec.slice(pkgName.length + 1);
  if (sub !== "") {
    for (const root of ["src", "lib", ""]) {
      const base = join(pkg.dir, root === "" ? sub : `${root}/${sub}`);
      const hit = base === null ? null : resolveJsPath(resolver, base);
      if (hit) return hit;
    }
  }
  return pkg.dir === "" ? null : pkg.dir;
}

const JS_IMPORT =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=,])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const PY_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const PY_EXT = new Set(["py"]);

function resolvePython(
  resolver: Resolver,
  from: string,
  dots: string,
  module: string,
): string | null {
  const modulePath = module.replace(/\./g, "/");
  if (dots.length > 0) {
    let base = dirname(from);
    for (let i = 1; i < dots.length; i++) base = dirname(base);
    const target = modulePath === "" ? base : join(base, modulePath);
    if (target === null) return null;
    return resolver.firstExisting([`${target}.py`, `${target}/__init__.py`]);
  }
  if (modulePath === "") return null;
  return (
    resolver.bySuffixNear(modulePath, from, PY_EXT) ??
    resolver.bySuffixNear(`${modulePath}/__init__`, from, PY_EXT)
  );
}

const GO_IMPORT_BLOCK = /\bimport\s*\(([^)]*)\)/g;
const GO_IMPORT_SINGLE = /\bimport\s+(?:\w+\s+)?"([^"]+)"/g;
const GO_QUOTED = /"([^"]+)"/g;

function resolveGo(resolver: Resolver, spec: string): string | null {
  for (const pkg of resolver.goModules) {
    const mod = pkg.goModule ?? "";
    if (spec === mod) return pkg.dir;
    if (spec.startsWith(`${mod}/`)) {
      const dir = join(pkg.dir, spec.slice(mod.length + 1));
      return dir;
    }
  }
  return null;
}

const RUST_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;
const RUST_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm;

function resolveRust(resolver: Resolver, from: string, path: string): string | null {
  const parts = path.split("::").filter((p) => p !== "" && p !== "self");
  if (parts.length === 0) return null;
  const pkgDir = resolver.packageDirOf(from);
  let base: string | null;
  let rest: string[];
  if (parts[0] === "crate") {
    base = join(pkgDir, "src");
    rest = parts.slice(1);
  } else if (parts[0] === "super") {
    base = dirname(dirname(from));
    rest = parts.slice(1);
  } else {
    const pkg = resolver.packagesByName.get(parts[0] ?? "");
    if (!pkg) return null;
    base = join(pkg.dir, "src");
    rest = parts.slice(1);
  }
  if (base === null) return null;
  for (let n = rest.length; n > 0; n--) {
    const target = join(base, rest.slice(0, n).join("/"));
    if (target === null) continue;
    const hit = resolver.firstExisting([`${target}.rs`, `${target}/mod.rs`]);
    if (hit) return hit;
  }
  return resolver.firstExisting([`${base}/lib.rs`, `${base}/main.rs`]);
}

const JVM_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/gm;
const JVM_EXT = new Set(["java", "kt", "kts", "scala"]);

const CS_USING = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm;
const CS_NAMESPACE = /^\s*namespace\s+([\w.]+)/gm;

const C_INCLUDE = /^\s*#\s*(?:include|import)\s*"([^"]+)"/gm;
const C_EXT = new Set(["h", "hpp", "hh", "c", "cc", "cpp", "cxx", "m", "mm"]);

const RUBY_REQUIRE = /^\s*(require_relative|require)\s*\(?\s*['"]([^'"]+)['"]/gm;
const RB_EXT = new Set(["rb"]);

const PHP_USE = /^\s*use\s+([\w\\]+)/gm;
const PHP_INCLUDE = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g;
const PHP_EXT = new Set(["php"]);

const DART_IMPORT = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm;

const CSS_IMPORT = /@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g;

function extractTargets(
  resolver: Resolver,
  file: string,
  language: string,
  text: string,
): string[] {
  const out: string[] = [];
  const push = (target: string | null) => {
    if (target !== null && target !== file) out.push(target);
  };
  switch (language) {
    case "TypeScript":
    case "JavaScript":
    case "Vue":
    case "Svelte":
      for (const m of text.matchAll(JS_IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec) push(resolveJs(resolver, file, spec));
      }
      break;
    case "Python":
      for (const m of text.matchAll(PY_FROM)) {
        const dots = m[1] ?? "";
        const module = m[2] ?? "";
        if (dots.length > 0 && module === "") {
          for (const name of (m[3] ?? "").replace(/[()]/g, "").split(",")) {
            const clean = name.trim().split(/\s+/)[0];
            if (clean) push(resolvePython(resolver, file, dots, clean));
          }
        } else push(resolvePython(resolver, file, dots, module));
      }
      for (const m of text.matchAll(PY_IMPORT))
        for (const name of (m[1] ?? "").split(","))
          push(resolvePython(resolver, file, "", name.trim()));
      break;
    case "Go": {
      const specs: string[] = [];
      for (const m of text.matchAll(GO_IMPORT_BLOCK))
        for (const q of (m[1] ?? "").matchAll(GO_QUOTED)) if (q[1]) specs.push(q[1]);
      for (const m of text.matchAll(GO_IMPORT_SINGLE)) if (m[1]) specs.push(m[1]);
      for (const spec of specs) push(resolveGo(resolver, spec));
      break;
    }
    case "Rust":
      for (const m of text.matchAll(RUST_MOD)) {
        const name = m[1] ?? "";
        const dir =
          basename(file) === "mod.rs" || basename(file) === "lib.rs" || basename(file) === "main.rs"
            ? dirname(file)
            : stripExtension(file);
        push(resolver.firstExisting([`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`]));
      }
      for (const m of text.matchAll(RUST_USE)) if (m[1]) push(resolveRust(resolver, file, m[1]));
      break;
    case "Java":
    case "Kotlin":
    case "Scala":
      for (const m of text.matchAll(JVM_IMPORT)) {
        const parts = (m[1] ?? "").split(".");
        for (let n = parts.length; n >= 2; n--) {
          const hit = resolver.bySuffixNear(parts.slice(0, n).join("/"), file, JVM_EXT);
          if (hit) {
            push(hit);
            break;
          }
        }
      }
      break;
    case "C#":
      for (const m of text.matchAll(CS_USING)) {
        const dirs = resolver.csharpNamespaces.get(m[1] ?? "");
        if (dirs) for (const dir of dirs) push(dir);
      }
      break;
    case "C":
    case "C++":
    case "Objective-C":
      for (const m of text.matchAll(C_INCLUDE)) {
        const spec = m[1] ?? "";
        const rel = join(dirname(file), spec);
        push(
          (rel !== null && resolver.fileSet.has(rel) ? rel : null) ??
            resolver.bySuffixNear(stripExtension(spec), file, C_EXT),
        );
      }
      break;
    case "Ruby":
      for (const m of text.matchAll(RUBY_REQUIRE)) {
        const spec = (m[2] ?? "").replace(/\.rb$/, "");
        if (m[1] === "require_relative") {
          const rel = join(dirname(file), spec);
          push(rel === null ? null : resolver.firstExisting([`${rel}.rb`]));
        } else push(resolver.bySuffixNear(spec, file, RB_EXT));
      }
      break;
    case "PHP":
      for (const m of text.matchAll(PHP_USE)) {
        const parts = (m[1] ?? "").split("\\").filter(Boolean);
        for (let n = parts.length; n >= Math.max(1, parts.length - 2); n--) {
          const hit = resolver.bySuffixNear(parts.slice(-n).join("/"), file, PHP_EXT);
          if (hit) {
            push(hit);
            break;
          }
        }
      }
      for (const m of text.matchAll(PHP_INCLUDE)) {
        const rel = join(dirname(file), (m[1] ?? "").replace(/^\//, ""));
        push(rel !== null && resolver.fileSet.has(rel) ? rel : null);
      }
      break;
    case "Dart":
      for (const m of text.matchAll(DART_IMPORT)) {
        const spec = m[1] ?? "";
        if (spec.startsWith("dart:")) continue;
        if (spec.startsWith("package:")) {
          const [name, ...rest] = spec.slice(8).split("/");
          const pkg = resolver.packagesByName.get(name ?? "");
          if (pkg) push(resolver.firstExisting([join(pkg.dir, `lib/${rest.join("/")}`) ?? ""]));
        } else {
          const rel = join(dirname(file), spec);
          push(rel !== null && resolver.fileSet.has(rel) ? rel : null);
        }
      }
      break;
    case "CSS":
      for (const m of text.matchAll(CSS_IMPORT)) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".")) continue;
        const rel = join(dirname(file), spec);
        if (rel === null) continue;
        push(
          resolver.firstExisting([
            rel,
            `${rel}.css`,
            `${rel}.scss`,
            `${dirname(rel)}/_${basename(rel)}.scss`,
          ]),
        );
      }
      break;
  }
  return out;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

const isVendored = (path: string) => path.split("/").some((part) => VENDORED_SEGMENT.test(part));

const keptFiles = (files: ReadonlyArray<string>) =>
  files.filter((file) => !SKIPPED_FILE.test(file)).toSorted();

export function filesToRead(files: ReadonlyArray<string>): ReadonlyArray<string> {
  return keptFiles(files).filter(
    (file) => !isVendored(file) && (MANIFESTS.has(basename(file)) || languageOf(file) !== null),
  );
}

export function analyzeCodebase(input: AnalyzeInput): CodemapAnalysis {
  const files = keptFiles(input.files);
  const texts = new Map<string, string>();
  const lineCounts = new Map<string, number>();
  const packages: PackageInfo[] = [];

  for (const [file, text] of input.texts) {
    lineCounts.set(file, countLines(text));
    if (MANIFESTS.has(basename(file))) {
      const name = manifestName(file, text);
      const dir = dirname(file);
      const goModule = basename(file) === "go.mod" ? (name ?? undefined) : undefined;
      const index = packages.findIndex((p) => p.dir === dir);
      const existing = packages[index];
      if (!existing)
        packages.push({ dir, name: name ?? (basename(dir) || "root"), manifest: file, goModule });
      else if (goModule !== undefined) packages[index] = { ...existing, goModule };
      continue;
    }
    const language = languageOf(file);
    if (language !== null && PARSED_LANGUAGES.has(language) && text.length <= MAX_PARSED_BYTES)
      texts.set(file, text);
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));

  const resolver = new Resolver(files, packages);
  for (const [file, text] of texts) {
    if (languageOf(file) !== "C#") continue;
    for (const m of text.matchAll(CS_NAMESPACE)) {
      const ns = m[1] ?? "";
      const set = resolver.csharpNamespaces.get(ns) ?? new Set<string>();
      set.add(dirname(file));
      resolver.csharpNamespaces.set(ns, set);
    }
  }

  const nodes = new Map<string, MutableNode>();
  const packageDirs = new Map(packages.map((p) => [p.dir, p]));
  const ensureDir = (dir: string): MutableNode => {
    const existing = nodes.get(dir);
    if (existing) return existing;
    const parentId = dir === "" ? null : dirname(dir);
    const pkg = packageDirs.get(dir);
    const node: MutableNode = {
      id: dir,
      parentId,
      kind: dir === "" ? "root" : pkg ? "package" : "folder",
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
    const language = languageOf(file);
    nodes.set(file, {
      id: file,
      parentId: parent.id,
      kind: "file",
      name: basename(file),
      language,
      files: 1,
      lines: lineCounts.get(file) ?? 0,
      children: [],
      vendored: parent.vendored,
      languageCounts: new Map(),
    });
    parent.children.push(file);
  }

  const languageTotals = new Map<string, number>();
  const rollUp = (id: string): MutableNode => {
    const node = nodes.get(id) as MutableNode;
    if (node.kind === "file") {
      if (node.language) {
        node.languageCounts.set(node.language, 1);
        if (!node.vendored)
          languageTotals.set(node.language, (languageTotals.get(node.language) ?? 0) + 1);
      }
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
    node.children.sort((a, b) => {
      const na = nodes.get(a) as MutableNode;
      const nb = nodes.get(b) as MutableNode;
      const fa = na.kind === "file" ? 1 : 0;
      const fb = nb.kind === "file" ? 1 : 0;
      return fa - fb || na.name.localeCompare(nb.name);
    });
  };
  collapse("");

  const edges = new Map<string, Map<string, number>>();
  for (const [file, text] of texts) {
    const language = languageOf(file);
    if (language === null) continue;
    for (const target of extractTargets(resolver, file, language, text)) {
      const resolved = nodes.has(target) ? target : nearestNode(nodes, target);
      if (resolved === null || resolved === file) continue;
      const map = edges.get(file) ?? new Map<string, number>();
      map.set(resolved, (map.get(resolved) ?? 0) + 1);
      edges.set(file, map);
    }
  }

  const frozen = new Map<string, CodemapAnalysisNode>();
  for (const [id, node] of nodes)
    frozen.set(id, {
      id,
      parentId: node.parentId,
      kind: node.kind,
      name: node.kind === "package" ? (packageDirs.get(id)?.name ?? node.name) : node.name,
      language: node.language,
      files: node.files,
      lines: node.lines,
      children: node.children,
      vendored: node.vendored,
    });

  return {
    nodes: frozen,
    edges,
    languages: [...languageTotals]
      .map(([language, count]) => ({ language, files: count }))
      .toSorted((a, b) => b.files - a.files),
  };
}

function nearestNode(nodes: ReadonlyMap<string, unknown>, path: string): string | null {
  let current = path;
  while (current !== "") {
    if (nodes.has(current)) return current;
    current = dirname(current);
  }
  return null;
}
