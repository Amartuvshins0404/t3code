import type { OrchestrationV2Command, ThreadTeamShare } from "@t3tools/contracts";

import type { ProjectRow } from "./ProjectStore.ts";

type RequestedTeamShare = NonNullable<
  Extract<OrchestrationV2Command, { readonly type: "thread.create" }>["teamShare"]
>;

export function teamShareAtCreation(input: {
  readonly inherited: ThreadTeamShare | null | undefined;
  readonly requested: RequestedTeamShare | undefined;
  readonly project: Pick<ProjectRow, "teamShare" | "archivedAt" | "deletedAt"> | undefined;
  readonly sharedAt: string;
}): ThreadTeamShare | null | undefined {
  if (input.requested !== undefined) {
    return {
      organizationId: input.requested.organizationId,
      access: input.requested.access,
      sharedAt: input.sharedAt,
      ...(input.requested.agent === undefined ? {} : { agent: input.requested.agent }),
      ...(input.requested.startedBy === undefined ? {} : { startedBy: input.requested.startedBy }),
    };
  }
  if (input.inherited?.agent !== undefined) return input.inherited;
  const project = input.project;
  if (
    project === undefined ||
    project.teamShare === null ||
    project.archivedAt !== null ||
    project.deletedAt !== null
  ) {
    return input.inherited;
  }
  return {
    organizationId: project.teamShare.organizationId,
    access: "steer",
    sharedAt: input.sharedAt,
  };
}
