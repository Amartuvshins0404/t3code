import type { TeamMemberIdentity, TeamRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class TeamMembershipLookupError extends Schema.TaggedError<TeamMembershipLookupError>()(
  "TeamMembershipLookupError",
  {
    organizationId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the members of organization '${this.organizationId}'`;
  }
}

export class TeamMembership extends Context.Service<
  TeamMembership,
  {
    readonly available: boolean;
    readonly members: (input: {
      readonly organizationId: string;
      readonly userIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<TeamMemberIdentity>, TeamMembershipLookupError>;
  }
>()("t3code-relay/auth/TeamMembership") {}

export interface TeamMemberRow {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly role: string;
}

const ROLE_RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

export function highestTeamRole(role: string): TeamRole {
  const roles = role.split(",").map((part) => part.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function toTeamMembers(rows: ReadonlyArray<TeamMemberRow>): Array<TeamMemberIdentity> {
  const byUser = new Map<string, TeamMemberIdentity>();
  for (const row of rows) {
    const email = nonEmpty(row.email);
    const image = nonEmpty(row.image);
    const member: TeamMemberIdentity = {
      userId: row.userId,
      name: nonEmpty(row.name) ?? email ?? row.userId,
      ...(image ? { image } : {}),
      ...(email ? { email } : {}),
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      role: highestTeamRole(row.role),
    };
    const existing = byUser.get(row.userId);
    if (!existing || ROLE_RANK[member.role] > ROLE_RANK[existing.role]) {
      byUser.set(row.userId, member);
    }
  }
  return [...byUser.values()];
}

export function findMember(
  membership: TeamMembership["Service"],
  input: { readonly userId: string; readonly organizationId: string },
): Effect.Effect<TeamMemberIdentity | null, TeamMembershipLookupError> {
  return membership
    .members({ organizationId: input.organizationId, userIds: [input.userId] })
    .pipe(
      Effect.map((members) => members.find((member) => member.userId === input.userId) ?? null),
    );
}

export const unavailable = TeamMembership.of({
  available: false,
  members: Effect.fn("relay.team_membership.members_unavailable")(function* () {
    return yield* Effect.succeed([]);
  }),
});

export const layerUnavailable = Layer.succeed(TeamMembership, unavailable);
