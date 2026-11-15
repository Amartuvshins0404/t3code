import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeProjectBoard,
  pendingSubagentRequestsByThread,
  threadShellActivity,
  type PendingSubagentRequest,
  type ProjectBoardColumnId,
  type ProjectBoardReason,
} from "@t3tools/shared/projectBoard";
import * as DateTime from "effect/DateTime";

import {
  resolveThreadCurrentPullRequestLink,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";

const { countProjectBoard, buildNeedsYouList } = makeProjectBoard(
  resolveThreadCurrentPullRequestLink,
);

export interface ProjectBoardSummary {
  readonly project: Pick<OrchestrationProjectShell, "id" | "title">;
  readonly counts: Readonly<Record<ProjectBoardColumnId, number>>;
  readonly needsYou: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly reason: ProjectBoardReason;
    readonly waitingSince: string | null;
    readonly pullRequestUrl: string | null;
  }>;
}

const boardThread = (
  shell: OrchestrationV2ThreadShell,
  pendingSubagentRequest: PendingSubagentRequest | null,
) => ({
  ...threadShellActivity(shell),
  id: shell.id,
  title: shell.title,
  archivedAt: shell.archivedAt === null ? null : DateTime.formatIso(shell.archivedAt),
  deletedAt: shell.deletedAt === null ? null : DateTime.formatIso(shell.deletedAt),
  lineage: shell.lineage,
  source: shell,
  pullRequests: threadPullRequestsOf(shell),
  pendingGuestMessageCount: shell.pendingGuestMessageCount ?? 0,
  pendingSubagentRequest,
  interactionMode: shell.interactionMode,
  hasActionableProposedPlan: shell.hasActionableProposedPlan,
});

/** The Projects page's tiles and Needs you list, from the threads this environment shows. */
export function summarizeProjectBoard(input: {
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title" | "archivedAt">>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly hiddenThreadId: ThreadId | null;
  readonly scratchProjectId: OrchestrationProjectShell["id"] | null;
}): ReadonlyArray<ProjectBoardSummary> {
  const requests = pendingSubagentRequestsByThread(input.threads);
  const byProject = new Map<string, Array<ReturnType<typeof boardThread>>>();
  for (const shell of input.threads) {
    if (shell.id === input.hiddenThreadId) continue;
    const thread = boardThread(shell, requests.get(shell.id) ?? null);
    const list = byProject.get(shell.projectId);
    if (list) list.push(thread);
    else byProject.set(shell.projectId, [thread]);
  }
  return input.projects
    .filter(
      (project) =>
        project.archivedAt === null &&
        (project.id !== input.scratchProjectId || byProject.has(project.id)),
    )
    .map((project) => {
      const threads = byProject.get(project.id) ?? [];
      const needsYou = buildNeedsYouList(threads, { limit: Number.POSITIVE_INFINITY });
      return {
        project: { id: project.id, title: project.title },
        counts: countProjectBoard(threads),
        needsYou: needsYou.items.map((item) => ({
          threadId: item.thread.id,
          title: item.thread.title,
          reason: item.reason,
          waitingSince: item.waitingSince,
          pullRequestUrl: item.pullRequest?.url ?? null,
        })),
      };
    });
}
