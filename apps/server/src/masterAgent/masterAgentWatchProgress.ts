import type {
  MasterAgentWatchState,
  OrchestrationV2Notification,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

export type WatchRecords = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "messages" | "subagents" | "providerThreads" | "runtimeRequests"
>;

export type WatchEnd = "completed" | "failed" | "interrupted" | "cancelled" | "needs_you" | "gone";

export type WatchProgress =
  | { readonly state: Exclude<MasterAgentWatchState, "done"> }
  | {
      readonly state: "done";
      readonly end: WatchEnd;
      readonly resultRun?: OrchestrationV2Run | undefined;
    };

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

type WatchShell = Pick<
  OrchestrationV2ThreadShell,
  "deletedAt" | "archivedAt" | "pullRequests"
> | null;

/**
 * Settled the way `t3_thread_wait` with `untilDelegatedWorkSettled` is, and also past every pull
 * request watch: a thread idle on checks or a helper will wake again, so it is not done yet.
 */
export function watchProgress(input: {
  readonly shell: WatchShell;
  readonly records: WatchRecords;
  readonly resultPending: boolean;
}): WatchProgress {
  const { shell, records } = input;
  if (shell === null || shell.deletedAt != null) return { state: "done", end: "gone" };
  if (records.runtimeRequests.some((request) => request.status === "pending"))
    return { state: "done", end: "needs_you" };
  const progress = delegatedTaskProgress(records);
  if (progress.state === "working") {
    // Rolled back past all its work with nothing running: there is no answer left to wait for.
    const rolledBack =
      progress.resultRun === undefined && records.runs.every((run) => TERMINAL.has(run.status));
    return rolledBack ? { state: "done", end: "completed" } : { state: "working" };
  }
  // Unlike a delegated result, any program the thread left running holds it, dev servers too.
  const programs = records.providerThreads.some(
    (thread) => (thread.pendingBackgroundTasks ?? []).length > 0,
  );
  if (progress.state === "waiting_for_children" || input.resultPending || programs)
    return { state: "waiting_on_tasks" };
  if (
    shell.archivedAt == null &&
    visibleThreadPullRequests(shell.pullRequests ?? []).some((link) => link.watch !== undefined)
  )
    return { state: "in_checks" };
  const status = progress.resultRun?.status;
  return {
    state: "done",
    resultRun: progress.resultRun,
    end:
      status === "failed" || status === "interrupted" || status === "cancelled"
        ? status
        : "completed",
  };
}

export interface WatchNoticeInput {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly end: WatchEnd;
  readonly lastMessage: string | null;
  readonly pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly url: string;
    readonly state: string | null;
    readonly checks: string | null;
  }>;
}

const END_TEXT: Record<WatchEnd, string> = {
  completed: "finished",
  failed: "failed",
  interrupted: "was interrupted",
  cancelled: "was cancelled",
  needs_you: "is waiting for the owner (an approval or a question)",
  gone: "was deleted",
};

const LAST_MESSAGE_MAX = 600;

/** One stored line per settled thread; a batch joins them into one wake. */
export function watchNoticeLine(input: WatchNoticeInput): string {
  const link = formatThreadLink({ environmentId: null, threadId: input.threadId }, input.title);
  const parts = [
    `- ${link} ${END_TEXT[input.end]}. Its agent and every program it left running have stopped.`,
  ];
  if (input.end === "needs_you")
    parts[0] = `- ${link} ${END_TEXT.needs_you}. It is paused, not finished.`;
  if (input.lastMessage !== null && input.lastMessage.trim() !== "") {
    const text = input.lastMessage.trim().replace(/\s+/g, " ");
    parts.push(
      `  Last message: ${text.length > LAST_MESSAGE_MAX ? `${text.slice(0, LAST_MESSAGE_MAX)}…` : text}`,
    );
  }
  for (const pr of input.pullRequests) {
    const state = [pr.state, pr.checks === null ? null : `checks ${pr.checks}`]
      .filter((part) => part !== null)
      .join(", ");
    parts.push(`  PR #${pr.number}${state === "" ? "" : ` (${state})`}: ${pr.url}`);
  }
  return parts.join("\n");
}

export function watchNoticeMessage(
  lines: ReadonlyArray<{ readonly end: WatchEnd; readonly title: string; readonly line: string }>,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const count = lines.length;
  const text = [
    `T3 Code: ${count === 1 ? "a thread you started has" : `${count} threads you started have`} settled. Tell the owner in a line or two, with each thread's link.`,
    "",
    ...lines.map((entry) => entry.line),
  ].join("\n");
  const outcome = lines.some((entry) => entry.end === "failed")
    ? "failed"
    : lines.some((entry) => entry.end !== "completed")
      ? "updated"
      : "completed";
  const first = lines[0]!;
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome,
      summary:
        count === 1
          ? `${first.title.trim() || "Thread"}: ${END_TEXT[first.end]}`
          : `${count} threads settled`,
    },
  };
}
