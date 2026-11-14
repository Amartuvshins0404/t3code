import { isListedThreadLineage, type ThreadPullRequestLink } from "@t3tools/contracts";

import { resolveThreadCurrentPullRequestLink } from "../threadPullRequests.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  isThreadWorking,
  threadAttentionReason,
  type ThreadAttentionReason,
} from "./threadInbox.ts";
import { resolveThreadActivityTimestamp, toSortableTimestamp } from "./threadSort.ts";

export type ProjectBoardColumnId = "working" | "needs-you" | "in-checks" | "done";

export const PROJECT_BOARD_COLUMNS: ReadonlyArray<ProjectBoardColumnId> = [
  "working",
  "needs-you",
  "in-checks",
  "done",
];

export const PROJECT_BOARD_DONE_LIMIT = 30;

const NEEDS_YOU_LIST_LIMIT = 5;

export type ProjectBoardReason =
  | ThreadAttentionReason
  | "running"
  | "pull-request-open"
  | "pull-request-merged"
  | "pull-request-closed"
  | "finished";

export interface ProjectBoardCard {
  readonly thread: EnvironmentThreadShell;
  readonly reason: ProjectBoardReason;
  readonly pullRequest: ThreadPullRequestLink | null;
  readonly activeAt: string | null;
}

export interface NeedsYouItem extends ProjectBoardCard {
  readonly waitingSince: string | null;
}

interface NeedsYouList {
  readonly total: number;
  readonly items: ReadonlyArray<NeedsYouItem>;
}

export interface ProjectBoardColumn {
  readonly id: ProjectBoardColumnId;
  readonly total: number;
  readonly cards: ReadonlyArray<ProjectBoardCard>;
}

interface Placement {
  readonly column: ProjectBoardColumnId;
  readonly reason: ProjectBoardReason;
  readonly pullRequest: ThreadPullRequestLink | null;
}

function isOnBoard(thread: EnvironmentThreadShell): boolean {
  return (
    thread.archivedAt == null && thread.deletedAt == null && isListedThreadLineage(thread.lineage)
  );
}

function pullRequestState(pullRequest: ThreadPullRequestLink | null) {
  return pullRequest === null ? null : (pullRequest.snapshot?.state ?? "open");
}

function placeThread(thread: EnvironmentThreadShell): Placement {
  const pullRequest = resolveThreadCurrentPullRequestLink(thread.pullRequests);
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
}

function toCard(thread: EnvironmentThreadShell, placement: Placement): ProjectBoardCard {
  return {
    thread,
    reason: placement.reason,
    pullRequest: placement.pullRequest,
    activeAt: resolveThreadActivityTimestamp(thread),
  };
}

function resolveWaitingSince(card: ProjectBoardCard): string | null {
  const askedAt = card.thread.pendingUserInputAt;
  return askedAt != null && toSortableTimestamp(askedAt) !== null ? askedAt : card.activeAt;
}

function waitingMs(card: ProjectBoardCard): number {
  return toSortableTimestamp(resolveWaitingSince(card) ?? undefined) ?? Number.MAX_SAFE_INTEGER;
}

function compareCardIdentity(left: ProjectBoardCard, right: ProjectBoardCard): number {
  return (
    left.thread.id.localeCompare(right.thread.id) ||
    left.thread.environmentId.localeCompare(right.thread.environmentId)
  );
}

function sortCards(
  column: ProjectBoardColumnId,
  cards: ReadonlyArray<ProjectBoardCard>,
): ProjectBoardCard[] {
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
}

function needsYouGroup(card: ProjectBoardCard): number {
  if (pullRequestState(card.pullRequest) === "open") return 0;
  const { thread } = card;
  if (thread.runtime?.lastError != null || thread.latestRun?.status === "failed") return 1;
  return 2;
}

export function buildProjectBoard(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly doneLimit?: number } = {},
): ReadonlyArray<ProjectBoardColumn> {
  const doneLimit = options.doneLimit ?? PROJECT_BOARD_DONE_LIMIT;
  const byColumn = new Map<ProjectBoardColumnId, ProjectBoardCard[]>(
    PROJECT_BOARD_COLUMNS.map((id) => [id, []]),
  );
  for (const thread of threads) {
    if (!isOnBoard(thread)) continue;
    const placement = placeThread(thread);
    byColumn.get(placement.column)!.push(toCard(thread, placement));
  }
  return PROJECT_BOARD_COLUMNS.map((id) => {
    const cards = sortCards(id, byColumn.get(id)!);
    return {
      id,
      total: cards.length,
      cards: id === "done" ? cards.slice(0, doneLimit) : cards,
    };
  });
}

export function countProjectBoard(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): Readonly<Record<ProjectBoardColumnId, number>> {
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
}

export function buildNeedsYouList(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly limit?: number } = {},
): NeedsYouList {
  const limit = options.limit ?? NEEDS_YOU_LIST_LIMIT;
  const keyed: Array<{ readonly item: NeedsYouItem; readonly group: number; readonly ms: number }> =
    [];
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
      left.group - right.group || left.ms - right.ms || compareCardIdentity(left.item, right.item),
  );
  return { total: keyed.length, items: keyed.slice(0, limit).map((entry) => entry.item) };
}
