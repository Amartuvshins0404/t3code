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

function placeThread(thread: EnvironmentThreadShell): Placement {
  const pullRequest = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const attention = threadAttentionReason(thread);
  if (attention !== null) return { column: "needs-you", reason: attention, pullRequest };
  if (isThreadWorking(thread)) return { column: "working", reason: "running", pullRequest };
  const state = pullRequest === null ? null : (pullRequest.snapshot?.state ?? "open");
  if (state === "open") return { column: "in-checks", reason: "pull-request-open", pullRequest };
  const reason =
    state === "merged"
      ? "pull-request-merged"
      : state === "closed"
        ? "pull-request-closed"
        : "finished";
  return { column: "done", reason, pullRequest };
}

function sortCards(
  column: ProjectBoardColumnId,
  cards: ReadonlyArray<ProjectBoardCard>,
): ProjectBoardCard[] {
  const oldestFirst = column === "needs-you";
  const keyed = cards.map((card) => {
    const activeMs = toSortableTimestamp(card.activeAt ?? undefined);
    const waitingMs = toSortableTimestamp(card.thread.pendingUserInputAt ?? undefined) ?? activeMs;
    return {
      card,
      ms: oldestFirst ? (waitingMs ?? Number.MAX_SAFE_INTEGER) : (activeMs ?? 0),
    };
  });
  keyed.sort(
    (left, right) =>
      (oldestFirst ? left.ms - right.ms : right.ms - left.ms) ||
      left.card.thread.id.localeCompare(right.card.thread.id) ||
      left.card.thread.environmentId.localeCompare(right.card.thread.environmentId),
  );
  return keyed.map((entry) => entry.card);
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
    const { column, reason, pullRequest } = placeThread(thread);
    byColumn.get(column)!.push({
      thread,
      reason,
      pullRequest,
      activeAt: resolveThreadActivityTimestamp(thread),
    });
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
