import { isCloudAuthError } from "@t3tools/client-runtime/cloud-auth";
import type { TeamRole } from "@t3tools/contracts";

import { Avatar } from "../ui/avatar";

export const TEAM_ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function teamErrorMessage(cause: unknown, fallback: string): string {
  return isCloudAuthError(cause) ? cause.detail : fallback;
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
