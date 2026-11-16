import { CodemapError, type CodemapReadResult, type ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { analyzeCodebase, type CodemapAnalysis, filesToRead } from "./analyze.ts";
import { buildCodemapView } from "./view.ts";

interface CachedAnalysis {
  readonly key: string;
  readonly analysis: CodemapAnalysis;
  readonly totalFiles: number;
  readonly analyzedAt: string;
  readonly durationMs: number;
}

type Unavailable = Extract<CodemapReadResult, { _tag: "unavailable" }>;

export class Codemap extends Context.Service<
  Codemap,
  {
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly focusId: string;
    }) => Effect.Effect<CodemapReadResult, CodemapError>;
    readonly analyze: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<CodemapReadResult, CodemapError>;
  }
>()("t3/codemap/Codemap") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new Map<ProjectId, CachedAnalysis>();
  const lock = yield* Semaphore.make(1);

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

  const unavailable = (reason: Unavailable["reason"]): Unavailable => ({
    _tag: "unavailable",
    reason,
  });

  const freshnessKey = Effect.fn("Codemap.freshnessKey")(function* (cwd: string) {
    const run = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: `Codemap.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: 4 * 1024 * 1024,
      });
    const head = yield* run("head", ["rev-parse", "--is-inside-work-tree", "HEAD"]);
    if (!head.stdout.startsWith("true")) return null;
    const status = yield* run("status", [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    return `${head.stdout.trim()}\u0000${status.stdout}`;
  });

  const ensureAnalysis = Effect.fn("Codemap.ensureAnalysis")(function* (
    projectId: ProjectId,
    cwd: string,
  ) {
    const key = yield* freshnessKey(cwd).pipe(Effect.orElseSucceed(() => null));
    if (key === null) return unavailable("not_a_repository");
    const cached = cache.get(projectId);
    if (cached && cached.key === key) return cached;
    const started = yield* Clock.currentTimeMillis;
    const listing = yield* git
      .execute({
        operation: "Codemap.listFiles",
        cwd,
        args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        allowNonZeroExit: true,
        maxOutputBytes: 64 * 1024 * 1024,
      })
      .pipe(Effect.option);
    if (Option.isNone(listing) || listing.value.exitCode !== 0) return unavailable("read_failed");
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
    const analysis = analyzeCodebase({ files, texts });
    const finished = yield* Clock.currentTimeMillis;
    const next: CachedAnalysis = {
      key,
      analysis,
      totalFiles: files.length,
      analyzedAt: DateTime.formatIso(DateTime.makeUnsafe(finished)),
      durationMs: finished - started,
    };
    cache.set(projectId, next);
    return next;
  });

  const toResult = (result: CachedAnalysis | Unavailable, focusId: string): CodemapReadResult =>
    "_tag" in result
      ? result
      : {
          _tag: "ready",
          view: buildCodemapView(result.analysis, focusId),
          languages: result.analysis.languages.slice(0, 8),
          totalFiles: result.totalFiles,
          analyzedAt: result.analyzedAt,
          durationMs: result.durationMs,
        };

  const storeFailed = (projectId: ProjectId) => (cause: unknown) =>
    new CodemapError({ projectId, reason: "store_failed", cause });

  const read: Codemap["Service"]["read"] = Effect.fn("Codemap.read")(function* ({
    projectId,
    focusId,
  }) {
    const cwd = yield* loadRoot(projectId);
    const rows = yield* sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId" FROM codemap_projects WHERE project_id = ${projectId}
    `.pipe(Effect.mapError(storeFailed(projectId)));
    if (rows.length === 0) return { _tag: "not_analyzed" } as const;
    const result = yield* lock.withPermits(1)(ensureAnalysis(projectId, cwd));
    return toResult(result, focusId);
  });

  const analyze: Codemap["Service"]["analyze"] = Effect.fn("Codemap.analyze")(function* ({
    projectId,
  }) {
    const cwd = yield* loadRoot(projectId);
    const result = yield* lock.withPermits(1)(ensureAnalysis(projectId, cwd));
    if (!("_tag" in result)) {
      yield* sql`
        INSERT INTO codemap_projects (project_id, analyzed_at)
        VALUES (${projectId}, ${result.analyzedAt})
        ON CONFLICT (project_id) DO UPDATE SET analyzed_at = excluded.analyzed_at
      `.pipe(Effect.mapError(storeFailed(projectId)));
    }
    return toResult(result, "");
  });

  return Codemap.of({ read, analyze });
});

export const layer = Layer.effect(Codemap, make);
