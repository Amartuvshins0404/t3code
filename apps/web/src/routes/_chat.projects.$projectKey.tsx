import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectBoardPage,
  type ProjectPageSearch,
} from "../components/projectBoard/ProjectBoardPage";

function ProjectBoardRouteView() {
  const { projectKey } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectBoardPage
      key={projectKey}
      projectKey={projectKey}
      search={search}
      onSearch={(next) => void navigate({ search: next })}
    />
  );
}

export const Route = createFileRoute("/_chat/projects/$projectKey")({
  validateSearch: (raw: Record<string, unknown>): ProjectPageSearch => ({
    ...(raw.view === "map" ? { view: "map" as const } : {}),
    ...(typeof raw.focus === "string" && raw.focus.length > 0
      ? { focus: raw.focus.slice(0, 1024) }
      : {}),
  }),
  component: ProjectBoardRouteView,
});
