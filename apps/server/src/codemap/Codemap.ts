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
import { analyzeCodebase, type CodemapAnalysis, filesToRead } from "./analyze.ts";
import { buildCodemapView, parseNameStatus } from "./view.ts";

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
  const lock = yield* Semaphore.make(1);

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
  ) {
    const none = { touched: [], added: [] };
    if (workspace === null || workspace.latest === null) return none;
    const diff = yield* run(
      workspace.cwd,
      "threadChanges",
      ["diff", "--name-status", "--no-renames", "-z", workspace.baseline, workspace.latest],
      4 * 1024 * 1024,
    );
    if (Option.isNone(diff) || diff.value.exitCode !== 0) return none;
    return parseNameStatus(diff.value.stdout, MAX_CHANGED_PATHS);
  });

  const freshnessKey = Effect.fn("Codemap.freshnessKey")(function* (cwd: string) {
    const head = yield* run(cwd, "head", ["rev-parse", "--is-inside-work-tree", "HEAD"], 4096);
    if (Option.isNone(head) || !head.value.stdout.startsWith("true")) return null;
    const status = yield* run(
      cwd,
      "status",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      4 * 1024 * 1024,
    );
    if (Option.isNone(status)) return null;
    return `${head.value.stdout.trim()}\u0000${status.value.stdout}`;
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
    const files = listing.value.stdout.split("\u0000").filter((file) => file.length > 0);
    const texts = new Map<string, string>();
    yield* Effect.forEach(
      filesToRead(files),
      (file) =>
        fs.readFileString(path.join(cwd, file)).pipe(
          Effect.tap((text) => Effect.sync(() => texts.set(file, text))),
          Effect.ignore,
        ),
      { concurrency: 48, discard: true },
    );
    const next: CachedAnalysis = {
      key,
      analysis: analyzeCodebase({ files, texts }),
      totalFiles: files.length,
      analyzedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    };
    cache.delete(cwd);
    cache.set(cwd, next);
    for (const stale of [...cache.keys()].slice(0, Math.max(0, cache.size - MAX_CACHED_WORKSPACES)))
      cache.delete(stale);
    return next;
  });

  const read: Codemap["Service"]["read"] = Effect.fn("Codemap.read")(function* ({
    projectId,
    focusId,
    threadId,
  }) {
    const projectRoot = yield* loadRoot(projectId);
    const workspace = threadId === undefined ? null : yield* threadWorkspace(threadId);
    const workspaceKey = workspace === null ? null : yield* freshnessKey(workspace.cwd);
    const cwd = workspaceKey === null ? projectRoot : (workspace?.cwd ?? projectRoot);
    const key = workspaceKey ?? (yield* freshnessKey(projectRoot));
    if (key === null) return { _tag: "unavailable", reason: "not_a_repository" } as const;
    const result = yield* lock.withPermits(1)(ensureAnalysis(cwd, key));
    if (result === null) return { _tag: "unavailable", reason: "read_failed" } as const;
    const changes = yield* threadChanges(workspaceKey === null ? null : workspace);
    return {
      _tag: "ready",
      view: buildCodemapView(result.analysis, focusId, changes.touched),
      addedPaths: changes.added,
      totalFiles: result.totalFiles,
      analyzedAt: result.analyzedAt,
    } as const;
  });

  return Codemap.of({ read });
});

export const layer = Layer.effect(Codemap, make);
