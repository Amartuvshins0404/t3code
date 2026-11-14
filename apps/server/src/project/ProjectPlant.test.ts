import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type GitCommandError,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectPlant from "./ProjectPlant.ts";
import * as ProjectService from "./ProjectService.ts";

const MERGE_LANE = ".github/workflows/merge-lane.yml";
const BLIND_CHECKS = ".github/workflows/blind-checks.yml";
const PLANT_COMMAND = "npx -y github:Amartuvshins0404/agent-trust#v0 setup";

const callerOf = (workflow: string, ref: string) =>
  [
    "name: Agent trust",
    "on: pull_request_target",
    "jobs:",
    "  run:",
    `    uses: Amartuvshins0404/agent-trust/.github/workflows/${workflow}@${ref}`,
    "",
  ].join("\n");

const foreignWorkflow = [
  "name: Someone else's",
  "on: pull_request",
  "jobs:",
  "  run:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hello",
  "",
].join("\n");

const projectId = ProjectId.make("project:plant");
const projectModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus",
};

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-plant-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({ operation: "ProjectPlant.test.git", cwd, args: [...args] }),
    ),
    Effect.map((result) => result.stdout.trim()),
  );

const writeFile = Effect.fn("ProjectPlant.test.writeFile")(function* (
  dir: string,
  relativePath: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(dir, relativePath);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, text);
});

const commitFile = Effect.fn("ProjectPlant.test.commitFile")(function* (
  dir: string,
  relativePath: string,
  text: string,
) {
  yield* writeFile(dir, relativePath, text);
  yield* git(dir, "add", relativePath);
  yield* git(dir, "commit", "-m", `add ${relativePath}`);
});

const configureAuthor = (dir: string) =>
  git(dir, "config", "user.email", "test@example.com").pipe(
    Effect.andThen(git(dir, "config", "user.name", "Test User")),
    Effect.andThen(git(dir, "config", "core.autocrlf", "false")),
  );

/**
 * A bare remote whose default branch is `trunk`, a seed checkout that pushes to it by path
 * (so the seed has no remote), and a clone whose only remote is `upstream`.
 */
const makeRepository = Effect.fn("ProjectPlant.test.makeRepository")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-plant-" });
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  yield* git(root, "init", "--bare", "--initial-branch=trunk", remote);
  yield* git(root, "init", "--initial-branch=trunk", seed);
  yield* configureAuthor(seed);
  yield* commitFile(seed, "README.md", "hello\n");
  yield* git(seed, "push", remote, "trunk");
  yield* git(root, "clone", "--origin", "upstream", remote, clone);
  yield* configureAuthor(clone);
  const push = (relativePath: string, text: string) =>
    commitFile(seed, relativePath, text).pipe(Effect.andThen(git(seed, "push", remote, "trunk")));
  return { root, remote, seed, clone, push };
});

type Repository = Effect.Success<ReturnType<typeof makeRepository>>;
type Arrange = (
  repository: Repository,
) => Effect.Effect<
  unknown,
  PlatformError.PlatformError | GitCommandError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
>;

const harness = (input: {
  readonly workspaceRoot: string;
  readonly defaultModel?: ModelSelection | null;
  readonly defaultRuntimeMode?: RuntimeMode;
}) => {
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const deleted = new Set<ThreadId>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest({
      fallbackModelSelection: null,
      defaultRuntimeMode: input.defaultRuntimeMode ?? "auto-accept-edits",
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot,
                defaultModelSelection:
                  input.defaultModel === undefined ? projectModel : input.defaultModel,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => {
        const launch = launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: threadId,
                projectId: launch.projectId,
                title: launch.title,
                modelSelection: launch.modelSelection,
                deletedAt: deleted.has(threadId) ? "2026-11-14T00:00:00.000Z" : null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (launch) => {
        launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
            messages: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
  );
  return {
    launched,
    deleted,
    layer: ProjectPlant.layer.pipe(Layer.provide(dependencies), Layer.provide(gitLayer)),
  };
};

const readStatus = (workspaceRoot: string) =>
  ProjectPlant.ProjectPlant.pipe(
    Effect.flatMap((plant) => plant.readStatus({ projectId })),
    Effect.provide(harness({ workspaceRoot }).layer),
  );

it.live.each<{
  readonly name: string;
  readonly arrange: Arrange;
  readonly workspaceRoot?: (repository: Repository) => string;
  readonly expected: object;
}>([
  {
    name: "a remote default without agent-trust is not planted",
    arrange: () => Effect.void,
    expected: { _tag: "not_planted", openThread: null },
  },
  {
    name: "agent-trust's merge lane pushed after the clone is planted though the working tree lacks it",
    arrange: (repository) => repository.push(MERGE_LANE, callerOf("merge-lane.yml", "v0")),
    expected: { _tag: "planted", openThread: null },
  },
  {
    name: "a merge lane pinned to a commit is planted",
    arrange: (repository) =>
      repository.push(
        MERGE_LANE,
        callerOf("merge-lane.yml", "3f2c9a1e0b7d4c5a6e8f9a0b1c2d3e4f5a6b7c8d"),
      ),
    expected: { _tag: "planted", openThread: null },
  },
  {
    name: "a merge lane only in the working tree is not planted",
    arrange: (repository) =>
      writeFile(repository.clone, MERGE_LANE, callerOf("merge-lane.yml", "v0")),
    expected: { _tag: "not_planted", openThread: null },
  },
  {
    name: "a merge lane committed on the local default branch but not pushed is not planted",
    arrange: (repository) =>
      commitFile(repository.clone, MERGE_LANE, callerOf("merge-lane.yml", "v0")),
    expected: { _tag: "not_planted", openThread: null },
  },
  {
    name: "someone else's merge-lane.yml on the remote default blocks it",
    arrange: (repository) => repository.push(MERGE_LANE, foreignWorkflow),
    expected: { _tag: "blocked", file: expect.stringMatching(/merge-lane\.yml$/) },
  },
  {
    name: "someone else's blind-checks.yml with no merge lane blocks it",
    arrange: (repository) => repository.push(BLIND_CHECKS, foreignWorkflow),
    expected: { _tag: "blocked", file: expect.stringMatching(/blind-checks\.yml$/) },
  },
  {
    name: "agent-trust's blind checks alone are not planted",
    arrange: (repository) => repository.push(BLIND_CHECKS, callerOf("blind-checks.yml", "v0")),
    expected: { _tag: "not_planted", openThread: null },
  },
  {
    name: "a folder that is not a repository is unavailable",
    arrange: (repository) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(`${repository.root}/plain`)),
      ),
    workspaceRoot: (repository) => `${repository.root}/plain`,
    expected: { _tag: "unavailable", reason: "not_a_repository" },
  },
  {
    name: "a repository with no remote is unavailable",
    arrange: () => Effect.void,
    workspaceRoot: (repository) => repository.seed,
    expected: { _tag: "unavailable", reason: "no_remote" },
  },
  {
    name: "a remote whose default branch is not known locally is unavailable",
    arrange: (repository) =>
      git(repository.clone, "config", "remote.upstream.followRemoteHEAD", "never").pipe(
        Effect.andThen(git(repository.clone, "remote", "set-head", "upstream", "-d")),
      ),
    expected: { _tag: "unavailable", reason: "no_default_branch" },
  },
])("plant status: $name", ({ arrange, workspaceRoot, expected }) =>
  Effect.gen(function* () {
    const repository = yield* makeRepository();
    yield* arrange(repository);
    const status = yield* readStatus(workspaceRoot?.(repository) ?? repository.clone);
    expect(status).toEqual(expected);
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

const planted = (repository: Repository) =>
  repository.push(MERGE_LANE, callerOf("merge-lane.yml", "v0"));
const blocked = (repository: Repository) => repository.push(MERGE_LANE, foreignWorkflow);

it.live.each<{
  readonly name: string;
  readonly action: "plant" | "unplant";
  readonly arrange: Arrange;
  readonly workspaceRoot?: (repository: Repository) => string;
  readonly defaultModel?: null;
  readonly refusal: object;
}>([
  {
    name: "Plant on a planted project",
    action: "plant",
    arrange: planted,
    refusal: { reason: "already_planted" },
  },
  {
    name: "Unplant on a project that is not planted",
    action: "unplant",
    arrange: () => Effect.void,
    refusal: { reason: "not_planted" },
  },
  {
    name: "Plant on a blocked project",
    action: "plant",
    arrange: blocked,
    refusal: { reason: "blocked", file: expect.stringMatching(/merge-lane\.yml$/) },
  },
  {
    name: "Unplant on a blocked project",
    action: "unplant",
    arrange: blocked,
    refusal: { reason: "blocked", file: expect.stringMatching(/merge-lane\.yml$/) },
  },
  {
    name: "Plant on an unavailable project",
    action: "plant",
    arrange: () => Effect.void,
    workspaceRoot: (repository) => repository.seed,
    refusal: { reason: "unavailable", unavailableReason: "no_remote" },
  },
  {
    name: "Unplant on an unavailable project",
    action: "unplant",
    arrange: () => Effect.void,
    workspaceRoot: (repository) => repository.seed,
    refusal: { reason: "unavailable", unavailableReason: "no_remote" },
  },
  {
    name: "Plant on a project with no default model and no fallback",
    action: "plant",
    arrange: () => Effect.void,
    defaultModel: null,
    refusal: { reason: "no_default_model" },
  },
])(
  "$name is refused and starts no thread",
  ({ action, arrange, workspaceRoot, defaultModel, refusal }) =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* arrange(repository);
      const { launched, layer } = harness({
        workspaceRoot: workspaceRoot?.(repository) ?? repository.clone,
        ...(defaultModel === undefined ? {} : { defaultModel }),
      });
      const error = yield* ProjectPlant.ProjectPlant.pipe(
        Effect.flatMap((plant) =>
          plant.start({ projectId, action, createdBy: "user", creationSource: "web" }),
        ),
        Effect.flip,
        Effect.provide(layer),
      );
      expect(error).toMatchObject({ _tag: "ProjectPlantError", projectId, ...refusal });
      expect(launched).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live.each<{
  readonly action: "plant" | "unplant";
  readonly arrange: Arrange;
  readonly title: string;
  readonly command: string;
  readonly absent: string | undefined;
}>([
  {
    action: "plant",
    arrange: () => Effect.void,
    title: "Plant agent-trust",
    command: PLANT_COMMAND,
    absent: "--remove",
  },
  {
    action: "unplant",
    arrange: planted,
    title: "Unplant agent-trust",
    command: `${PLANT_COMMAND} --remove`,
    absent: undefined,
  },
])(
  "an accepted $action starts one thread in a new worktree from the remote default with the project's defaults",
  ({ action, arrange, title, command, absent }) =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      yield* arrange(repository);
      const { launched, layer } = harness({ workspaceRoot: repository.clone });
      const result = yield* ProjectPlant.ProjectPlant.pipe(
        Effect.flatMap((plant) =>
          plant.start({ projectId, action, createdBy: "user", creationSource: "web" }),
        ),
        Effect.provide(layer),
      );
      expect(launched).toHaveLength(1);
      const launch = launched[0]!;
      expect(result).toEqual({ threadId: launch.threadId, reused: false });
      expect(launch).toMatchObject({
        projectId,
        title,
        modelSelection: projectModel,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "upstream/trunk", startFromOrigin: true },
      });
      expect(launch.initialMessage?.text).toContain(command);
      if (absent !== undefined) expect(launch.initialMessage?.text).not.toContain(absent);
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live("a caller's ceiling caps the project's default access mode", () =>
  Effect.gen(function* () {
    const repository = yield* makeRepository();
    const { launched, layer } = harness({
      workspaceRoot: repository.clone,
      defaultRuntimeMode: "full-access",
    });
    yield* ProjectPlant.ProjectPlant.pipe(
      Effect.flatMap((plant) =>
        plant.start({
          projectId,
          action: "plant",
          createdBy: "agent",
          creationSource: "mcp",
          runtimeMode: "approval-required",
        }),
      ),
      Effect.provide(layer),
    );
    expect(launched.map((launch) => launch.runtimeMode)).toEqual(["approval-required"]);
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live(
  "a repeat Plant returns the open thread until the default branch moves or the thread is deleted",
  () =>
    Effect.gen(function* () {
      const repository = yield* makeRepository();
      const { launched, deleted, layer } = harness({ workspaceRoot: repository.clone });
      const plant = yield* ProjectPlant.ProjectPlant.pipe(Effect.provide(layer));
      const start = plant.start({
        projectId,
        action: "plant",
        createdBy: "user",
        creationSource: "web",
      });
      const startedThreads = () => new Set(launched.map((launch) => launch.threadId));

      const first = yield* start;
      expect(first.reused).toBe(false);
      expect(yield* start).toEqual({ threadId: first.threadId, reused: true });
      expect(startedThreads()).toEqual(new Set([first.threadId]));
      expect(yield* plant.readStatus({ projectId })).toEqual({
        _tag: "not_planted",
        openThread: { threadId: first.threadId },
      });

      yield* repository.push("README.md", "moved\n");
      yield* git(repository.clone, "fetch", "upstream");
      const afterMove = yield* start;
      expect(afterMove.reused).toBe(false);
      expect(afterMove.threadId).not.toBe(first.threadId);
      expect(startedThreads()).toEqual(new Set([first.threadId, afterMove.threadId]));

      deleted.add(afterMove.threadId);
      expect(yield* plant.readStatus({ projectId })).toEqual({
        _tag: "not_planted",
        openThread: null,
      });
      const afterDelete = yield* start;
      expect(afterDelete.reused).toBe(false);
      expect(afterDelete.threadId).not.toBe(afterMove.threadId);
      expect(startedThreads().size).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);
