import {
  type CheckpointRef,
  CodemapError,
  type CodemapReadResult,
  type ProjectId,
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
import { buildCodemapView, dirtyPaths, parseNameStatus, underPrefix } from "./view.ts";

interface CachedAnalysis {
  readonly key: string;
  readonly analysis: CodemapAnalysis;
  readonly totalFiles: number;
  readonly analyzedAt: string;
}

interface ThreadWorkspace {
  readonly cwd: string;
  readonly baseline: CheckpointRef;
  readonly latest: CheckpointRef | null;
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

  const threadWorkspace = Effect.fn("Codemap.threadWorkspace")(function* (threadId: ThreadId) {
    const context = yield* threads.getCheckpointContext(threadId).pipe(Effect.option);
    if (Option.isNone(context)) return null;
    const { checkpointScopes, checkpoints } = context.value;
    const root = checkpointScopes.find((scope) => scope.kind === "root_run");
    if (!root) return null;
    const latest = checkpoints
      .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.appRunOrdinal !== null)
      .reduce<(typeof checkpoints)[number] | null>(
        (best, checkpoint) =>
          best === null || (checkpoint.appRunOrdinal ?? 0) > (best.appRunOrdinal ?? 0)
            ? checkpoint
            : best,
        null,
      );
    const latestScope = checkpointScopes.find((scope) => scope.id === latest?.scopeId);
    const baseline = yield* checkpointRefForScopeOrdinal({
      scopeId: root.id,
      ordinalWithinScope: 0,
    }).pipe(Effect.provideService(Digest.Digest, digest));
    return {
      cwd: latestScope?.cwd ?? root.cwd,
      baseline,
      latest: latest?.ref ?? null,
    } satisfies ThreadWorkspace;
  });

  const threadChanges = Effect.fn("Codemap.threadChanges")(function* (
    workspace: ThreadWorkspace | null,
    prefix: string,
  ) {
    const none = { touched: [], added: [] };
    if (workspace === null || workspace.latest === null) return none;
    const diff = yield* run(
      workspace.cwd,
      "threadChanges",
      [
        "-c",
        "diff.relative=false",
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        workspace.baseline,
        workspace.latest,
      ],
      4 * 1024 * 1024,
    );
    if (Option.isNone(diff) || diff.value.exitCode !== 0) return none;
    const changes = parseNameStatus(diff.value.stdout, MAX_CHANGED_PATHS);
    return {
      touched: underPrefix(changes.touched, prefix),
      added: underPrefix(changes.added, prefix),
    };
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
  }) {
    const projectRoot = yield* loadRoot(projectId);
    const workspace = threadId === undefined ? null : yield* threadWorkspace(threadId);
    const workspaceFresh = workspace === null ? null : yield* freshnessKey(workspace.cwd);
    const useWorkspace = workspace !== null && workspaceFresh?._tag === "fresh";
    const cwd = useWorkspace ? workspace.cwd : projectRoot;
    const fresh = useWorkspace ? workspaceFresh : yield* freshnessKey(projectRoot);
    if (fresh._tag === "failed") return { _tag: "unavailable", reason: fresh.reason } as const;
    const result = yield* lockFor(cwd).withPermits(1)(ensureAnalysis(cwd, fresh.key));
    if (result === null) return { _tag: "unavailable", reason: "read_failed" } as const;
    const changes = yield* threadChanges(useWorkspace ? workspace : null, fresh.prefix);
    return {
      _tag: "ready",
      view: buildCodemapView(result.analysis, focusId, changes.touched),
      addedPaths: changes.added,
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
