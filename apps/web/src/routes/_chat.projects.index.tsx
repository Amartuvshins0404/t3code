import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "../components/projectBoard/ProjectsPage";

export const Route = createFileRoute("/_chat/projects/")({
  component: ProjectsPage,
});
