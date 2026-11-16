import { createFileRoute } from "@tanstack/react-router";

import { ProjectBoardPage } from "../components/projectBoard/ProjectBoardPage";

function ProjectBoardRouteView() {
  const { projectKey } = Route.useParams();
  return <ProjectBoardPage key={projectKey} projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/projects/$projectKey")({
  component: ProjectBoardRouteView,
});
