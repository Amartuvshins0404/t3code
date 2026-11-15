import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProjectPlantError,
  type Project as ProjectRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ProjectPlant from "../../../project/ProjectPlant.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:plant-handlers");

const harness = (input: { readonly planMode?: true; readonly statusFails?: true }) => {
  const started: Array<Parameters<ProjectPlant.ProjectPlant["Service"]["start"]>[0]> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: "auto",
        ...(input.planMode ? { narrowedTo: { runtimeMode: "auto", interactionMode: "plan" } } : {}),
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ProjectPlant.ProjectPlant)({
      readStatus: () =>
        input.statusFails
          ? Effect.fail(new ProjectPlantError({ projectId, reason: "project_not_found" }))
          : Effect.succeed({ _tag: "not_planted", openThread: null }),
      start: (request) => {
        started.push(request);
        return Effect.succeed({ threadId: ThreadId.make("thread:plant"), reused: false });
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some<ProjectRecord>({
                id,
                title: "Plant handlers",
                workspaceRoot: "/projects/plant",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-14T00:00:00.000Z",
                updatedAt: "2026-11-14T00:00:00.000Z",
                deletedAt: null,
              } as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
    Layer.mock(Repositories.SourceControlRepositoryService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(DocumentText.DocumentText)({}),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-plant-handlers-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return { started, dependencies };
};

const toolkitWith = (dependencies: ReturnType<typeof harness>["dependencies"]) =>
  ProjectToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );

it.effect("a plan-mode caller's plant starts in plan mode", () =>
  Effect.gen(function* () {
    const { started, dependencies } = harness({ planMode: true });
    const toolkit = yield* toolkitWith(dependencies);
    yield* toolkit
      .handle("t3_project_plant", { projectId, action: "plant" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(started.map((request) => request.interactionMode)).toEqual(["plan"]);
  }),
);

it.effect("reading a project still answers when its plant status cannot be read", () =>
  Effect.gen(function* () {
    const { dependencies } = harness({ statusFails: true });
    const toolkit = yield* toolkitWith(dependencies);
    const result = yield* toolkit
      .handle("t3_project_read", { projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      id: projectId,
      plant: { _tag: "unavailable", reason: "read_failed" },
    });
  }),
);
