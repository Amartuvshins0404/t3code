import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const TEAM_AGENT_FILE_TOOLS = ["Read", "Glob", "Grep"] as const;

export const TEAM_AGENT_THREAD_TOOLS = [
  "mcp__t3-code__t3_thread_search",
  "mcp__t3-code__t3_thread_read",
] as const;

const SECRET_NAME_PATTERNS = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.ssh$/i,
  /^\.netrc$/i,
];

export const TEAM_AGENT_SECRET_READ_DENY_RULES = [
  "Read(**/.env*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/id_rsa*)",
  "Read(**/id_dsa*)",
  "Read(**/id_ecdsa*)",
  "Read(**/id_ed25519*)",
  "Read(**/.ssh/**)",
  "Read(**/.netrc)",
];

const TEAM_AGENT_GREP_SECRET_EXCLUSION =
  "!{.env*,*.pem,*.key,id_rsa*,id_dsa*,id_ecdsa*,id_ed25519*,.ssh,.netrc}";

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

const insideRoots = Effect.fn("TeamAgentToolGuard.insideRoots")(function* (
  realTarget: string,
  readableRoots: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of readableRoots) {
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => undefined));
    if (realRoot === undefined) continue;
    const relative = path.relative(realRoot, realTarget);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
  }
  return false;
});

const checkPath = Effect.fn("TeamAgentToolGuard.checkPath")(function* (input: {
  readonly cwd: string;
  readonly target: string;
  readonly readableRoots: ReadonlyArray<string>;
}) {
  if (isTeamAgentSecretPath(input.target)) {
    return deny("Secret files such as .env, keys and SSH files are never readable here.");
  }
  const realTarget = yield* resolveReal(input.cwd, input.target);
  if (realTarget === undefined) return deny(`${input.target} does not exist or is not readable.`);
  if (isTeamAgentSecretPath(realTarget)) {
    return deny("Secret files such as .env, keys and SSH files are never readable here.");
  }
  if (!(yield* insideRoots(realTarget, input.readableRoots))) {
    return deny("Only files inside this agent's projects are readable.");
  }
  return { allow: true } as TeamAgentToolDecision;
});

export const decideTeamAgentToolUse = Effect.fn("TeamAgentToolGuard.decide")(function* (input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd: string;
  readonly readableRoots: ReadonlyArray<string>;
}) {
  const toolInput = isRecord(input.toolInput) ? input.toolInput : {};
  const scope = { cwd: input.cwd, readableRoots: input.readableRoots };
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
