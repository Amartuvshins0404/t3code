import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { withCreationProvenance } from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "team-projects" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const teamProject = ProjectId.make("project:team");
const at = "2026-11-15T00:00:00.000Z";
const projectEvent = {
  aggregateKind: "project" as const,
  aggregateId: teamProject,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 1,
};

const create = (
  threadId: ThreadId,
  extra: Partial<Extract<OrchestrationV2Command, { readonly type: "thread.create" }>> = {},
): Extract<OrchestrationV2Command, { readonly type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId: teamProject,
  title: threadId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  ...extra,
});

const shareTeamProject = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    ...projectEvent,
    eventId: EventId.make("event:project-created"),
    type: "project.created",
    payload: {
      projectId: teamProject,
      title: "Team",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  yield* projects.apply({
    ...projectEvent,
    sequence: 2,
    eventId: EventId.make("event:project-shared"),
    type: "project.meta-updated",
    payload: {
      projectId: teamProject,
      teamShare: {
        organizationId: "org-a",
        sharedAt: at,
        modelSelection,
        runtimeMode: "full-access",
      },
      updatedAt: at,
    },
  });
});

const createdShare = (result: Orchestrator.OrchestratorV2DispatchResult) => {
  const created = result.storedEvents.find((stored) => stored.event.type === "thread.created");
  assert.isDefined(created);
  return created.event.type === "thread.created" ? created.event.payload.teamShare : undefined;
};

const threadIn = (name: string, shared: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch(create(threadId));
    if (!shared) {
      yield* orchestrator.dispatch({
        type: "thread.team-share.clear",
        commandId: CommandId.make(`unshare:${name}`),
        threadId,
      });
    }
    return threadId;
  });

const shareOf = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadShell(threadId)),
    Effect.map((thread) => thread?.teamShare?.organizationId ?? null),
  );

const forkOf = (sourceThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`${sourceThreadId}:run`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${sourceThreadId}:run`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`${sourceThreadId}:message`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    const targetThreadId = ThreadId.make(`${sourceThreadId}:fork`);
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`fork:${sourceThreadId}`),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId },
      createdBy: "user",
      creationSource: "web",
    });
    return targetThreadId;
  });

const subagentOf = (parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start:${parentThreadId}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`${parentThreadId}:start`),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0];
    assert.isDefined(parentRun);
    assert.isNotNull(parentRun.rootNodeId);
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${parentThreadId}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId,
      task: "Research the private plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]
      ?.childThreadId;
    assert.isDefined(childThreadId);
    assert.isNotNull(childThreadId);
    return childThreadId;
  });

it.layer(layerTest)("threads created in a team project", (it) => {
  it.effect("a thread the host launches the normal way is shared from its first event", () =>
    Effect.gen(function* () {
      yield* shareTeamProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fromClient = withCreationProvenance(
        create(ThreadId.make("thread:host"), {
          teamShare: { organizationId: "org-evil", access: "steer" },
        }),
        { createdBy: "user", creationSource: "web" },
      );
      const result = yield* orchestrator.dispatch(fromClient);
      assert.deepEqual(createdShare(result), {
        organizationId: "org-a",
        access: "steer",
        sharedAt: createdShare(result)?.sharedAt ?? "",
      });
    }),
  );

  it.effect("an agent conversation keeps its agent mark", () =>
    Effect.gen(function* () {
      yield* shareTeamProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const agent = { startedBy: { userId: "user-bo", name: "Bo" } };
      const result = yield* orchestrator.dispatch(
        create(ThreadId.make("thread:agent"), {
          runtimeMode: "approval-required",
          teamShare: { organizationId: "org-b", access: "steer", agent },
        }),
      );
      const share = createdShare(result);
      assert.equal(share?.organizationId, "org-b");
      assert.deepEqual(share?.agent, agent);
    }),
  );

  it.effect("a fork takes its share from its source, not from the project", () =>
    Effect.gen(function* () {
      yield* shareTeamProject;
      const privateFork = yield* forkOf(yield* threadIn("fork-private", false));
      assert.isNull(yield* shareOf(privateFork));
      const sharedFork = yield* forkOf(yield* threadIn("fork-shared", true));
      assert.equal(yield* shareOf(sharedFork), "org-a");
    }),
  );

  it.effect("a subagent takes its share from its parent, not from the project", () =>
    Effect.gen(function* () {
      yield* shareTeamProject;
      const privateChild = yield* subagentOf(yield* threadIn("subagent-private", false));
      assert.isNull(yield* shareOf(privateChild));
      const sharedChild = yield* subagentOf(yield* threadIn("subagent-shared", true));
      assert.equal(yield* shareOf(sharedChild), "org-a");
    }),
  );

  it.effect("a task delegated from another environment stays private", () =>
    Effect.gen(function* () {
      yield* shareTeamProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const result = yield* orchestrator.dispatch(
        create(ThreadId.make("thread:remote-child"), {
          createdBy: "agent",
          creationSource: "mcp",
          linkOrigin: { sessionId: "session-laptop", label: "Laptop" },
          delegatedFrom: {
            environmentId: EnvironmentId.make("environment:laptop"),
            threadId: ThreadId.make("thread:laptop-private"),
            title: "Private plan",
          },
        }),
      );
      assert.isNull(createdShare(result) ?? null);
    }),
  );
});
