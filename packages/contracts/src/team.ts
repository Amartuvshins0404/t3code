import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const TeamRole = Schema.Literals(["owner", "admin", "member"]);
export type TeamRole = typeof TeamRole.Type;

export const TeamThreadAccess = Schema.Literals(["view", "steer"]);
export type TeamThreadAccess = typeof TeamThreadAccess.Type;

export const TeamPerson = Schema.Struct({
  userId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  image: Schema.optional(TrimmedNonEmptyString),
});
export type TeamPerson = typeof TeamPerson.Type;

export const TeamMemberIdentity = Schema.Struct({
  ...TeamPerson.fields,
  email: Schema.optional(TrimmedNonEmptyString),
  organizationId: TrimmedNonEmptyString,
  organizationSlug: TrimmedNonEmptyString,
  role: TeamRole,
});
export type TeamMemberIdentity = typeof TeamMemberIdentity.Type;

export const TeamAgentConversation = Schema.Struct({
  startedBy: TeamPerson,
});
export type TeamAgentConversation = typeof TeamAgentConversation.Type;

export const ThreadTeamShare = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  access: TeamThreadAccess,
  sharedAt: IsoDateTime,
  agent: Schema.optional(TeamAgentConversation),
  startedBy: Schema.optional(TeamPerson),
});
export type ThreadTeamShare = typeof ThreadTeamShare.Type;

export const TeamPresenceEntry = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  person: Schema.optional(TeamPerson),
  owner: Schema.Boolean,
  threadId: Schema.optional(ThreadId),
  typing: Schema.Boolean,
});
export type TeamPresenceEntry = typeof TeamPresenceEntry.Type;

export const TeamSharedOrganizations = Schema.Struct({
  organizationIds: Schema.Array(TrimmedNonEmptyString),
});
export type TeamSharedOrganizations = typeof TeamSharedOrganizations.Type;

export const TeamSharedOrganizationInput = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
});
export type TeamSharedOrganizationInput = typeof TeamSharedOrganizationInput.Type;

export const TeamMemberAccessRevokeInput = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
});
export type TeamMemberAccessRevokeInput = typeof TeamMemberAccessRevokeInput.Type;

export const TeamThreadShareSetInput = Schema.Struct({
  threadId: ThreadId,
  organizationId: TrimmedNonEmptyString,
  access: TeamThreadAccess,
});
export type TeamThreadShareSetInput = typeof TeamThreadShareSetInput.Type;

export const TeamThreadShareClearInput = Schema.Struct({
  threadId: ThreadId,
});
export type TeamThreadShareClearInput = typeof TeamThreadShareClearInput.Type;

export const TeamPresenceReportInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  typing: Schema.Boolean,
});
export type TeamPresenceReportInput = typeof TeamPresenceReportInput.Type;

export const TeamPresenceSnapshot = Schema.Struct({
  entries: Schema.Array(TeamPresenceEntry),
});
export type TeamPresenceSnapshot = typeof TeamPresenceSnapshot.Type;

export const TeamConnectivityDriver = Schema.Literals(["claudeAgent", "codex"]);
export type TeamConnectivityDriver = typeof TeamConnectivityDriver.Type;

export const TeamConnectivityState = Schema.Literals(["ready", "not_configured", "unavailable"]);
export type TeamConnectivityState = typeof TeamConnectivityState.Type;

export const TeamConnectivityOrganizationStatus = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  state: TeamConnectivityState,
  drivers: Schema.Array(TeamConnectivityDriver),
  checkedAt: IsoDateTime,
});
export type TeamConnectivityOrganizationStatus = typeof TeamConnectivityOrganizationStatus.Type;

export const TeamConnectivityStatus = Schema.Struct({
  organizations: Schema.Array(TeamConnectivityOrganizationStatus),
});
export type TeamConnectivityStatus = typeof TeamConnectivityStatus.Type;

export const TeamConnectivityStatusInput = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean),
});
export type TeamConnectivityStatusInput = typeof TeamConnectivityStatusInput.Type;

export const TeamAgentProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type TeamAgentProject = typeof TeamAgentProject.Type;

export const TeamAgentStatus = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  projects: Schema.Array(TeamAgentProject),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamAgentStatus = typeof TeamAgentStatus.Type;

export const TeamAgentStatuses = Schema.Struct({
  agents: Schema.Array(TeamAgentStatus),
});
export type TeamAgentStatuses = typeof TeamAgentStatuses.Type;

export const TeamAgentSetInput = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  projectIds: Schema.Array(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamAgentSetInput = typeof TeamAgentSetInput.Type;

export const TEAM_AGENT_QUESTION_MAX_LENGTH = 8000;

export const TeamAgentAskInput = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(TEAM_AGENT_QUESTION_MAX_LENGTH)),
});
export type TeamAgentAskInput = typeof TeamAgentAskInput.Type;

export const TeamAgentAskResult = Schema.Struct({
  threadId: ThreadId,
});
export type TeamAgentAskResult = typeof TeamAgentAskResult.Type;

export const ProjectTeamShare = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  sharedAt: IsoDateTime,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type ProjectTeamShare = typeof ProjectTeamShare.Type;

export const TeamProjectShareSetInput = Schema.Struct({
  projectId: ProjectId,
  organizationId: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type TeamProjectShareSetInput = typeof TeamProjectShareSetInput.Type;

export const TeamProjectShareClearInput = Schema.Struct({
  projectId: ProjectId,
});
export type TeamProjectShareClearInput = typeof TeamProjectShareClearInput.Type;

export const TeamProjectThreadStartInput = Schema.Struct({
  projectId: ProjectId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(TEAM_AGENT_QUESTION_MAX_LENGTH)),
});
export type TeamProjectThreadStartInput = typeof TeamProjectThreadStartInput.Type;

export const TeamProjectThreadStartResult = Schema.Struct({
  threadId: ThreadId,
});
export type TeamProjectThreadStartResult = typeof TeamProjectThreadStartResult.Type;

export class TeamAccessError extends Schema.TaggedError<TeamAccessError>()("TeamAccessError", {
  reason: Schema.Literals([
    "not_allowed_for_teammates",
    "organization_not_shared",
    "thread_not_shared",
    "thread_view_only",
    "thread_unavailable",
    "agent_off",
    "agent_project_not_allowed",
    "agent_provider_unsupported",
    "agent_busy",
    "project_not_shared",
    "project_unavailable",
    "internal",
  ]),
  message: Schema.String,
}) {}
