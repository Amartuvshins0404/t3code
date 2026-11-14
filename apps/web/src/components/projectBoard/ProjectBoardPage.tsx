import { parseScopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildProjectBoard,
  PROJECT_BOARD_DONE_LIMIT,
  type ProjectBoardColumn,
} from "@t3tools/client-runtime/state/projects";
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { useClientSettings } from "~/hooks/useSettings";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useProject,
  useProjects,
  useQuietThreadShells,
} from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectPlantButton } from "../projectPlant/ProjectPlantButton";
import { ProjectBoardCardView } from "./ProjectBoardCard";
import {
  PROJECT_BOARD_COLUMN_TITLES,
  PROJECT_BOARD_EMPTY_COLUMN_TEXT,
} from "./projectBoardPresentation";

export function ProjectBoardPage({ projectKey }: { readonly projectKey: string }) {
  const projectRef = parseScopedProjectKey(projectKey);
  const project = useProject(projectRef);
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();

  return (
    <SidebarInset
      {...workspaceAreaProps("project-board", 1, "Project board")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {project === null ? (
        <>
          <ProjectBoardHeader project={null} />
          {projectsReady ? <UnknownProject projectKey={projectKey} /> : null}
        </>
      ) : (
        <ProjectBoard project={project} />
      )}
    </SidebarInset>
  );
}

function ProjectBoardHeader({ project }: { readonly project: EnvironmentProject | null }) {
  const { environments } = useEnvironments();
  const environmentLabel =
    project === null || environments.length < 2
      ? null
      : (environments.find((environment) => environment.environmentId === project.environmentId)
          ?.label ?? project.environmentId);
  const settingsKey = useProjectSettingsKey(project);

  return (
    <WorkspacePageHeader electron={isElectron} className="border-b border-border">
      <WorkspaceBreadcrumb ariaLabel="Project board breadcrumb" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <Link to="/projects" className="hover:text-foreground">
            Projects
          </Link>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">{project?.title ?? "Unknown project"}</h1>
        </WorkspaceBreadcrumbItem>
        {environmentLabel === null ? null : (
          <WorkspaceBreadcrumbItem>
            <span className="truncate text-xs font-normal">{environmentLabel}</span>
          </WorkspaceBreadcrumbItem>
        )}
      </WorkspaceBreadcrumb>
      {project === null || settingsKey === null ? null : (
        <div className="flex shrink-0 items-center gap-1">
          <ProjectPlantButton
            environmentId={project.environmentId}
            projectId={project.id}
            size="header"
          />
          <Button
            variant="ghost"
            size="sm"
            render={
              <Link
                to="/settings/projects"
                search={{ project: settingsKey, machine: project.environmentId }}
              />
            }
          >
            <SettingsIcon />
            Project settings
          </Button>
        </div>
      )}
    </WorkspacePageHeader>
  );
}

function useProjectSettingsKey(project: EnvironmentProject | null): string | null {
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (project === null) return null;
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings: grouping, primaryEnvironmentId }).get(
      derivePhysicalProjectKey(project),
    ) ?? deriveLogicalProjectKeyFromSettings(project, grouping)
  );
}

function UnknownProject({ projectKey }: { readonly projectKey: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader className="max-w-md">
        <EmptyTitle>Project not found</EmptyTitle>
        <EmptyDescription>
          This project is gone, or its machine is not connected. Older links may point to project
          settings instead.
        </EmptyDescription>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button size="sm" render={<Link to="/projects" />}>
            All projects
          </Button>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/settings/projects" search={{ project: projectKey, machine: undefined }} />
            }
          >
            Open in settings
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}

function ProjectBoard({ project }: { readonly project: EnvironmentProject }) {
  const threads = useQuietThreadShells();
  const [doneLimit, setDoneLimit] = useState(PROJECT_BOARD_DONE_LIMIT);
  const projectThreads = threads.filter(
    (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
  );
  const board = buildProjectBoard(projectThreads, { doneLimit });
  const empty = board.every((column) => column.total === 0);

  return (
    <>
      <ProjectBoardHeader project={project} />
      {empty ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>No threads yet</EmptyTitle>
            <EmptyDescription>
              Start a thread in this project. It shows up here as a card.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pt-4 pb-4 sm:px-6">
          {board.map((column) => (
            <ProjectBoardColumnView
              key={column.id}
              column={column}
              onShowMore={() => setDoneLimit((limit) => limit + PROJECT_BOARD_DONE_LIMIT)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProjectBoardColumnView({
  column,
  onShowMore,
}: {
  readonly column: ProjectBoardColumn;
  readonly onShowMore: () => void;
}) {
  const titleId = `project-board-column-${column.id}`;
  const hidden = column.total - column.cards.length;
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-h-0 w-72 shrink-0 flex-col rounded-lg bg-muted/40 lg:w-auto lg:min-w-0 lg:flex-1"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <h2 id={titleId} className="text-sm font-medium text-foreground">
          {PROJECT_BOARD_COLUMN_TITLES[column.id]}
        </h2>
        <Badge variant="secondary">{column.total}</Badge>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {column.cards.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {PROJECT_BOARD_EMPTY_COLUMN_TEXT[column.id]}
          </p>
        ) : (
          <ol className="flex list-none flex-col gap-2 p-0">
            {column.cards.map((card) => (
              <ProjectBoardCardView
                key={`${card.thread.environmentId}:${card.thread.id}`}
                card={card}
                timestamp={card.activeAt}
              />
            ))}
          </ol>
        )}
        {hidden > 0 ? (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" onClick={onShowMore}>
              Show more ({hidden} left)
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
