import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UserInputQuestion,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  PullRequestOperationError,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as QuestionAutoAnswerWorker from "./QuestionAutoAnswerWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:auto-answer");
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for answering questions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "question-auto-answer" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const startMs = Date.parse("2026-11-14T09:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offsetMs: number) => DateTime.makeUnsafe(startMs + offsetMs);

const question = (
  id: string,
  options: OrchestrationV2UserInputQuestion["options"],
  multiSelect?: boolean,
): OrchestrationV2UserInputQuestion => ({
  id,
  header: `Header ${id}`,
  question: `Which ${id} should we use?`,
  options,
  ...(multiSelect === undefined ? {} : { multiSelect }),
});
const option = (label: string, value?: string) => ({
  label,
  description: `${label} description`,
  ...(value === undefined ? {} : { value }),
});
const recommendedQuestion = (id: string) =>
  question(id, [option("Keep going (Recommended)"), option("Stop")]);

const seedThread = Effect.fn("test.seedThread")(function* (
  name: string,
  lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  } = { parentThreadId: null, relationshipToParent: null },
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(`thread:${name}`);
  const sessionId = ProviderSessionId.make(`session:${name}`);
  const now = at(0);
  yield* eventSink.write({
    commandId: CommandId.make(`seed-thread:${name}`),
    events: [
      {
        id: EventId.make(`event:${name}:thread`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: name,
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: lineage.parentThreadId,
            relationshipToParent: lineage.relationshipToParent,
            rootThreadId: lineage.parentThreadId ?? threadId,
          },
          forkedFrom:
            lineage.relationshipToParent === "subagent"
              ? { type: "node", nodeId: NodeId.make(`node:task:${name}`) }
              : null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
    ],
  });
  return { threadId, sessionId };
});

const attachSession = Effect.fn("test.attachSession")(function* (thread: {
  readonly threadId: ThreadId;
  readonly sessionId: ProviderSessionId;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = at(0);
  yield* eventSink.write({
    commandId: CommandId.make(`seed-session:${thread.sessionId}`),
    events: [
      {
        id: EventId.make(`event:${thread.sessionId}`),
        type: "provider-session.attached",
        threadId: thread.threadId,
        occurredAt: now,
        payload: {
          id: thread.sessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      },
    ],
  });
});

const liveThread = Effect.fn("test.liveThread")(function* (
  name: string,
  lineage?: Parameters<typeof seedThread>[1],
) {
  const thread = yield* seedThread(name, lineage);
  yield* attachSession(thread);
  return thread;
});

const seedRequest = Effect.fn("test.seedRequest")(function* (input: {
  readonly thread: { readonly threadId: ThreadId; readonly sessionId: ProviderSessionId };
  readonly name: string;
  readonly questions?: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly approvalOptions?: ReadonlyArray<string>;
  readonly createdAtMs?: number;
  readonly mode?: "live" | "message";
  readonly status?: "pending" | "expired" | "cancelled";
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = input.thread.threadId;
  const ordinal = (yield* projections.getThreadProjection(threadId)).turnItems.length + 1;
  const requestId = RuntimeRequestId.make(`request:${input.name}`);
  const nodeId = NodeId.make(`node:${input.name}`);
  const createdAt = at(input.createdAtMs ?? 0);
  const isQuestion = input.approvalOptions === undefined;
  const status = input.status ?? "pending";
  const itemBase = {
    id: TurnItemId.make(`item:${input.name}`),
    threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: status === "pending" ? ("waiting" as const) : ("cancelled" as const),
    title: null,
    startedAt: createdAt,
    completedAt: null,
    updatedAt: createdAt,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`event:${input.name}:request`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: isQuestion ? "user_input" : "command",
        status,
        responseCapability:
          input.mode === "message"
            ? { type: "message" }
            : { type: "live", providerSessionId: input.thread.sessionId },
        createdAt,
        resolvedAt: status === "pending" ? null : createdAt,
      },
    },
    {
      id: EventId.make(`event:${input.name}:node`),
      type: "node.updated",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: isQuestion ? "user_input_request" : "approval_request",
        status: status === "pending" ? "waiting" : "cancelled",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: createdAt,
        completedAt: null,
      },
    },
    {
      id: EventId.make(`event:${input.name}:item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: createdAt,
      payload: isQuestion
        ? {
            ...itemBase,
            type: "user_input_request",
            requestId,
            questions: input.questions ?? [recommendedQuestion(`${input.name}-q`)],
            ...(input.mode === "message" ? { responseMode: "message" as const } : {}),
          }
        : {
            ...itemBase,
            type: "approval_request",
            requestId,
            requestKind: "command",
            prompt: "Run the migration?",
            options: (input.approvalOptions ?? []).map((label, index) => ({
              decision: index === 0 ? ("accept" as const) : ("decline" as const),
              label,
            })),
          },
    },
  ];
  yield* eventSink.write({ commandId: CommandId.make(`seed-request:${input.name}`), events });
  return requestId;
});

type PullRequestReads = Partial<PullRequestService.PullRequestService["Service"]>;

const startWorker = Effect.fn("test.startWorker")(function* (
  options: {
    readonly pullRequests?: PullRequestReads;
    readonly env?: Record<string, string>;
  } = {},
) {
  const sweeps: Array<Effect.Effect<void>> = [];
  const scheduler = Scheduler.Scheduler.of({
    register: <E, R>(_name: string, runDueWork: Effect.Effect<void, E, R>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R | Scope.Scope>();
        sweeps.push(
          runDueWork.pipe(
            Effect.provideContext(context),
            Effect.catchCause((cause) => Effect.logWarning("sweep failed", { cause })),
          ),
        );
      }),
  });
  yield* Layer.build(
    QuestionAutoAnswerWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Scheduler.Scheduler, scheduler),
          Layer.mock(PullRequestService.PullRequestService)(options.pullRequests ?? {}),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })),
        ),
      ),
    ),
  );
  assert.equal(sweeps.length, 1);
  return sweeps[0]!;
});

const sweepAt = Effect.fn("test.sweepAt")(function* (sweep: Effect.Effect<void>, offsetMs: number) {
  yield* TestClock.setTime(startMs + offsetMs);
  yield* sweep;
});

const threadEvents = Effect.fn("test.threadEvents")(function* (threadId: ThreadId) {
  const eventStore = yield* EventStore.EventStoreV2;
  return Array.from(yield* Stream.runCollect(eventStore.read({ threadId })));
});

const decidedNotices = Effect.fn("test.decidedNotices")(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projection = yield* projections.getThreadProjection(threadId);
  return projection.turnItems.flatMap((item) =>
    item.type === "system_notice" && item.message.startsWith("Decided for you:")
      ? [item.message]
      : [],
  );
});

const answerOf = Effect.fn("test.answerOf")(function* (
  thread: { readonly threadId: ThreadId },
  requestId: RuntimeRequestId,
) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const events = yield* threadEvents(thread.threadId);
  const resolved = events.filter(
    (stored) =>
      stored.event.type === "runtime-request.updated" &&
      stored.event.payload.id === requestId &&
      stored.event.payload.status !== "pending",
  );
  if (resolved.length === 0) return undefined;
  assert.equal(resolved.length, 1, `request ${requestId} settled more than once`);
  const [stored] = resolved;
  const commandId = stored!.commandId;
  assert.isNotNull(commandId);
  const notices = events.flatMap((candidate) =>
    candidate.commandId === commandId &&
    candidate.event.type === "turn-item.updated" &&
    candidate.event.payload.type === "system_notice"
      ? [candidate.event.payload.message]
      : [],
  );
  const sent = (yield* outbox.listByCommandId(commandId!)).flatMap((effect) =>
    effect.request.type === "runtime-request.respond" ? [effect.request] : [],
  );
  const payload = stored!.event.type === "runtime-request.updated" ? stored!.event.payload : null;
  return {
    commandId: commandId!,
    status: payload?.status,
    answers: payload?.answers,
    notices,
    sent,
  };
});

const assertServerAnswered = Effect.fn("test.assertServerAnswered")(function* (
  thread: { readonly threadId: ThreadId; readonly sessionId: ProviderSessionId },
  requestId: RuntimeRequestId,
  expected: {
    readonly answers: Record<string, string | ReadonlyArray<string>>;
    readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
    readonly labels: ReadonlyArray<string>;
  },
) {
  const answer = yield* answerOf(thread, requestId);
  assert.isDefined(answer, `request ${requestId} was not answered`);
  assert.equal(answer!.status, "resolved");
  assert.deepEqual(answer!.answers, expected.answers);
  assert.deepEqual(answer!.sent, [
    {
      type: "runtime-request.respond",
      providerSessionId: thread.sessionId,
      requestId,
      answers: expected.answers,
    },
  ]);
  assert.equal(answer!.notices.length, 1, "one notice in the answer's commit");
  const notice = answer!.notices[0]!;
  assert.isTrue(notice.startsWith("Decided for you:"), notice);
  for (const asked of expected.questions) {
    assert.isTrue(
      notice.includes(asked.question) || notice.includes(asked.header),
      `notice does not name ${asked.id}: ${notice}`,
    );
  }
  for (const label of expected.labels) {
    assert.include(notice, label);
  }
});

const assertLeftAlone = Effect.fn("test.assertLeftAlone")(function* (
  thread: { readonly threadId: ThreadId },
  requestId: RuntimeRequestId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  assert.isUndefined(yield* answerOf(thread, requestId), `request ${requestId} was answered`);
  assert.equal(
    (yield* projections.getRuntimeRequest(thread.threadId, requestId))?.status,
    "pending",
  );
});

const keepGoing = (name: string) => ({
  answers: { [`${name}-q`]: "Keep going (Recommended)" },
  questions: [recommendedQuestion(`${name}-q`)],
  labels: ["Keep going"],
});

it.effect(
  "answers a fully recommended question once it has waited exactly 10 minutes, then a younger one on a later sweep",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startMs);
      const thread = yield* liveThread("timing");
      const questions = [
        question("database", [
          option("SQLite"),
          option("Postgres (Recommended)", "pg"),
          option("MySQL (recommended)", "mysql"),
        ]),
        question(
          "checks",
          [option("Lint (Recommended)", "lint"), option("Types"), option("Tests (RECOMMENDED)")],
          true,
        ),
        question("release", [option("Wait"), option("Ship it (recommended)")]),
      ];
      const older = yield* seedRequest({ thread, name: "older", questions });
      const younger = yield* seedRequest({ thread, name: "younger", createdAtMs: 1 });
      const sweep = yield* startWorker();

      yield* sweepAt(sweep, 10 * MINUTE_MS - 1);
      yield* assertLeftAlone(thread, older);
      yield* assertLeftAlone(thread, younger);

      yield* sweepAt(sweep, 10 * MINUTE_MS);
      yield* assertServerAnswered(thread, older, {
        answers: {
          database: "pg",
          checks: ["lint", "Tests (RECOMMENDED)"],
          release: "Ship it (recommended)",
        },
        questions,
        labels: ["Postgres", "Lint", "Tests", "Ship it"],
      });
      yield* assertLeftAlone(thread, younger);

      yield* sweepAt(sweep, 10 * MINUTE_MS + 1);
      yield* assertServerAnswered(thread, younger, keepGoing("younger"));
      assert.equal((yield* decidedNotices(thread.threadId)).length, 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "answers only questions where every part has a recommended option and the answer can go live",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startMs);
      const thread = yield* liveThread("kinds");
      const answerable = yield* seedRequest({ thread, name: "answerable" });
      const approval = yield* seedRequest({
        thread,
        name: "approval",
        approvalOptions: ["Allow (Recommended)", "Deny"],
      });
      const partly = yield* seedRequest({
        thread,
        name: "partly",
        questions: [
          recommendedQuestion("partly-a"),
          question("partly-b", [option("Red"), option("Blue")]),
        ],
      });
      const afterRestart = yield* seedRequest({ thread, name: "after-restart", mode: "message" });
      const noSession = yield* seedThread("no-session");
      const orphaned = yield* seedRequest({ thread: noSession, name: "orphaned" });
      const sweep = yield* startWorker();

      yield* sweepAt(sweep, 10 * MINUTE_MS);

      yield* assertServerAnswered(thread, answerable, keepGoing("answerable"));
      yield* assertLeftAlone(thread, approval);
      yield* assertLeftAlone(thread, partly);
      yield* assertLeftAlone(thread, afterRestart);
      yield* assertLeftAlone(noSession, orphaned);
      assert.equal((yield* decidedNotices(thread.threadId)).length, 1);
      assert.deepEqual(yield* decidedNotices(noSession.threadId), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves archived, deleted and delegated child threads to someone else", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const open = yield* liveThread("open");
    const fork = yield* liveThread("fork", {
      parentThreadId: open.threadId,
      relationshipToParent: "fork",
    });
    const archived = yield* liveThread("archived");
    const deleted = yield* liveThread("deleted");
    const child = yield* liveThread("child", {
      parentThreadId: open.threadId,
      relationshipToParent: "subagent",
    });
    const requests = {
      open: yield* seedRequest({ thread: open, name: "open" }),
      fork: yield* seedRequest({ thread: fork, name: "fork" }),
      archived: yield* seedRequest({ thread: archived, name: "archived" }),
      deleted: yield* seedRequest({ thread: deleted, name: "deleted" }),
      child: yield* seedRequest({ thread: child, name: "child" }),
    };
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: archived.threadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: deleted.threadId,
    });
    const sweep = yield* startWorker();

    yield* sweepAt(sweep, 10 * MINUTE_MS);

    yield* assertServerAnswered(open, requests.open, keepGoing("open"));
    yield* assertServerAnswered(fork, requests.fork, keepGoing("fork"));
    yield* assertLeftAlone(archived, requests.archived);
    const afterDelete = yield* answerOf(deleted, requests.deleted);
    assert.equal(afterDelete?.status, "cancelled");
    assert.deepEqual(afterDelete?.sent, []);
    assert.deepEqual(afterDelete?.notices, []);
    yield* assertLeftAlone(child, requests.child);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "holds questions behind an open lane:red pull request and retries when labels cannot be read",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startMs);
      const eventSink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const linkPullRequest = Effect.fn("test.linkPullRequest")(function* (
        threadId: ThreadId,
        number: number,
        state: "open" | "closed",
      ) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`link-pr:${number}`),
          threadId,
          host: "github.com",
          repository: "owner/repo",
          number,
          url: `https://github.com/owner/repo/pull/${number}`,
          source: "manual",
        });
        yield* eventSink.write({
          commandId: CommandId.make(`seed-pr:${number}`),
          events: [
            {
              id: EventId.make(`event:pr:${number}`),
              type: "thread.pull-request-link-updated",
              threadId,
              occurredAt: at(0),
              payload: {
                host: "github.com",
                repository: "owner/repo",
                number,
                url: `https://github.com/owner/repo/pull/${number}`,
                source: "manual",
                linkedAt: DateTime.formatIso(at(0)),
                snapshot: {
                  state,
                  title: `Pull request ${number}`,
                  headBranch: `branch-${number}`,
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: DateTime.formatIso(at(0)),
                  syncedAt: DateTime.formatIso(at(0)),
                },
                stack: null,
              },
            },
          ],
        });
      });
      const red = yield* liveThread("red");
      const amber = yield* liveThread("amber");
      const closedRed = yield* liveThread("closed-red");
      const unreadable = yield* liveThread("unreadable");
      yield* linkPullRequest(red.threadId, 1, "open");
      yield* linkPullRequest(amber.threadId, 2, "open");
      yield* linkPullRequest(closedRed.threadId, 3, "closed");
      yield* linkPullRequest(unreadable.threadId, 4, "open");
      const requests = {
        red: yield* seedRequest({ thread: red, name: "red" }),
        amber: yield* seedRequest({ thread: amber, name: "amber" }),
        closedRed: yield* seedRequest({ thread: closedRed, name: "closed-red" }),
        unreadable: yield* seedRequest({ thread: unreadable, name: "unreadable" }),
      };
      const hosted = new Map<number, { state: "open" | "closed"; labels: Array<string> }>([
        [1, { state: "open", labels: ["lane:red"] }],
        [2, { state: "open", labels: ["lane:amber"] }],
        [3, { state: "closed", labels: ["lane:red"] }],
        [4, { state: "open", labels: ["lane:amber"] }],
      ]);
      let labelsReadable = false;
      const sweep = yield* startWorker({
        pullRequests: {
          detail: (ref) => {
            const pullRequest = hosted.get(ref.number);
            if (pullRequest === undefined || (ref.number === 4 && !labelsReadable)) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "detail",
                  detail: "The host did not answer.",
                }),
              );
            }
            return Effect.succeed({
              provider: "github",
              projectId: ref.projectId,
              repository: ref.repository,
              number: ref.number,
              title: `Pull request ${ref.number}`,
              url: `https://github.com/owner/repo/pull/${ref.number}`,
              state: pullRequest.state,
              isDraft: false,
              labels: pullRequest.labels.map((name) => ({ name, color: null })),
            } as never);
          },
        },
      });

      yield* sweepAt(sweep, 10 * MINUTE_MS);
      yield* assertLeftAlone(red, requests.red);
      yield* assertServerAnswered(amber, requests.amber, keepGoing("amber"));
      yield* assertServerAnswered(closedRed, requests.closedRed, keepGoing("closed-red"));
      yield* assertLeftAlone(unreadable, requests.unreadable);

      labelsReadable = true;
      yield* sweepAt(sweep, 11 * MINUTE_MS);
      yield* assertServerAnswered(unreadable, requests.unreadable, keepGoing("unreadable"));
      yield* assertLeftAlone(red, requests.red);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("answers a request once across overlapping and repeated sweeps", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const thread = yield* liveThread("once");
    const requestId = yield* seedRequest({ thread, name: "once" });
    const sweep = yield* startWorker();

    yield* TestClock.setTime(startMs + 10 * MINUTE_MS);
    yield* Effect.all([sweep, sweep, sweep], { concurrency: "unbounded" });
    yield* sweepAt(sweep, 20 * MINUTE_MS);

    yield* assertServerAnswered(thread, requestId, keepGoing("once"));
    assert.equal((yield* decidedNotices(thread.threadId)).length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a snoozed thread snoozed and leaves requests a user answered or that ended", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* liveThread("snoozed");
    const userAnswered = yield* seedRequest({ thread, name: "user-answered" });
    const waiting = yield* seedRequest({ thread, name: "waiting" });
    const expired = yield* seedRequest({ thread, name: "expired", status: "expired" });
    const cancelled = yield* seedRequest({ thread, name: "cancelled", status: "cancelled" });
    const sweep = yield* startWorker();

    yield* TestClock.setTime(startMs + 5 * MINUTE_MS);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("user-answer"),
      threadId: thread.threadId,
      requestId: userAnswered,
      answers: { "user-answered-q": "Stop" },
    });
    yield* TestClock.setTime(startMs + 6 * MINUTE_MS);
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("snooze"),
      threadId: thread.threadId,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const endedBefore = {
      expired: yield* projections.getRuntimeRequest(thread.threadId, expired),
      cancelled: yield* projections.getRuntimeRequest(thread.threadId, cancelled),
    };

    yield* sweepAt(sweep, 10 * MINUTE_MS);

    yield* assertServerAnswered(thread, waiting, keepGoing("waiting"));
    const user = yield* answerOf(thread, userAnswered);
    assert.equal(user?.commandId, CommandId.make("user-answer"));
    assert.deepEqual(user?.answers, { "user-answered-q": "Stop" });
    assert.deepEqual(user?.notices, []);
    assert.equal((yield* decidedNotices(thread.threadId)).length, 1);
    assert.deepEqual(
      {
        expired: yield* projections.getRuntimeRequest(thread.threadId, expired),
        cancelled: yield* projections.getRuntimeRequest(thread.threadId, cancelled),
      },
      endedBefore,
    );
    const resolvedLater = (yield* threadEvents(thread.threadId)).filter(
      (stored) =>
        stored.event.type === "runtime-request.updated" &&
        (stored.event.payload.id === expired || stored.event.payload.id === cancelled) &&
        stored.commandId !== CommandId.make("seed-request:expired") &&
        stored.commandId !== CommandId.make("seed-request:cancelled"),
    );
    assert.deepEqual(resolvedLater, []);
    const snoozedUntil = (yield* projections.getThread(thread.threadId)).snoozedUntil;
    assert.equal(
      snoozedUntil == null ? null : DateTime.formatIso(snoozedUntil),
      "2099-01-01T00:00:00.000Z",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("takes the wait from the server environment in minutes, and 0 turns it off", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const thread = yield* liveThread("env");
    const old = yield* seedRequest({ thread, name: "old" });
    const threeMinutes = yield* seedRequest({
      thread,
      name: "three",
      createdAtMs: 117 * MINUTE_MS,
    });
    const twoMinutes = yield* seedRequest({ thread, name: "two", createdAtMs: 118 * MINUTE_MS });
    const off = yield* startWorker({ env: { T3CODE_QUESTION_AUTO_ANSWER_MINUTES: "0" } });
    const three = yield* startWorker({ env: { T3CODE_QUESTION_AUTO_ANSWER_MINUTES: "3" } });

    yield* sweepAt(off, 120 * MINUTE_MS);
    yield* assertLeftAlone(thread, old);
    yield* assertLeftAlone(thread, threeMinutes);

    yield* sweepAt(three, 120 * MINUTE_MS);
    yield* assertServerAnswered(thread, old, keepGoing("old"));
    yield* assertServerAnswered(thread, threeMinutes, keepGoing("three"));
    yield* assertLeftAlone(thread, twoMinutes);
  }).pipe(Effect.provide(layerTest)),
);
