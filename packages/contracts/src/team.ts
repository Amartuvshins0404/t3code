import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const ThreadTeamShare = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  access: TeamThreadAccess,
  sharedAt: IsoDateTime,
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

export class TeamAccessError extends Schema.TaggedError<TeamAccessError>()("TeamAccessError", {
  reason: Schema.Literals([
    "not_allowed_for_teammates",
    "organization_not_shared",
    "thread_not_shared",
    "thread_view_only",
    "thread_unavailable",
    "internal",
  ]),
  message: Schema.String,
}) {}
