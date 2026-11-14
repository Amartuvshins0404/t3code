import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { countProjectBoard, PROJECT_BOARD_COLUMNS } from "@t3tools/client-runtime/state/projects";
import { Link } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useQuietThreadShells,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PROJECT_BOARD_COLUMN_TITLES, projectBoardKey } from "./projectBoardPresentation";

export function ProjectsPage() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const bootstrapped = useAllEnvironmentProjectSnapshotsReady();
  const { environments } = useEnvironments();
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = environments.length > 1;
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const list = threadsByProject.get(key);
    if (list) list.push(thread);
    else threadsByProject.set(key, [thread]);
  }
  const tiles = sortScopedProjectsForSidebar(
    projects.filter((project) => project.archivedAt == null),
    threads,
    "updated_at",
  ).map((project) => {
    const key = projectBoardKey(project);
    return { project, key, counts: countProjectBoard(threadsByProject.get(key) ?? []) };
  });

  return (
    <SidebarInset
      {...workspaceAreaProps("projects", 1, "Projects")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <WorkspaceBreadcrumb ariaLabel="Projects breadcrumb">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Projects</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tiles.length === 0 ? (
          bootstrapped ? (
            <Empty className="h-full">
              <EmptyHeader className="max-w-md">
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Add a project from the sidebar. Its board shows up here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null
        ) : (
          <WorkspacePageContainer width="expanded">
            <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {tiles.map(({ project, key, counts }) => (
                <li key={key} className="min-w-0">
                  <Link
                    to="/projects/$projectKey"
                    params={{ projectKey: key }}
                    aria-label={[
                      showEnvironment
                        ? `${project.title} on ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
                        : project.title,
                      ...PROJECT_BOARD_COLUMNS.map(
                        (column) => `${PROJECT_BOARD_COLUMN_TITLES[column]} ${counts[column]}`,
                      ),
                    ].join(", ")}
                    className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {project.title}
                      </span>
                      {showEnvironment ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {environmentLabels.get(project.environmentId) ?? project.environmentId}
                        </span>
                      ) : null}
                    </span>
                    <span className="grid grid-cols-4 gap-2">
                      {PROJECT_BOARD_COLUMNS.map((column) => (
                        <span key={column} className="flex min-w-0 flex-col">
                          <span className="text-base font-medium tabular-nums text-foreground">
                            {counts[column]}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {PROJECT_BOARD_COLUMN_TITLES[column]}
                          </span>
                        </span>
                      ))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </WorkspacePageContainer>
        )}
      </div>
    </SidebarInset>
  );
}
