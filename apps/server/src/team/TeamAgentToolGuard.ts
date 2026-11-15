import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const TEAM_AGENT_FILE_TOOLS = ["Read", "Glob", "Grep"] as const;

export const TEAM_AGENT_THREAD_TOOLS = [
  "mcp__t3-code__t3_thread_search",
  "mcp__t3-code__t3_thread_read",
] as const;

const SECRET_NAMES = [
  ".env*",
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git",
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube",
  ".docker",
  ".t3",
  "credentials",
  "credentials.*",
  "secrets.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.tfstate",
  "*.tfvars",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
];

const SECRET_NAME_PATTERNS = SECRET_NAMES.map(
  (name) =>
    new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i"),
);

export const TEAM_AGENT_SECRET_READ_DENY_RULES = SECRET_NAMES.flatMap((name) => [
  `Read(**/${name})`,
  `Read(**/${name}/**)`,
]);

const anyCaseGlob = (name: string) =>
  name.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);

const TEAM_AGENT_GREP_SECRET_EXCLUSION = `!{${SECRET_NAMES.map(anyCaseGlob).join(",")}}`;

const SECRET_REFUSAL =
  "Secret files such as .env, keys, credentials and .git or .ssh folders are never readable here.";

const FILE_MENTION = /(?:^|[\s([{<"'`])@(\S+)/g;

export const TEAM_AGENT_FILE_MENTION_MESSAGE =
  "Agent conversations do not take @ file mentions. Write the path without @ and the agent will read it.";

export const hasTeamAgentFileMention = (text: string) =>
  [...text.matchAll(FILE_MENTION)].some(([, token = ""]) => {
    const target = token.replace(/^["'`]/, "");
    return target.startsWith("~") || target.includes("/") || target.includes(".");
  });

export const TeamAgentReadableRoots = Schema.Struct({
  type: Schema.Literal("readOnly"),
  access: Schema.Struct({
    type: Schema.Literal("restricted"),
    readableRoots: Schema.NonEmptyArray(Schema.String),
  }),
});
export const decodeTeamAgentReadableRoots = Schema.decodeUnknownOption(TeamAgentReadableRoots);

export type TeamAgentToolDecision =
  | { readonly allow: true; readonly updatedInput?: Record<string, unknown> }
  | { readonly allow: false; readonly reason: string };

const deny = (reason: string): TeamAgentToolDecision => ({ allow: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const isTeamAgentSecretPath = (filePath: string) =>
  filePath
    .split(/[\\/]+/)
    .some((segment) => SECRET_NAME_PATTERNS.some((pattern) => pattern.test(segment)));

export interface TeamAgentAppData {
  readonly home: string;
  readonly workspaceFolders: ReadonlyArray<string>;
}

const escapesBase = (pattern: string) =>
  pattern.startsWith("/") ||
  pattern.startsWith("~") ||
  /^[a-zA-Z]:/.test(pattern) ||
  pattern.split(/[\\/]+/).includes("..");

const resolveReal = Effect.fn("TeamAgentToolGuard.resolveReal")(function* (
  cwd: string,
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .realPath(path.resolve(cwd, target))
    .pipe(Effect.orElseSucceed(() => undefined));
});

const relativeInside = (path: Path.Path, root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : relative;
};

const insideRoots = Effect.fn("TeamAgentToolGuard.insideRoots")(function* (
  realTarget: string,
  roots: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of roots) {
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => undefined));
    if (realRoot === undefined) continue;
    const relative = relativeInside(path, realRoot, realTarget);
    if (relative !== undefined) return relative;
  }
  return undefined;
});

const checkPath = Effect.fn("TeamAgentToolGuard.checkPath")(function* (input: {
  readonly cwd: string;
  readonly target: string;
  readonly readableRoots: ReadonlyArray<string>;
  readonly appData: TeamAgentAppData | undefined;
}) {
  const path = yield* Path.Path;
  const lexicalTarget = path.resolve(input.cwd, input.target);
  const lexical = input.readableRoots
    .map((root) => relativeInside(path, path.resolve(root), lexicalTarget))
    .find((relative) => relative !== undefined);
  if (lexical !== undefined && isTeamAgentSecretPath(lexical)) return deny(SECRET_REFUSAL);
  const realTarget = yield* resolveReal(input.cwd, input.target);
  if (realTarget === undefined) return deny(`${input.target} does not exist or is not readable.`);
  const inside = yield* insideRoots(realTarget, input.readableRoots);
  if (inside === undefined) return deny("Only files inside this agent's projects are readable.");
  if (isTeamAgentSecretPath(inside)) return deny(SECRET_REFUSAL);
  if (
    input.appData !== undefined &&
    (yield* insideRoots(realTarget, [input.appData.home])) !== undefined &&
    (yield* insideRoots(realTarget, input.appData.workspaceFolders)) === undefined
  ) {
    return deny("T3 Code's own data is never readable here.");
  }
  return { allow: true } as TeamAgentToolDecision;
});

export const decideTeamAgentToolUse = Effect.fn("TeamAgentToolGuard.decide")(function* (input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd: string;
  readonly readableRoots: ReadonlyArray<string>;
  readonly appData: TeamAgentAppData | undefined;
}) {
  const toolInput = isRecord(input.toolInput) ? input.toolInput : {};
  const scope = { cwd: input.cwd, readableRoots: input.readableRoots, appData: input.appData };
  switch (input.toolName) {
    case "Read": {
      const filePath = stringField(toolInput, "file_path");
      if (filePath === undefined) return deny("Read needs a file_path.");
      return yield* checkPath({ ...scope, target: filePath });
    }
    case "Glob": {
      const pattern = stringField(toolInput, "pattern");
      if (pattern === undefined || escapesBase(pattern)) {
        return deny("Glob patterns must stay inside the project. Use `path` to pick a folder.");
      }
      return yield* checkPath({ ...scope, target: stringField(toolInput, "path") ?? input.cwd });
    }
    case "Grep": {
      if (stringField(toolInput, "glob") !== undefined) {
        return deny(
          "Grep's `glob` is not available here. Narrow the search with `path` or `type`.",
        );
      }
      const searchPath = stringField(toolInput, "path") ?? input.cwd;
      const checked = yield* checkPath({ ...scope, target: searchPath });
      if (!checked.allow) return checked;
      const appHome =
        input.appData === undefined ? undefined : yield* resolveReal(input.cwd, input.appData.home);
      const realSearchPath = yield* resolveReal(input.cwd, searchPath);
      if (
        appHome !== undefined &&
        realSearchPath !== undefined &&
        (yield* insideRoots(appHome, [realSearchPath])) !== undefined
      ) {
        return deny("This folder holds T3 Code's own data. Search inside a project folder.");
      }
      return {
        allow: true,
        updatedInput: { ...toolInput, glob: TEAM_AGENT_GREP_SECRET_EXCLUSION },
      } as TeamAgentToolDecision;
    }
    case "mcp__t3-code__t3_thread_search":
    case "mcp__t3-code__t3_thread_read":
      return toolInput.environmentId === undefined
        ? ({ allow: true } as TeamAgentToolDecision)
        : deny("Only this machine's threads are readable here.");
    default:
      return deny(
        `${input.toolName} is not available in an agent conversation. This conversation can only read files and thread history.`,
      );
  }
});
