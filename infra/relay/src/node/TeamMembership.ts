import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Reactivity from "effect/reactivity/Reactivity";

import * as TeamMembership from "../auth/TeamMembership.ts";

interface AuthMemberRow {
  readonly user_id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
  readonly organization_id: string;
  readonly organization_slug: string;
  readonly role: string;
}

export const layer = Layer.effect(
  TeamMembership.TeamMembership,
  Effect.gen(function* () {
    const url = yield* Config.option(Config.Redacted("AUTH_DATABASE_URL"));
    if (Option.isNone(url)) {
      yield* Effect.logWarning("AUTH_DATABASE_URL is not set; team access is off");
      return TeamMembership.unavailable;
    }
    const client = yield* PgClient.make({ url: url.value, maxConnections: 4 });
    return TeamMembership.TeamMembership.of({
      available: true,
      members: Effect.fn("relay.team_membership.members")(function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
        if (input.userIds.length === 0) return [];
        const rows = yield* client<AuthMemberRow>`
          select u.id as user_id, u.name, u.email, u.image,
            o.id as organization_id, o.slug as organization_slug, m.role
          from member m
          join organization o on o.id = m."organizationId"
          join "user" u on u.id = m."userId"
          where m."organizationId" = ${input.organizationId}
            and m."userId" in ${client.in(input.userIds)}
        `.pipe(
          Effect.mapError(
            (cause) =>
              new TeamMembership.TeamMembershipLookupError({
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
        return TeamMembership.toTeamMembers(
          rows.map((row) => ({
            userId: row.user_id,
            name: row.name,
            email: row.email,
            image: row.image,
            organizationId: row.organization_id,
            organizationSlug: row.organization_slug,
            role: row.role,
          })),
        );
      }),
    });
  }),
).pipe(Layer.provide(Reactivity.layer));
