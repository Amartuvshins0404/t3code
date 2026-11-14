import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  OrchestratorProjectionError,
  OrchestratorRuntimeModeAboveCeilingError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectPlant from "./ProjectPlant.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project:plant-repeat");
const projectModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus",
};

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-plant-repeat-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({ operation: "ProjectPlant.repeat.test.git", cwd, args: [...args] }),
    ),
  );

const makeClone = Effect.fn("ProjectPlant.repeat.test.makeClone")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-plant-repeat-" });
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  yield* git(root, "init", "--bare", "--initial-branch=trunk", remote);
  yield* git(root, "init", "--initial-branch=trunk", seed);
  yield* git(seed, "config", "user.email", "test@example.com");
  yield* git(seed, "config", "user.name", "Test User");
  yield* fs.writeFileString(path.join(seed, "README.md"), "hello\n");
  yield* git(seed, "add", "README.md");
  yield* git(seed, "commit", "-m", "init");
  yield* git(seed, "push", remote, "trunk");
  yield* git(root, "clone", "--origin", "upstream", remote, clone);
  return clone;
});

const ceilingRefusal = (launch: ThreadLaunch.ThreadLaunchInput) =>
  new ThreadLaunch.ThreadLaunchError({
    operation: "create-thread",
    commandId: launch.commandId,
    projectId: launch.projectId,
    cause: new OrchestratorRuntimeModeAboveCeilingError({
      commandId: launch.commandId,
      threadId: launch.threadId ?? ThreadId.make("thread:refused"),
      refused: "mode",
      runtimeMode: launch.runtimeMode,
      maxRuntimeMode: "approval-required",
      organization: "Example Corp",
    }),
  });

const harness = (input: {
  readonly workspaceRoot: string;
  readonly threadLookupFails?: true;
  readonly refusedByCeiling?: true;
}) => {
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const deleted = new Set<ThreadId>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest({
      fallbackModelSelection: null,
      defaultRuntimeMode: "auto-accept-edits",
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot,
                defaultModelSelection: projectModel,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => {
        if (input.threadLookupFails)
          return Effect.fail(new OrchestratorProjectionError({ threadId }));
        const launch = launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined || deleted.has(threadId)
            ? null
            : ({
                id: threadId,
                projectId: launch.projectId,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
      hasReceipt: (commandId) =>
        Effect.succeed(launched.some((launch) => launch.commandId === commandId)),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (launch) => {
        if (input.refusedByCeiling) return Effect.fail(ceilingRefusal(launch));
        launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: { thread: { id: launch.threadId }, runs: [], messages: [] },
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

it.live("after the plant thread is deleted, its replacement is the open thread and is reused", () =>
  Effect.gen(function* () {
    const clone = yield* makeClone();
    const { launched, deleted, layer } = harness({ workspaceRoot: clone });
    const plant = yield* ProjectPlant.ProjectPlant.pipe(Effect.provide(layer));
    const start = plant.start({
      projectId,
      action: "plant",
      createdBy: "user",
      creationSource: "web",
    });

    const first = yield* start;
    deleted.add(first.threadId);
    const replacement = yield* start;
    expect(replacement.reused).toBe(false);
    expect(replacement.threadId).not.toBe(first.threadId);
    expect(yield* plant.readStatus({ projectId })).toEqual({
      _tag: "not_planted",
      openThread: { threadId: replacement.threadId },
    });
    expect(yield* start).toEqual({ threadId: replacement.threadId, reused: true });
    expect(new Set(launched.map((launch) => launch.threadId))).toEqual(
      new Set([first.threadId, replacement.threadId]),
    );
    expect(launched).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live.each<{
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly expected: ProviderInteractionMode;
}>([
  { interactionMode: "plan", expected: "plan" },
  { interactionMode: undefined, expected: "default" },
])(
  "a start asking for $interactionMode launches in $expected mode",
  ({ interactionMode, expected }) =>
    Effect.gen(function* () {
      const clone = yield* makeClone();
      const { launched, layer } = harness({ workspaceRoot: clone });
      yield* ProjectPlant.ProjectPlant.pipe(
        Effect.flatMap((plant) =>
          plant.start({
            projectId,
            action: "plant",
            createdBy: "agent",
            creationSource: "mcp",
            ...(interactionMode === undefined ? {} : { interactionMode }),
          }),
        ),
        Effect.provide(layer),
      );
      expect(launched.map((launch) => launch.interactionMode)).toEqual([expected]);
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live("a failed thread lookup reads as unavailable and starts nothing", () =>
  Effect.gen(function* () {
    const clone = yield* makeClone();
    const { launched, layer } = harness({ workspaceRoot: clone, threadLookupFails: true });
    const plant = yield* ProjectPlant.ProjectPlant.pipe(Effect.provide(layer));
    expect(yield* plant.readStatus({ projectId })).toEqual({
      _tag: "unavailable",
      reason: "read_failed",
    });
    const error = yield* plant
      .start({ projectId, action: "plant", createdBy: "user", creationSource: "web" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "ProjectPlantError",
      reason: "unavailable",
      unavailableReason: "read_failed",
    });
    expect(launched).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live("a launch refused by the administrator's ceiling names the ceiling", () =>
  Effect.gen(function* () {
    const clone = yield* makeClone();
    const { layer } = harness({ workspaceRoot: clone, refusedByCeiling: true });
    const error = yield* ProjectPlant.ProjectPlant.pipe(
      Effect.flatMap((plant) =>
        plant.start({ projectId, action: "plant", createdBy: "user", creationSource: "web" }),
      ),
      Effect.flip,
      Effect.provide(layer),
    );
    expect(error).toMatchObject({
      _tag: "ProjectPlantError",
      reason: "launch_failed",
      ceiling: { organization: "Example Corp", maxRuntimeMode: "approval-required" },
    });
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);
