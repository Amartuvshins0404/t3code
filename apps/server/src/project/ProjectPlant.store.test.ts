import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectPlant from "./ProjectPlant.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

const projectId = ProjectId.make("project:plant-store");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in plant store tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-plant-store-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({ operation: "ProjectPlant.store.test.git", cwd, args: [...args] }),
    ),
  );

const makeClone = Effect.fn("ProjectPlant.store.test.makeClone")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-plant-store-" });
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

const storeHarness = (workspaceRoot: string) => {
  const project = {
    id: projectId,
    title: "Plant store",
    workspaceRoot,
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    deletedAt: null,
  } as ProjectRecord;
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "project-plant-store" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({ fallbackModelSelection: null });
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    getByWorkspaceRoot: () => Effect.succeedSome(project),
  });
  const layerProviders = ProviderRegistryMock.layer();
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        layerProjects,
        Layer.mock(GitWorkflow.GitWorkflowService)({
          repositoryRoot: () => Effect.succeed(workspaceRoot),
          createWorktree: (input) =>
            Effect.succeed({
              worktree: { path: `${workspaceRoot}-worktree`, refName: input.newRefName },
            } as never),
          fetchWorktreeBaseCommit: () =>
            Effect.succeed({ commitSha: "remote-trunk-sha", remoteRefName: "upstream/trunk" }),
          hasCommit: () => Effect.succeed(false),
          resolveWorktreeBaseRemote: () =>
            Effect.succeed({ remoteName: "upstream", branchName: "trunk" }),
          remoteExists: () => Effect.succeed(true),
          remoteBranchExists: () => Effect.succeed(true),
          listLocalBranchNames: () => Effect.succeed([]),
        }),
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
          generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
        }),
        layerServerSettings,
        layerProviders,
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
          folderForThread: () => Effect.succeedNone,
        }),
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerPlant = ProjectPlant.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerLaunch,
        layerThreadManagement,
        layerProjects,
        layerServerSettings,
        layerProviders,
      ),
    ),
    Layer.provide(gitLayer),
  );
  return Layer.mergeAll(layerPlant, layerThreadManagement);
};

it.live("after a real delete of the plant thread, Plant starts a second thread and reuses it", () =>
  Effect.gen(function* () {
    const clone = yield* makeClone();
    yield* Effect.gen(function* () {
      const plant = yield* ProjectPlant.ProjectPlant;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const start = plant.start({
        projectId,
        action: "plant",
        createdBy: "user",
        creationSource: "web",
      });

      const first = yield* start;
      expect(first.reused).toBe(false);
      expect((yield* threads.getThreadShell(first.threadId))?.deletedAt).toBeNull();
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:plant-store:delete"),
        threadId: first.threadId,
      });
      expect(yield* threads.getThreadShell(first.threadId)).toBeNull();

      const replacement = yield* start;
      expect(replacement.reused).toBe(false);
      expect(replacement.threadId).not.toBe(first.threadId);
      const replacementShell = yield* threads.getThreadShell(replacement.threadId);
      expect(replacementShell).not.toBeNull();
      expect(replacementShell?.deletedAt).toBeNull();
      expect(yield* plant.readStatus({ projectId })).toEqual({
        _tag: "not_planted",
        openThread: { threadId: replacement.threadId },
      });
      expect(yield* start).toEqual({ threadId: replacement.threadId, reused: true });
    }).pipe(Effect.provide(storeHarness(clone)));
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.live("an archived plant thread is still the open thread, marked archived", () =>
  Effect.gen(function* () {
    const clone = yield* makeClone();
    yield* Effect.gen(function* () {
      const plant = yield* ProjectPlant.ProjectPlant;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const start = plant.start({
        projectId,
        action: "plant",
        createdBy: "user",
        creationSource: "web",
      });

      const first = yield* start;
      expect(yield* plant.readStatus({ projectId })).toStrictEqual({
        _tag: "not_planted",
        openThread: { threadId: first.threadId },
      });
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:plant-store:archive"),
        threadId: first.threadId,
      });
      expect(yield* plant.readStatus({ projectId })).toStrictEqual({
        _tag: "not_planted",
        openThread: { threadId: first.threadId, archived: true },
      });
      expect(yield* start).toEqual({ threadId: first.threadId, reused: true });
    }).pipe(Effect.provide(storeHarness(clone)));
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);
