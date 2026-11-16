import { createFileRoute } from "@tanstack/react-router";

import { AgentPage } from "../components/agent/AgentPage";

export const Route = createFileRoute("/_chat/agent")({
  component: AgentPage,
});
