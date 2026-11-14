import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type {
  ProjectBoardCard,
  ProjectBoardColumnId,
} from "@t3tools/client-runtime/state/projects";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

export const PROJECT_BOARD_COLUMN_TITLES: Record<ProjectBoardColumnId, string> = {
  working: "Working",
  "needs-you": "Needs you",
  "in-checks": "In checks",
  done: "Done",
};

export const PROJECT_BOARD_EMPTY_COLUMN_TEXT: Record<ProjectBoardColumnId, string> = {
  working: "No agent is running.",
  "needs-you": "Nothing is waiting for you.",
  "in-checks": "No open pull requests.",
  done: "No finished threads yet.",
};

export function projectBoardKey(project: Pick<EnvironmentProject, "environmentId" | "id">) {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

export function projectBoardReasonLabel(card: ProjectBoardCard): string {
  const pullRequest = card.pullRequest;
  const changeRequest =
    pullRequest === null
      ? null
      : `${(sourceControlClients.findByChangeRequestUrl(pullRequest.url) ?? sourceControlClients.get(undefined)).changeRequest.shortLabel} #${pullRequest.number}`;
  switch (card.reason) {
    case "approval":
      return "Needs approval";
    case "question":
      return "Asked a question";
    case "subagent-request":
      return "Subagent is waiting";
    case "guest-message":
      return "Guest message waiting";
    case "plan":
      return "Plan ready to review";
    case "error":
      return "Hit an error";
    case "failed-run":
      return "Last run failed";
    case "running":
      return "Running";
    case "pull-request-open":
      return `${changeRequest} open`;
    case "pull-request-merged":
      return `${changeRequest} merged`;
    case "pull-request-closed":
      return `${changeRequest} closed`;
    case "finished":
      return "Finished";
  }
}
