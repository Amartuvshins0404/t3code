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
