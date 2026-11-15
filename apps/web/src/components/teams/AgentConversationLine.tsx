import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircleIcon } from "lucide-react";

import { useIsTeammateEnvironment, useTeamMachine } from "~/cloud/teamWorkspace";
import { useProjects } from "~/state/entities";
import { useAgentConversation, useMachineAgentState } from "./teamAgents";

export function AgentConversationLine({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const conversation = useAgentConversation(threadRef);
  if (conversation === null) return null;
  return (
    <AgentConversationLineContent
      threadRef={threadRef}
      organizationId={conversation.organizationId}
      projectId={conversation.projectId}
    />
  );
}

function AgentConversationLineContent({
  threadRef,
  organizationId,
  projectId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const teammate = useIsTeammateEnvironment(threadRef.environmentId);
  const ownerName = useTeamMachine(threadRef.environmentId)?.owner.name ?? "The owner";
  const state = useMachineAgentState(threadRef.environmentId, organizationId);
  const projects = useProjects();
  const projectTitle =
    (state.kind === "answered"
      ? state.agent?.projects.find((project) => project.projectId === projectId)?.title
      : undefined) ??
    projects.find(
      (project) => project.environmentId === threadRef.environmentId && project.id === projectId,
    )?.title ??
    "this project";
  const who = teammate ? `${ownerName}'s agent` : "Your agent";
  return (
    <p className="flex items-center gap-1.5 px-4 pb-1 text-xs text-muted-foreground">
      <MessageCircleIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {who} · read only · answers about {projectTitle}
      </span>
    </p>
  );
}
