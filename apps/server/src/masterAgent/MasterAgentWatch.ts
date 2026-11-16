import {
  CommandId,
  type MasterAgentWatchList,
  type MasterAgentWatchState,
  MessageId,
  type OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MasterAgentStore from "../persistence/MasterAgentStore.ts";
import { forkParked } from "../serverActivation.ts";
import { watchNoticeLine, watchNoticeMessage, watchProgress } from "./masterAgentWatchProgress.ts";

const StoredNotice = Schema.fromJsonString(
  Schema.Struct({
    end: Schema.Literals(["completed", "failed", "interrupted", "cancelled", "needs_you", "gone"]),
    title: Schema.String,
    line: Schema.String,
  }),
);
const encodeNotice = Schema.encodeSync(StoredNotice);
const decodeNotice = Schema.decodeUnknownOption(StoredNotice);

const BUSY_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;
/** Threads finishing within this window of each other reach the agent as one notice. */
const GATHER = "1 second";
/** Catches what emits no thread event, such as a deleted thread. */
const SWEEP = "1 minute";

export class MasterAgentWatch extends Context.Service<
  MasterAgentWatch,
  {
    /** Watches `threadId` when the master agent thread started work in it. Never fails. */
    readonly watch: (input: {
      readonly callerThreadId: ThreadId | undefined;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly unwatch: (
      threadId: ThreadId,
    ) => Effect.Effect<void, MasterAgentStore.MasterAgentStoreError>;
    readonly list: Effect.Effect<MasterAgentWatchList, MasterAgentStore.MasterAgentStoreError>;
    readonly changes: Stream.Stream<MasterAgentWatchList>;
    /** One check of every watch and, when the agent thread is idle, one delivery. */
    readonly check: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/masterAgent/MasterAgentWatch") {}

/** @public */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const store = yield* MasterAgentStore.MasterAgentStore;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const wakeups = yield* Queue.sliding<void>(1);
  const listRef = yield* SubscriptionRef.make<MasterAgentWatchList>([]);
  const states = new Map<ThreadId, Exclude<MasterAgentWatchState, "done">>();
  const followed = new Set<string>();

  const toList = (rows: ReadonlyArray<MasterAgentStore.MasterAgentWatchRow>) =>
    rows.map((row) => ({
      threadId: row.threadId,
      startedAt: row.startedAt,
      state: row.notice !== null ? ("done" as const) : (states.get(row.threadId) ?? "working"),
    }));

  const publish = Effect.gen(function* () {
    const rows = yield* store.listWatches;
    const master = yield* store.readThreadId;
    followed.clear();
    if (master !== null) followed.add(master);
    for (const row of rows) followed.add(row.threadId);
    for (const threadId of states.keys())
      if (!rows.some((row) => row.threadId === threadId)) states.delete(threadId);
    yield* SubscriptionRef.set(listRef, toList(rows));
  });

  const lastMessage = Effect.fn("MasterAgentWatch.lastMessage")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const records = yield* engine.getThreadRecords(
      threadId,
      ["messages", "turnItems", "providerTurns"],
      {
        messageRunIds: [run.id],
        turnItemRunIds: [run.id],
        ...(run.activeAttemptId === null ? {} : { providerTurnAttemptIds: [run.activeAttemptId] }),
      },
    );
    return subagentResultForRun(records, run).text;
  });

  const evaluate = Effect.fn("MasterAgentWatch.evaluate")(function* (
    row: MasterAgentStore.MasterAgentWatchRow,
  ) {
    const shell = yield* engine.getThreadShell(row.threadId);
    const records =
      shell === null || shell.deletedAt != null
        ? { runs: [], messages: [], subagents: [], providerThreads: [], runtimeRequests: [] }
        : yield* engine.getThreadRecords(
            row.threadId,
            ["runs", "messages", "subagents", "providerThreads", "runtimeRequests"],
            {
              messageRoles: ["user"],
              monitorNotificationsOnly: true,
              runtimeRequestStatuses: ["pending"],
            },
          );
    let progress = watchProgress({ shell, records, resultPending: false });
    if (progress.state === "done" && progress.end !== "gone" && progress.end !== "needs_you") {
      const pending = yield* engine.delegatedTaskResultPending(row.threadId);
      if (pending) progress = watchProgress({ shell, records, resultPending: true });
    }
    if (progress.state !== "done") {
      states.set(row.threadId, progress.state);
      if (row.notice !== null) yield* store.setWatchNotice({ ...row, notice: null });
      return;
    }
    if (row.notice !== null) return;
    const title = shell?.title ?? "Thread";
    const message =
      progress.resultRun === undefined || progress.end === "gone" || progress.end === "needs_you"
        ? null
        : yield* lastMessage(row.threadId, progress.resultRun);
    const line = watchNoticeLine({
      threadId: row.threadId,
      title,
      end: progress.end,
      lastMessage: message,
      pullRequests: visibleThreadPullRequests(shell?.pullRequests ?? []).map((link) => ({
        number: link.number,
        url: link.url,
        state: link.snapshot?.state ?? null,
        checks: link.snapshot?.checksState ?? null,
      })),
    });
    yield* store.setWatchNotice({
      threadId: row.threadId,
      startedAt: row.startedAt,
      notice: encodeNotice({ end: progress.end, title, line }),
    });
  });

  const deliver = Effect.fn("MasterAgentWatch.deliver")(function* (master: ThreadId) {
    const { runs } = yield* engine.getThreadRecords(master, ["runs"], {
      runStatuses: [...BUSY_RUN_STATUSES],
    });
    if (runs.length > 0) return;
    const rows = yield* store.claimNoticeBatch(yield* random.uuidV4());
    const batchId = rows[0]?.batchId;
    if (batchId == null) return;
    const lines = rows.flatMap((row) => {
      const notice = decodeNotice(row.notice);
      return notice._tag === "Some" ? [notice.value] : [];
    });
    if (lines.length > 0) {
      const { text, notification } = watchNoticeMessage(lines);
      // Fixed ids: a restart before the batch is removed replays this command, not a second notice.
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`master-agent-watch:${batchId}`),
        threadId: master,
        messageId: MessageId.make(`message:master-agent-watch:${batchId}`),
        text,
        notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }
    yield* store.removeNoticeBatch(batchId);
  });

  const check: MasterAgentWatch["Service"]["check"] = Effect.gen(function* () {
    const rows = yield* store.listWatches;
    for (const row of rows) {
      if (row.batchId !== null) continue;
      yield* evaluate(row).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("master agent watch check failed", { threadId: row.threadId, cause }),
        ),
      );
    }
    const master = yield* store.readThreadId;
    if (master !== null) yield* deliver(master);
    yield* publish;
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("master agent watch pass failed", { cause })),
    lock.withPermits(1),
    Effect.withSpan("MasterAgentWatch.check"),
  );

  const watch: MasterAgentWatch["Service"]["watch"] = Effect.fn("MasterAgentWatch.watch")(
    function* (input) {
      if (input.callerThreadId === undefined || input.callerThreadId === input.threadId) return;
      if (!(yield* engine.isMasterAgentThread(input.callerThreadId))) return;
      yield* store.addWatch({
        threadId: input.threadId,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      });
      states.set(input.threadId, "working");
      yield* publish;
      yield* Queue.offer(wakeups, undefined);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("master agent watch could not start", { cause }),
    ),
  );

  const unwatch: MasterAgentWatch["Service"]["unwatch"] = Effect.fn("MasterAgentWatch.unwatch")(
    function* (threadId) {
      yield* store.removeWatch(threadId).pipe(lock.withPermits(1));
      yield* publish;
    },
  );

  const start: MasterAgentWatch["Service"]["start"] = () =>
    forkParked(
      Stream.mergeAll(
        [
          Stream.make(undefined),
          Stream.fromQueue(wakeups),
          engine.streamDomainEvents.pipe(
            Stream.filter((event) => followed.has(event.threadId)),
            Stream.map(() => undefined),
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                Effect.logWarning("master agent watch event stream failed", { cause }),
              ).pipe(Stream.drain),
            ),
          ),
          Stream.fromSchedule(Schedule.spaced(SWEEP)).pipe(Stream.map(() => undefined)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => Effect.sleep(GATHER).pipe(Effect.andThen(check))),
      ),
    );

  return MasterAgentWatch.of({
    watch,
    unwatch,
    list: store.listWatches.pipe(Effect.map(toList)),
    changes: SubscriptionRef.changes(listRef),
    check,
    start,
  });
});

export const layer = Layer.effect(MasterAgentWatch, make);

/** Tool layers built without the full server, as in their tests, start no watches. */
export const watchIfRunning = (input: {
  readonly callerThreadId: ThreadId | undefined;
  readonly threadId: ThreadId;
}) =>
  Effect.serviceOption(MasterAgentWatch).pipe(
    Effect.flatMap((service) =>
      Option.isSome(service) ? service.value.watch(input) : Effect.void,
    ),
  );
