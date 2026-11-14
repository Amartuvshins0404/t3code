import { isCloudAuthError } from "@t3tools/client-runtime/cloud-auth";
import { TeamAccessError, type TeamRole } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { Avatar } from "../ui/avatar";

export const TEAM_ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function teamErrorMessage(cause: unknown, fallback: string): string {
  return isCloudAuthError(cause) ? cause.detail : fallback;
}

const TEAM_ACCESS_MESSAGES: Readonly<Record<TeamAccessError["reason"], string>> = {
  not_allowed_for_teammates: "Only the machine's owner can do that.",
  organization_not_shared: "This machine is not shared with that team.",
  thread_not_shared: "This thread is no longer shared with you.",
  thread_view_only: "You can view this thread. Ask the owner for Steer to send messages.",
  thread_unavailable: "This thread is not available anymore.",
  internal: "The machine could not do that. Try again.",
};

const isTeamAccessError = Schema.is(TeamAccessError);

export function teamAccessMessage(cause: unknown, fallback: string): string {
  if (isTeamAccessError(cause)) return TEAM_ACCESS_MESSAGES[cause.reason];
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function TeamMark({
  team,
  size = "xs",
}: {
  readonly team: { readonly id: string; readonly name: string; readonly logo: string | null };
  readonly size?: "xs" | "sm" | "md" | "lg";
}) {
  return <Avatar name={team.name} src={team.logo} seed={team.id} size={size} shape="square" />;
}
