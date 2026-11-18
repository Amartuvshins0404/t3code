import {
  type CheckpointRef,
  CodemapError,
  type CodemapRange,
  type CodemapReadResult,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  analyzeCodebase,
  type CodemapAnalysis,
  countLines,
  filesToRead,
  isManifest,
} from "./analyze.ts";
import {
  authoredChanges,
  buildCodemapView,
  dirtyPaths,
  parseRawNumstat,
  parseRaw,
  pathspecBatches,
  type RawChange,
  underPrefix,
} from "./view.ts";

interface CachedAnalysis {
  readonly key: string;
  readonly analysis: CodemapAnalysis;
  readonly totalFiles: number;
  readonly analyzedAt: string;
}

export interface ThreadWorkspace {
  readonly cwd: string;
  readonly baseline: CheckpointRef;
  readonly latest: CheckpointRef | null;
  readonly runByPath: ReadonlyMap<string, RunId | null>;
}

const MAX_CACHED_WORKSPACES = 8;
const MAX_CHANGED_PATHS = 2_000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_DIRTY_STATS = 2_000;

export class Codemap extends Context.Service<
  Codemap,
  {
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly focusId: string;
      readonly threadId?: ThreadId;
      readonly range?: CodemapRange;
    }) => Effect.Effect<CodemapReadResult, CodemapError>;
  }
>()("t3/codemap/Codemap") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const digest = yield* Digest.Digest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new Map<string, CachedAnalysis>();
  const locks = new Map<string, Semaphore.Semaphore>();

  const run = (cwd: string, operation: string, args: ReadonlyArray<string>, maxBytes: number) =>
    git
      .execute({
        operation: `Codemap.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: maxBytes,
      })
      .pipe(Effect.option);

  const loadRoot = Effect.fn("Codemap.loadRoot")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new CodemapError({ projectId, reason: "project_not_found", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new CodemapError({ projectId, reason: "project_not_found" });
    return project.value.workspaceRoot;
  });

  const threadWorkspace = Effect.fn("Codemap.threadWorkspace")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    range: CodemapRange,
  ) {
    const context = yield* threads
      .getProjectThreadRecords({ projectId, threadId }, ["checkpointScopes", "checkpoints"])
      .pipe(Effect.option);
    if (Option.isNone(context)) return null;
    const { checkpointScopes, checkpoints } = context.value;
    const root = checkpointScopes.find((scope) => scope.kind === "root_run");
    if (!root) return null;
    const ready = checkpoints
      .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.appRunOrdinal !== null)
      .toSorted((a, b) => (a.appRunOrdinal ?? 0) - (b.appRunOrdinal ?? 0));
    const latest =
      (range === "last_turn"
        ? ready.findLast((checkpoint) => checkpoint.files.length > 0)
        : undefined) ??
      ready.at(-1) ??
      null;
    const latestScope = checkpointScopes.find((scope) => scope.id === latest?.scopeId);
    const lastTurn = range === "last_turn" && latest !== null && latest.ordinalWithinScope > 0;
    const baseline = yield* checkpointRefForScopeOrdinal(
      lastTurn
        ? { scopeId: latest.scopeId, ordinalWithinScope: latest.ordinalWithinScope - 1 }
        : { scopeId: root.id, ordinalWithinScope: 0 },
    ).pipe(Effect.provideService(Digest.Digest, digest));
    const runByPath = new Map<string, RunId | null>();
    for (const checkpoint of lastTurn ? [latest] : ready)
      for (const file of checkpoint.files) runByPath.set(file.path, checkpoint.runId);
    return {
      cwd: latestScope?.cwd ?? root.cwd,
      baseline,
      latest: latest?.ref ?? null,
      runByPath,
    } satisfies ThreadWorkspace;
  });

  const fileStamp = (cwd: string, file: string) =>
    fs.lstat(path.join(cwd, file)).pipe(
      Effect.map(
        (info) =>
          `${info.type}:${info.size}:${Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          })}`,
      ),
      Effect.orElseSucceed(() => ""),
    );

  const freshnessKey = Effect.fn("Codemap.freshnessKey")(function* (cwd: string) {
    const head = yield* run(
      cwd,
      "head",
      ["rev-parse", "--is-inside-work-tree", "--show-prefix", "HEAD"],
      4096,
    );
    if (Option.isNone(head)) return { _tag: "failed", reason: "read_failed" } as const;
    const [inside = "", prefix = "", commit = ""] = head.value.stdout.split("\n");
    if (inside !== "true") return { _tag: "failed", reason: "not_a_repository" } as const;
    const status = yield* run(
      cwd,
      "status",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      16 * 1024 * 1024,
    );
    if (Option.isNone(status) || status.value.exitCode !== 0)
      return { _tag: "failed", reason: "read_failed" } as const;
    const dirty = underPrefix(dirtyPaths(status.value.stdout), prefix).slice(0, MAX_DIRTY_STATS);
    const stamps = yield* Effect.forEach(dirty, (file) => fileStamp(cwd, file), {
      concurrency: 32,
    });
    return {
      _tag: "fresh",
      prefix,
      key: [commit, status.value.stdout, ...stamps].join("\u0000"),
    } as const;
  });

  const ensureAnalysis = Effect.fn("Codemap.ensureAnalysis")(function* (cwd: string, key: string) {
    const cached = cache.get(cwd);
    if (cached && cached.key === key) return cached;
    const listing = yield* run(
      cwd,
      "listFiles",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      64 * 1024 * 1024,
    );
    if (Option.isNone(listing) || listing.value.exitCode !== 0) return null;
    const files = listing.value.stdout
      .split("\u0000")
      .filter((file) => file.length > 0)
      .slice(0, MAX_FILES);
    const realRoot = yield* fs.realPath(cwd).pipe(Effect.option);
    if (Option.isNone(realRoot)) return null;
    const lineCounts = new Map<string, number>();
    const manifests = new Map<string, string>();
    yield* Effect.forEach(
      filesToRead(files),
      (file) =>
        Effect.gen(function* () {
          const bytes = yield* readSource(realRoot.value, file);
          if (bytes === null) return;
          lineCounts.set(file, countLines(bytes));
          if (isManifest(file)) manifests.set(file, new TextDecoder().decode(bytes));
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.ignore,
        ),
      { concurrency: 48, discard: true },
    );
    const next: CachedAnalysis = {
      key,
      analysis: analyzeCodebase({ files, lineCounts, manifests }),
      totalFiles: files.length,
      analyzedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    };
    cache.delete(cwd);
    cache.set(cwd, next);
    for (const stale of [...cache.keys()].slice(0, Math.max(0, cache.size - MAX_CACHED_WORKSPACES)))
      cache.delete(stale);
    return next;
  });

  const lockFor = (cwd: string) => {
    const existing = locks.get(cwd);
    if (existing) return existing;
    const created = Semaphore.makeUnsafe(1);
    locks.set(cwd, created);
    return created;
  };

  const read: Codemap["Service"]["read"] = Effect.fn("Codemap.read")(function* ({
    projectId,
    focusId,
    threadId,
    range = "thread",
  }) {
    const projectRoot = yield* loadRoot(projectId);
    const workspace =
      threadId === undefined ? null : yield* threadWorkspace(projectId, threadId, range);
    const workspaceFresh = workspace === null ? null : yield* freshnessKey(workspace.cwd);
    const useWorkspace = workspace !== null && workspaceFresh?._tag === "fresh";
    const cwd = useWorkspace ? workspace.cwd : projectRoot;
    const fresh = useWorkspace ? workspaceFresh : yield* freshnessKey(projectRoot);
    if (fresh._tag === "failed") return { _tag: "unavailable", reason: fresh.reason } as const;
    const result = yield* lockFor(cwd).withPermits(1)(ensureAnalysis(cwd, fresh.key));
    if (result === null) return { _tag: "unavailable", reason: "read_failed" } as const;
    const changes = yield* readThreadChanges(
      run,
      useWorkspace ? workspace : null,
      fresh.prefix,
      result.analysis,
    );
    return {
      _tag: "ready",
      view: buildCodemapView(
        result.analysis,
        focusId,
        changes.map((change) => change.path),
      ),
      changes,
      pathPrefix: fresh.prefix,
      totalFiles: result.totalFiles,
      analyzedAt: result.analyzedAt,
    } as const;
  });

  return Codemap.of({ read });
});

export const layer = Layer.effect(Codemap, make);

export const readSource = Effect.fn("Codemap.readSource")(function* (
  realRoot: string,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(realRoot, file);
  const info = yield* fs.lstat(target);
  if (info.type !== "File" || info.size > MAX_READ_BYTES) return null;
  const real = yield* fs.realPath(target);
  if (!real.startsWith(`${realRoot}${path.sep}`)) return null;
  return yield* fs.readFile(real);
});

export type GitRun = (
  cwd: string,
  operation: string,
  args: ReadonlyArray<string>,
  maxBytes: number,
) => Effect.Effect<Option.Option<{ readonly exitCode: number; readonly stdout: string }>>;

export const readThreadChanges = Effect.fn("Codemap.readThreadChanges")(function* (
  run: GitRun,
  workspace: ThreadWorkspace | null,
  prefix: string,
  analysis: CodemapAnalysis,
) {
  if (workspace === null || workspace.latest === null) return [];
  const { baseline, latest, cwd, runByPath } = workspace;
  // One tree-level pass finds the thread's files and pairs moves; line counts are read for those files only.
  const listing = yield* run(
    cwd,
    "threadChangeList",
    [
      "-c",
      "diff.relative=false",
      "-c",
      "diff.renameLimit=5000",
      "diff",
      "--raw",
      "--find-renames",
      "-z",
      baseline,
      latest,
    ],
    32 * 1024 * 1024,
  );
  if (Option.isNone(listing) || listing.value.exitCode !== 0) return [];
  const owned = parseRaw(listing.value.stdout)
    .filter(
      (entry) =>
        entry.path.startsWith(prefix) &&
        (runByPath.has(entry.path) || (entry.from !== null && runByPath.has(entry.from))),
    )
    .slice(0, MAX_CHANGED_PATHS);
  const raw = new Map<string, RawChange>();
  for (const batch of pathspecBatches(
    owned.map((entry) => (entry.from === null ? [entry.path] : [entry.from, entry.path])),
  )) {
    const diff = yield* run(
      cwd,
      "threadChanges",
      [
        "-c",
        "diff.relative=false",
        "diff",
        "--raw",
        "--numstat",
        "--find-renames",
        "-z",
        baseline,
        latest,
        "--",
        ...batch,
      ],
      8 * 1024 * 1024,
    );
    if (Option.isNone(diff) || diff.value.exitCode !== 0) return [];
    for (const change of parseRawNumstat(diff.value.stdout, MAX_CHANGED_PATHS))
      raw.set(change.path, change);
  }
  return authoredChanges({
    raw: [...raw.values()],
    runByPath,
    prefix,
    analysis,
    limit: MAX_CHANGED_PATHS,
  });
});
