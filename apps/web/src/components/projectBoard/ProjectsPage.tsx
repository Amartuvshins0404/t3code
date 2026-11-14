import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildNeedsYouList,
  countProjectBoard,
  NEEDS_YOU_LIST_LIMIT,
  PROJECT_BOARD_COLUMNS,
  threadsOnProjectsPage,
} from "@t3tools/client-runtime/state/projects";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "~/env";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useQuietThreadShells,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectBoardCardView } from "./ProjectBoardCard";
import {
  PROJECT_BOARD_COLUMN_TITLES,
  PROJECT_BOARD_EMPTY_COLUMN_TEXT,
  projectBoardKey,
} from "./projectBoardPresentation";

export function ProjectsPage() {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const bootstrapped = useAllEnvironmentProjectSnapshotsReady();
  const { environments } = useEnvironments();
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = environments.length > 1;
  const pageThreads = threadsOnProjectsPage(projects, threads);
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of pageThreads) {
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
  const projectPlaces = new Map(
    tiles.map(({ project, key }) => [
      key,
      showEnvironment
        ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
        : project.title,
    ]),
  );

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
            <NeedsYouSection threads={pageThreads} projectPlaces={projectPlaces} />
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

function NeedsYouSection({
  threads,
  projectPlaces,
}: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectPlaces: ReadonlyMap<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const list = buildNeedsYouList(threads, showAll ? { limit: Number.POSITIVE_INFINITY } : {});
  const hidden = list.total - list.items.length;
  return (
    <section aria-labelledby="projects-needs-you-title" className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h2 id="projects-needs-you-title" className="text-sm font-medium text-foreground">
          {PROJECT_BOARD_COLUMN_TITLES["needs-you"]}
        </h2>
        <Badge variant="secondary">{list.total}</Badge>
      </header>
      {list.total === 0 ? (
        <p className="text-xs text-muted-foreground">
          {PROJECT_BOARD_EMPTY_COLUMN_TEXT["needs-you"]}
        </p>
      ) : (
        <ol className="flex list-none flex-col gap-2 p-0">
          {list.items.map((item) => (
            <ProjectBoardCardView
              key={`${item.thread.environmentId}:${item.thread.id}`}
              card={item}
              timestamp={item.waitingSince}
              place={projectPlaces.get(
                projectBoardKey({
                  environmentId: item.thread.environmentId,
                  id: item.thread.projectId,
                }),
              )}
            />
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <div className="flex">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show all ({hidden} more)
          </Button>
        </div>
      ) : showAll && list.total > NEEDS_YOU_LIST_LIMIT ? (
        <div className="flex">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(false)}>
            Show fewer
          </Button>
        </div>
      ) : null}
    </section>
  );
}
