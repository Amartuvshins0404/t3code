import {
  isListedThreadLineage,
  isProviderNativeSubagentThread,
  type MessageId,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
  type PlanId,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  /**
   * The run is still open, but its provider turn already ended, so nothing is
   * generating while the server settles it.
   */
  readonly turnEnded?: boolean;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly activityStartedAt?: string | null | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null;
  readonly lastErrorCode?: string | null;
  readonly usageLimitResetAt?: string | null;
  readonly updatedAt: string;
}

export type PendingSubagentRequest = "approval" | "user_input";

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveThreadActivityTimestamp(thread: {
  readonly latestUserMessageAt: string | null;
  readonly latestRun: Pick<ThreadRunSummary, "requestedAt" | "startedAt" | "completedAt"> | null;
  readonly updatedAt: string;
}): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt;
}

function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export function threadRuntimeIsActive(
  runtime: Pick<ThreadRuntimeSummary, "status"> | null | undefined,
): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);
const nullableIso = (value: DateTime.Utc | null) => (value === null ? null : iso(value));

function terminalRunStatus(status: OrchestrationV2RunStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

// Only work the agent waits on holds it: commands and monitors it left running
// unmarked, such as a dev server, present the run's own status. The
// server suppresses the roster while an interruptible activity run exists, so a
// remaining roster is stronger than checkpoint-oriented waiting.
function shellRuntime(thread: OrchestrationV2ThreadShell): ThreadRuntimeSummary | null {
  const parkAtIdle =
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
    thread.status !== "failed";
  if (thread.latestRunId === null && thread.activeProviderThreadId === null && !parkAtIdle) {
    return null;
  }
  const status = parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
  return {
    status,
    activeRunId: thread.activeRunId,
    activityStartedAt:
      thread.activityRunStartedAt === undefined
        ? undefined
        : nullableIso(thread.activityRunStartedAt),
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: thread.lastError ?? null,
    lastErrorClass: thread.lastErrorClass ?? null,
    lastErrorCode: thread.lastErrorCode ?? null,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    updatedAt: iso(thread.updatedAt),
  };
}

/** What a thread shell says about its work: its latest run, runtime and open requests. */
export function threadShellActivity(thread: OrchestrationV2ThreadShell) {
  const updatedAt = iso(thread.updatedAt);
  const latestRun: ThreadRunSummary | null =
    thread.latestRunId === null
      ? null
      : {
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt: nullableIso(thread.latestRunRequestedAt ?? null),
          startedAt: nullableIso(thread.latestRunStartedAt ?? null),
          completedAt:
            thread.latestRunCompletedAt === undefined
              ? thread.status === "idle" || terminalRunStatus(thread.status)
                ? updatedAt
                : null
              : nullableIso(thread.latestRunCompletedAt),
          assistantMessageId: null,
        };
  return {
    updatedAt,
    latestRun,
    runtime: shellRuntime(thread),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    // Async questions count too, so a thread with any open question leaves Working.
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    pendingUserInputAt:
      thread.pendingRuntimeRequest?.kind === "user_input"
        ? iso(thread.pendingRuntimeRequest.createdAt)
        : null,
  };
}

// An async question outlives the subagent's run, but once that run ends the
// parent is no longer waiting on the answer, so it stops counting as input.
// The activity run stays set when a follow-up is queued behind a blocked run;
// older servers omit it, so fall back to the latest run's status.
const isChildRunLive = (
  thread: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running" ||
      thread.status === "waiting";

/** Provider-native subagents ask on their parent, so they are skipped. */
export function subagentRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (
    kind === undefined ||
    kind === "auth_refresh" ||
    (thread.lineage.relationshipToParent !== "subagent" && thread.delegatedFrom === undefined) ||
    isProviderNativeSubagentThread(thread) ||
    !isChildRunLive(thread)
  ) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/** A side chat asks its user directly, so questions roll up to the parent as well as approvals. */
export function sideChatRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (kind === undefined || kind === "auth_refresh" || thread.lineage.sideChat !== true) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

const NO_SUBAGENT_REQUESTS: ReadonlyMap<ThreadId, PendingSubagentRequest> = new Map();

/**
 * The threads to flag for a subagent's live approval, up its
 * subagent chain and through a side chat to its parent. `delegated` are tasks this
 * environment's threads delegated to linked environments, with what each one, or its
 * own subagents, asks.
 */
export function pendingSubagentRequestsByThread(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  delegated: ReadonlyArray<{
    readonly parentThreadId: ThreadId;
    readonly request: PendingSubagentRequest;
  }> = [],
): ReadonlyMap<ThreadId, PendingSubagentRequest> {
  const requests = new Map<ThreadId, PendingSubagentRequest>();
  let byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> | undefined;
  const flag = (
    firstParentId: ThreadId | null,
    request: PendingSubagentRequest,
    seen: Set<ThreadId>,
  ) => {
    // The coordinator answers child questions; only approvals need user attention.
    if (request === "user_input") return;
    byId ??= new Map(threads.map((thread) => [thread.id, thread] as const));
    let parentId = firstParentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (requests.get(parentId) !== "approval") requests.set(parentId, request);
      const parent = byId.get(parentId);
      parentId =
        parent?.lineage.relationshipToParent === "subagent" || parent?.lineage.sideChat === true
          ? parent.lineage.parentThreadId
          : null;
    }
  };
  for (const child of threads) {
    const parentId = child.lineage.parentThreadId;
    if (child.lineage.sideChat === true) {
      const request = sideChatRequest(child);
      if (parentId !== null && request !== null && requests.get(parentId) !== "approval") {
        requests.set(parentId, request);
      }
      continue;
    }
    if (child.lineage.relationshipToParent !== "subagent") continue;
    const request = subagentRequest(child);
    if (request !== null) flag(parentId, request, new Set([child.id]));
  }
  for (const task of delegated) flag(task.parentThreadId, task.request, new Set());
  return requests.size === 0 ? NO_SUBAGENT_REQUESTS : requests;
}

export interface WorkingThreadInput {
  readonly hasActionableProposedPlan: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "status"> | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId" | "lastError"> | null;
}

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

export type ThreadAttentionReason =
  | "approval"
  | "question"
  | "subagent-request"
  | "guest-message"
  | "plan"
  | "error"
  | "failed-run";

export function threadAttentionReason(
  thread: WorkingThreadInput & { readonly pendingGuestMessageCount?: number },
): ThreadAttentionReason | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "question";
  if (thread.pendingSubagentRequest != null) return "subagent-request";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "guest-message";
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) return "plan";
  if (thread.runtime?.lastError != null) return "error";
  if (thread.latestRun?.status === "failed") return "failed-run";
  return null;
}

export interface ProjectBoardThread extends WorkingThreadInput {
  readonly id: string;
  /** Breaks ties between threads of different environments. */
  readonly environmentId?: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly source: Pick<OrchestrationV2ThreadShell, "teamShare">;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly pendingGuestMessageCount?: number;
  readonly pendingUserInputAt?: string | null;
  readonly latestRun:
    | (WorkingThreadInput["latestRun"] &
        Pick<ThreadRunSummary, "requestedAt" | "startedAt" | "completedAt">)
    | null;
  readonly latestUserMessageAt: string | null;
  readonly updatedAt: string;
}

export type ProjectBoardColumnId = "working" | "needs-you" | "in-checks" | "done";

export const PROJECT_BOARD_COLUMNS: ReadonlyArray<ProjectBoardColumnId> = [
  "working",
  "needs-you",
  "in-checks",
  "done",
];

export const PROJECT_BOARD_DONE_LIMIT = 30;

export const NEEDS_YOU_LIST_LIMIT = 5;

export type ProjectBoardReason =
  | ThreadAttentionReason
  | "running"
  | "pull-request-open"
  | "pull-request-merged"
  | "pull-request-closed"
  | "finished";

export interface ProjectBoardCard<T extends ProjectBoardThread> {
  readonly thread: T;
  readonly reason: ProjectBoardReason;
  readonly pullRequest: ThreadPullRequestLink | null;
  readonly activeAt: string | null;
}

export interface NeedsYouItem<T extends ProjectBoardThread> extends ProjectBoardCard<T> {
  readonly waitingSince: string | null;
}

export interface ProjectBoardColumn<T extends ProjectBoardThread> {
  readonly id: ProjectBoardColumnId;
  readonly total: number;
  readonly cards: ReadonlyArray<ProjectBoardCard<T>>;
}

interface Placement {
  readonly column: ProjectBoardColumnId;
  readonly reason: ProjectBoardReason;
  readonly pullRequest: ThreadPullRequestLink | null;
}

function isOnBoard(thread: ProjectBoardThread): boolean {
  return (
    thread.archivedAt == null &&
    thread.deletedAt == null &&
    thread.source.teamShare?.agent === undefined &&
    isListedThreadLineage(thread.lineage)
  );
}

function pullRequestState(pullRequest: ThreadPullRequestLink | null) {
  return pullRequest === null ? null : (pullRequest.snapshot?.state ?? "open");
}

function resolveWaitingSince(card: ProjectBoardCard<ProjectBoardThread>): string | null {
  const askedAt = card.thread.pendingUserInputAt;
  return askedAt != null && toSortableTimestamp(askedAt) !== null ? askedAt : card.activeAt;
}

function waitingMs(card: ProjectBoardCard<ProjectBoardThread>): number {
  return toSortableTimestamp(resolveWaitingSince(card) ?? undefined) ?? Number.MAX_SAFE_INTEGER;
}

function compareCardIdentity(
  left: ProjectBoardCard<ProjectBoardThread>,
  right: ProjectBoardCard<ProjectBoardThread>,
): number {
  return (
    left.thread.id.localeCompare(right.thread.id) ||
    (left.thread.environmentId ?? "").localeCompare(right.thread.environmentId ?? "")
  );
}

function needsYouGroup(card: ProjectBoardCard<ProjectBoardThread>): number {
  if (pullRequestState(card.pullRequest) === "open") return 0;
  const { thread } = card;
  if (thread.runtime?.lastError != null || thread.latestRun?.status === "failed") return 1;
  return 2;
}

/**
 * The Projects page's board. Clients and the server resolve a thread's current pull request
 * with their own source-control definitions, so they pass that in.
 */
export function makeProjectBoard(
  resolveCurrentPullRequest: (
    pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  ) => ThreadPullRequestLink | null,
) {
  const placeThread = (thread: ProjectBoardThread): Placement => {
    const pullRequest = resolveCurrentPullRequest(thread.pullRequests);
    const attention = threadAttentionReason(thread);
    if (attention !== null) return { column: "needs-you", reason: attention, pullRequest };
    if (isThreadWorking(thread)) return { column: "working", reason: "running", pullRequest };
    const state = pullRequestState(pullRequest);
    if (state === "open") return { column: "in-checks", reason: "pull-request-open", pullRequest };
    const reason =
      state === "merged"
        ? "pull-request-merged"
        : state === "closed"
          ? "pull-request-closed"
          : "finished";
    return { column: "done", reason, pullRequest };
  };

  const toCard = <T extends ProjectBoardThread>(
    thread: T,
    placement: Placement,
  ): ProjectBoardCard<T> => ({
    thread,
    reason: placement.reason,
    pullRequest: placement.pullRequest,
    activeAt: resolveThreadActivityTimestamp(thread),
  });

  const sortCards = <T extends ProjectBoardThread>(
    column: ProjectBoardColumnId,
    cards: ReadonlyArray<ProjectBoardCard<T>>,
  ): ProjectBoardCard<T>[] => {
    const oldestFirst = column === "needs-you";
    const keyed = cards.map((card) => ({
      card,
      ms: oldestFirst ? waitingMs(card) : (toSortableTimestamp(card.activeAt ?? undefined) ?? 0),
    }));
    keyed.sort(
      (left, right) =>
        (oldestFirst ? left.ms - right.ms : right.ms - left.ms) ||
        compareCardIdentity(left.card, right.card),
    );
    return keyed.map((entry) => entry.card);
  };

  const buildProjectBoard = <T extends ProjectBoardThread>(
    threads: ReadonlyArray<T>,
    options: { readonly doneLimit?: number } = {},
  ): ReadonlyArray<ProjectBoardColumn<T>> => {
    const doneLimit = options.doneLimit ?? PROJECT_BOARD_DONE_LIMIT;
    const byColumn = new Map<ProjectBoardColumnId, ProjectBoardCard<T>[]>(
      PROJECT_BOARD_COLUMNS.map((id) => [id, []]),
    );
    for (const thread of threads) {
      if (!isOnBoard(thread)) continue;
      const placement = placeThread(thread);
      byColumn.get(placement.column)!.push(toCard(thread, placement));
    }
    return PROJECT_BOARD_COLUMNS.map((id) => {
      const cards = sortCards(id, byColumn.get(id)!);
      return { id, total: cards.length, cards: id === "done" ? cards.slice(0, doneLimit) : cards };
    });
  };

  const countProjectBoard = (
    threads: ReadonlyArray<ProjectBoardThread>,
  ): Readonly<Record<ProjectBoardColumnId, number>> => {
    const counts: Record<ProjectBoardColumnId, number> = {
      working: 0,
      "needs-you": 0,
      "in-checks": 0,
      done: 0,
    };
    for (const thread of threads) {
      if (isOnBoard(thread)) counts[placeThread(thread).column] += 1;
    }
    return counts;
  };

  const buildNeedsYouList = <T extends ProjectBoardThread>(
    threads: ReadonlyArray<T>,
    options: { readonly limit?: number } = {},
  ): { readonly total: number; readonly items: ReadonlyArray<NeedsYouItem<T>> } => {
    const limit = options.limit ?? NEEDS_YOU_LIST_LIMIT;
    const keyed: Array<{
      readonly item: NeedsYouItem<T>;
      readonly group: number;
      readonly ms: number;
    }> = [];
    for (const thread of threads) {
      if (!isOnBoard(thread)) continue;
      const placement = placeThread(thread);
      if (placement.column !== "needs-you") continue;
      const card = toCard(thread, placement);
      keyed.push({
        item: { ...card, waitingSince: resolveWaitingSince(card) },
        group: needsYouGroup(card),
        ms: waitingMs(card),
      });
    }
    keyed.sort(
      (left, right) =>
        left.group - right.group ||
        left.ms - right.ms ||
        compareCardIdentity(left.item, right.item),
    );
    return { total: keyed.length, items: keyed.slice(0, limit).map((entry) => entry.item) };
  };

  return { buildProjectBoard, countProjectBoard, buildNeedsYouList };
}
