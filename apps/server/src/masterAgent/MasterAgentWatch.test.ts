import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestLink,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MasterAgentStore from "../persistence/MasterAgentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MasterAgentWatch from "./MasterAgentWatch.ts";

const MASTER = ThreadId.make("thread-master");
const now = DateTime.makeUnsafe("2026-11-17T00:00:00.000Z");

type Status = OrchestrationV2Run["status"];
interface FakeThread {
  title: string;
  deleted?: boolean;
  status: Status;
  prWatching?: boolean;
  programRunning?: boolean;
  needsYou?: boolean;
  checksWake?: Status;
  lastMessage?: string;
}

const run = (threadId: ThreadId, status: Status) =>
  ({
    id: `run-${threadId}`,
    threadId,
    ordinal: 1,
    status,
    userMessageId: `message-${threadId}`,
    activeAttemptId: null,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    modelSelection: { instanceId: "codex", model: "gpt" },
  }) as unknown as OrchestrationV2Run;

const prLink = (watching: boolean) =>
  ({
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    source: "agent",
    linkedAt: "2026-11-17T00:00:00.000Z",
    snapshot: null,
    stack: null,
    ...(watching ? { watch: { startedAt: "2026-11-17T00:00:00.000Z" } } : {}),
  }) as unknown as ThreadPullRequestLink;

function makeFake() {
  const threads = new Map<ThreadId, FakeThread>();
  const dispatched: Array<{ readonly commandId: string; readonly text: string }> = [];
  const seen = new Set<string>();
  let crashAfterNextDispatch = false;

  const records = (threadId: ThreadId): Partial<OrchestrationV2ThreadProjection> => {
    const thread = threads.get(threadId);
    if (thread === undefined) return { runs: [] };
    const runs = [run(threadId, thread.status)];
    const wake = {
      ...run(threadId, thread.checksWake ?? "running"),
      id: `wake-${threadId}`,
      ordinal: 2,
    } as OrchestrationV2Run;
    if (thread.checksWake !== undefined) runs.push(wake);
    return {
      runs,
      messages: [
        ...(thread.checksWake !== undefined
          ? [
              {
                id: `checks-${threadId}`,
                threadId,
                runId: wake.id,
                role: "user",
                text: "Checks failed.",
                notification: { source: { kind: "monitor" }, outcome: "failed", summary: "#7" },
              } as unknown as OrchestrationV2ThreadProjection["messages"][number],
            ]
          : []),
        ...(thread.lastMessage === undefined
          ? []
          : [
              {
                id: `answer-${threadId}`,
                threadId,
                runId: runs.at(-1)!.id,
                role: "assistant",
                text: thread.lastMessage,
                createdAt: now,
                updatedAt: now,
              } as unknown as OrchestrationV2ThreadProjection["messages"][number],
            ]),
      ],
      turnItems: [],
      providerTurns: [],
      subagents: [],
      providerThreads: thread.programRunning
        ? ([
            { pendingBackgroundTasks: [{ taskId: "build", kind: "command" }] },
          ] as unknown as OrchestrationV2ThreadProjection["providerThreads"])
        : [],
      runtimeRequests: thread.needsYou
        ? ([{ status: "pending" }] as unknown as OrchestrationV2ThreadProjection["runtimeRequests"])
        : [],
    };
  };

  const layer = Layer.mock(Orchestrator.OrchestratorV2)({
    isMasterAgentThread: (threadId) => Effect.succeed(threadId === MASTER),
    getThreadShell: (threadId) => {
      const thread = threads.get(threadId);
      return Effect.succeed(
        thread === undefined || thread.deleted
          ? null
          : ({
              id: threadId,
              title: thread.title,
              deletedAt: null,
              archivedAt: null,
              pullRequests: thread.prWatching === undefined ? [] : [prLink(thread.prWatching)],
            } as unknown as OrchestrationV2ThreadShell),
      );
    },
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter?: { runStatuses?: ReadonlyArray<Status> },
    ) => {
      const found = records(threadId);
      const runs = (found.runs ?? []).filter(
        (candidate) =>
          filter?.runStatuses === undefined || filter.runStatuses.includes(candidate.status),
      );
      return Effect.succeed({ ...found, runs });
    }) as unknown as Orchestrator.OrchestratorV2["Service"]["getThreadRecords"],
    delegatedTaskResultPending: () => Effect.succeed(false),
    streamDomainEvents: Stream.never,
    dispatch: (command) =>
      Effect.suspend(() => {
        if (command.type !== "message.dispatch") return Effect.die("unexpected command");
        if (!seen.has(command.commandId)) {
          seen.add(command.commandId);
          dispatched.push({ commandId: command.commandId, text: command.text });
        }
        if (crashAfterNextDispatch) {
          crashAfterNextDispatch = false;
          return Effect.die("crashed after the notice committed");
        }
        return Effect.succeed({} as Orchestrator.OrchestratorV2DispatchResult);
      }),
  });

  return {
    threads,
    dispatched,
    layer,
    crashAfterNextDispatch: () => {
      crashAfterNextDispatch = true;
    },
  };
}

const withService = <A, E>(
  fake: ReturnType<typeof makeFake>,
  body: (input: {
    readonly start: () => Effect.Effect<MasterAgentWatch.MasterAgentWatch["Service"]>;
  }) => Effect.Effect<A, E, MasterAgentStore.MasterAgentStore>,
) =>
  Effect.gen(function* () {
    const store = yield* MasterAgentStore.MasterAgentStore;
    yield* store.claimThreadId(MASTER);
    // Each start is a fresh server process over the same database.
    const start = () =>
      MasterAgentWatch.make.pipe(
        Effect.provideService(MasterAgentStore.MasterAgentStore, store),
        Effect.provide(Layer.merge(fake.layer, NodeCrypto.layer)),
        Effect.orDie,
      );
    return yield* body({ start });
  }).pipe(
    Effect.provide(
      MasterAgentStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");

it.effect("tracks a thread the agent starts with no extra call, never one the owner starts", () => {
  const fake = makeFake();
  return withService(fake, ({ start }) =>
    Effect.gen(function* () {
      const watches = yield* start();
      fake.threads.set(A, { title: "Agent's", status: "running" });
      fake.threads.set(B, { title: "Owner's", status: "running" });
      yield* watches.watch({ callerThreadId: MASTER, threadId: A });
      yield* watches.watch({ callerThreadId: undefined, threadId: B });
      yield* watches.watch({ callerThreadId: ThreadId.make("thread-other"), threadId: B });
      const list = yield* watches.list.pipe(Effect.orDie);
      assert.deepStrictEqual(
        list.map((watch) => watch.threadId),
        [A],
      );
    }),
  );
});

it.effect(
  "notifies once when the thread settles, not while it waits on checks or a program",
  () => {
    const fake = makeFake();
    return withService(fake, ({ start }) =>
      Effect.gen(function* () {
        const watches = yield* start();
        fake.threads.set(A, { title: "Fix login", status: "running", lastMessage: "Shipped." });
        yield* watches.watch({ callerThreadId: MASTER, threadId: A });

        const stateAfterCheck = Effect.gen(function* () {
          yield* watches.check;
          return (yield* watches.list.pipe(Effect.orDie)).map((watch) => watch.state);
        });

        assert.deepStrictEqual(yield* stateAfterCheck, ["working"]);
        fake.threads.set(A, { ...fake.threads.get(A)!, status: "completed", prWatching: true });
        assert.deepStrictEqual(yield* stateAfterCheck, ["in_checks"]);
        // Checks failed: the watch ends and its wake run starts in the same step.
        fake.threads.set(A, {
          ...fake.threads.get(A)!,
          prWatching: false,
          checksWake: "running",
        });
        assert.deepStrictEqual(yield* stateAfterCheck, ["working"]);
        fake.threads.set(A, {
          ...fake.threads.get(A)!,
          checksWake: "failed",
          programRunning: true,
        });
        assert.deepStrictEqual(yield* stateAfterCheck, ["waiting_on_tasks"]);
        assert.strictEqual(fake.dispatched.length, 0);

        fake.threads.set(A, { ...fake.threads.get(A)!, programRunning: false });
        assert.deepStrictEqual(yield* stateAfterCheck, []);
        yield* watches.check;
        assert.strictEqual(fake.dispatched.length, 1);
        assert.include(fake.dispatched[0]!.text, "Fix login");
        assert.include(fake.dispatched[0]!.text, "Shipped.");
        assert.include(fake.dispatched[0]!.text, "pull/7");
        assert.include(fake.dispatched[0]!.text, " failed.");
      }),
    );
  },
);

it.effect("says a thread needs the owner, then still reports how it ends", () => {
  const fake = makeFake();
  return withService(fake, ({ start }) =>
    Effect.gen(function* () {
      const watches = yield* start();
      fake.threads.set(A, { title: "Deploy", status: "running", needsYou: true });
      yield* watches.watch({ callerThreadId: MASTER, threadId: A });
      yield* watches.check;
      yield* watches.check;
      assert.strictEqual(fake.dispatched.length, 1);
      assert.include(fake.dispatched[0]!.text, "waiting for the owner");
      assert.deepStrictEqual(
        (yield* watches.list.pipe(Effect.orDie)).map((watch) => watch.state),
        ["needs_you"],
      );

      fake.threads.set(A, { title: "Deploy", status: "running" });
      yield* watches.check;
      fake.threads.set(A, { title: "Deploy", status: "completed" });
      yield* watches.check;
      assert.strictEqual(fake.dispatched.length, 2);
      assert.include(fake.dispatched[1]!.text, "Deploy");
      assert.include(fake.dispatched[1]!.text, "finished");
      assert.deepStrictEqual(yield* watches.list.pipe(Effect.orDie), []);
    }),
  );
});

it.effect("holds notices while the agent is mid-turn and delivers them as one", () => {
  const fake = makeFake();
  return withService(fake, ({ start }) =>
    Effect.gen(function* () {
      const watches = yield* start();
      fake.threads.set(MASTER, { title: "Agent", status: "running" });
      fake.threads.set(A, { title: "First", status: "running" });
      fake.threads.set(B, { title: "Second", status: "running" });
      yield* watches.watch({ callerThreadId: MASTER, threadId: A });
      yield* watches.watch({ callerThreadId: MASTER, threadId: B });

      fake.threads.set(A, { title: "First", status: "completed" });
      fake.threads.set(B, { title: "Second", status: "failed" });
      yield* watches.check;
      assert.strictEqual(fake.dispatched.length, 0);
      assert.deepStrictEqual(
        (yield* watches.list.pipe(Effect.orDie)).map((watch) => watch.state),
        ["done", "done"],
      );

      fake.threads.set(MASTER, { title: "Agent", status: "completed" });
      yield* watches.check;
      assert.strictEqual(fake.dispatched.length, 1);
      assert.include(fake.dispatched[0]!.text, "First");
      assert.include(fake.dispatched[0]!.text, "Second");
    }),
  );
});

it.effect("a restart neither loses a watch nor repeats a notice", () => {
  const fake = makeFake();
  return withService(fake, ({ start }) =>
    Effect.gen(function* () {
      const before = yield* start();
      fake.threads.set(MASTER, { title: "Agent", status: "running" });
      fake.threads.set(A, { title: "Long job", status: "running" });
      yield* before.watch({ callerThreadId: MASTER, threadId: A });
      fake.threads.set(A, { title: "Long job", status: "completed" });
      yield* before.check;

      fake.threads.set(MASTER, { title: "Agent", status: "completed" });
      fake.crashAfterNextDispatch();
      const crashed = yield* start();
      yield* crashed.check;
      assert.strictEqual(fake.dispatched.length, 1);

      const after = yield* start();
      yield* after.check;
      yield* after.check;
      assert.strictEqual(fake.dispatched.length, 1);
      assert.include(fake.dispatched[0]!.text, "Long job");
      assert.deepStrictEqual(yield* after.list.pipe(Effect.orDie), []);
    }),
  );
});
