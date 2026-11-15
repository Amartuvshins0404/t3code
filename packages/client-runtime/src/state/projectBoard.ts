import {
  makeProjectBoard,
  type NeedsYouItem as SharedNeedsYouItem,
  type ProjectBoardCard as SharedProjectBoardCard,
  type ProjectBoardColumn as SharedProjectBoardColumn,
} from "@t3tools/shared/projectBoard";

import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import { resolveThreadCurrentPullRequestLink } from "../threadPullRequests.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export {
  NEEDS_YOU_LIST_LIMIT,
  PROJECT_BOARD_COLUMNS,
  PROJECT_BOARD_DONE_LIMIT,
  type ProjectBoardColumnId,
  type ProjectBoardReason,
} from "@t3tools/shared/projectBoard";

export type ProjectBoardCard = SharedProjectBoardCard<EnvironmentThreadShell>;
export type NeedsYouItem = SharedNeedsYouItem<EnvironmentThreadShell>;
export type ProjectBoardColumn = SharedProjectBoardColumn<EnvironmentThreadShell>;

export const { buildProjectBoard, countProjectBoard, buildNeedsYouList } = makeProjectBoard(
  resolveThreadCurrentPullRequestLink,
);

export function threadsOnProjectsPage(
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "archivedAt">>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const listed = new Set<string>();
  for (const project of projects) {
    if (project.archivedAt == null) {
      listed.add(scopedProjectKey(scopeProjectRef(project.environmentId, project.id)));
    }
  }
  return threads.filter((thread) =>
    listed.has(scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))),
  );
}
