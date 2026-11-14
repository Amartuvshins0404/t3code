import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const MINUTE_MS = 60_000;
const DUE_BATCH = 50;
const RETRY_MS = 60_000;
const LABEL_READ_TIMEOUT = "20 seconds";
const MAX_SEND_ATTEMPTS = 3;
const RECOMMENDED = /\(recommended\)$/i;

const waitMinutes = Config.Int("T3CODE_QUESTION_AUTO_ANSWER_MINUTES").pipe(Config.withDefault(10));

const isRecommended = (option: OrchestrationV2UserInputQuestion["options"][number]) =>
  RECOMMENDED.test(option.label.trimEnd());

const shownLabel = (option: OrchestrationV2UserInputQuestion["options"][number]) =>
  option.label.trimEnd().replace(RECOMMENDED, "").trimEnd() || option.label;

const recommendedAnswer = (questions: ReadonlyArray<OrchestrationV2UserInputQuestion>) => {
  if (questions.length === 0) return null;
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  const decided: Array<string> = [];
  for (const question of questions) {
    const recommended = question.options.filter(isRecommended);
    const first = recommended[0];
    if (first === undefined) return null;
    const chosen = question.multiSelect === true ? recommended : [first];
    const values = chosen.map((option) => option.value ?? option.label);
    answers[question.id] = question.multiSelect === true ? values : values[0]!;
    decided.push(
      `${question.question.trim() || question.header} → ${chosen.map(shownLabel).join(", ")}`,
    );
  }
  return { answers, notice: `Decided for you: ${decided.join("; ")}` };
};

const affectsDueQuestions = (event: OrchestrationV2DomainEvent) =>
  event.type === "runtime-request.updated" ||
  event.type.startsWith("thread.") ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "user_input_request");

const makeSweep = Effect.gen(function* () {
  const minutes = yield* waitMinutes.pipe(Effect.orDie);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const findDue = projections.getDueQuestionRequests;
  const waitMs = findDue === undefined ? 0 : minutes * MINUTE_MS;
  const due = DueHint.make();
  const failedSends = new Map<string, { readonly attempts: number; readonly retryAtMs: number }>();
  if (waitMs > 0) {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        affectsDueQuestions(event) ? due.invalidate : Effect.void,
      ),
    );
  }

  const laneHold = Effect.fn("QuestionAutoAnswerWorker.laneHold")(function* (
    thread: ProjectionStore.ProjectionDueQuestion["thread"],
  ) {
    const reads = yield* Effect.forEach(
      thread.pullRequests ?? [],
      (link) =>
        Effect.exit(
          pullRequests
            .detail({
              projectId: thread.projectId,
              host: normalizeThreadPullRequestKey(link).host,
              repository: link.repository,
              number: link.number,
              allowStale: false,
            })
            .pipe(Effect.timeout(LABEL_READ_TIMEOUT)),
        ),
      { concurrency: 4 },
    );
    const red = reads.some(
      (read) =>
        Exit.isSuccess(read) &&
        read.value.state === "open" &&
        read.value.labels.some((label) => label.name.toLowerCase() === "lane:red"),
    );
    if (red) return "held" as const;
    return reads.some(Exit.isFailure) ? ("unreadable" as const) : ("free" as const);
  });

  return Effect.fn("QuestionAutoAnswerWorker.sweep")(function* () {
    if (findDue === undefined || waitMs <= 0) return;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const { due: requests, nextCreatedAt } = yield* findDue({
      createdAtOrBefore: DateTime.makeUnsafe(nowMs - waitMs),
      limit: DUE_BATCH,
    });
    let acted = false;
    let wakeAt = nextCreatedAt === null ? Infinity : DateTime.toEpochMillis(nextCreatedAt) + waitMs;
    for (const request of requests) {
      const answer = recommendedAnswer(request.questions);
      if (answer === null) continue;
      const failed = failedSends.get(request.requestId);
      if (failed !== undefined) {
        if (failed.attempts >= MAX_SEND_ATTEMPTS) continue;
        if (failed.retryAtMs > nowMs) {
          wakeAt = Math.min(wakeAt, failed.retryAtMs);
          continue;
        }
      }
      const hold = yield* laneHold(request.thread);
      if (hold === "held") continue;
      if (hold === "unreadable") {
        wakeAt = Math.min(wakeAt, nowMs + RETRY_MS);
        continue;
      }
      const sent = yield* orchestrator
        .autoAnswerQuestion({
          commandId: CommandId.make(`question-auto-answer:${request.requestId}`),
          threadId: request.thread.id,
          requestId: request.requestId,
          answers: answer.answers,
          notice: answer.notice,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.question-auto-answer.dispatch-failed", {
              threadId: request.thread.id,
              requestId: request.requestId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (sent) {
        acted = true;
        failedSends.delete(request.requestId);
        continue;
      }
      const attempts = (failed?.attempts ?? 0) + 1;
      failedSends.set(request.requestId, { attempts, retryAtMs: nowMs + RETRY_MS });
      if (attempts < MAX_SEND_ATTEMPTS) wakeAt = Math.min(wakeAt, nowMs + RETRY_MS);
    }
    if (failedSends.size > 0 && requests.length < DUE_BATCH) {
      const stillDue = new Set<string>(requests.map((request) => request.requestId));
      for (const requestId of failedSends.keys()) {
        if (!stillDue.has(requestId)) failedSends.delete(requestId);
      }
    }
    if (acted || requests.length >= DUE_BATCH) return;
    yield* due.record(readVersion, wakeAt, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("question-auto-answer", sweep());
  }),
);
