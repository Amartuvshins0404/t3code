import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentTeamShareRecord,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, asc, eq, isNull } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks, relayEnvironmentTeamShares } from "../persistence/schema.ts";
import type { RelayLinkedEnvironmentRecord } from "./EnvironmentLinks.ts";

export class EnvironmentTeamSharePersistenceError extends Schema.TaggedError<EnvironmentTeamSharePersistenceError>()(
  "EnvironmentTeamSharePersistenceError",
  {
    operation: Schema.Literals([
      "share",
      "unshare",
      "list-for-environment",
      "list-for-organization",
      "revoke-for-owner",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment team share query '${this.operation}' failed`;
  }
}

export interface EnvironmentTeamShare extends RelayEnvironmentTeamShareRecord {
  readonly ownerUserId: string;
}

export interface SharedTeamEnvironment {
  readonly share: EnvironmentTeamShare;
  readonly link: RelayLinkedEnvironmentRecord;
}

export class EnvironmentTeamShares extends Context.Service<
  EnvironmentTeamShares,
  {
    readonly share: (input: {
      readonly environmentId: string;
      readonly organizationId: string;
      readonly ownerUserId: string;
    }) => Effect.Effect<EnvironmentTeamShare, EnvironmentTeamSharePersistenceError>;
    readonly unshare: (input: {
      readonly environmentId: string;
      readonly organizationId: string;
    }) => Effect.Effect<boolean, EnvironmentTeamSharePersistenceError>;
    readonly listForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<EnvironmentTeamShare>, EnvironmentTeamSharePersistenceError>;
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<SharedTeamEnvironment>, EnvironmentTeamSharePersistenceError>;
    readonly revokeForOwner: (input: {
      readonly environmentId: string;
      readonly ownerUserId: string;
    }) => Effect.Effect<void, EnvironmentTeamSharePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentTeamShares") {}

type EnvironmentId = RelayClientEnvironmentRecord["environmentId"];

const shareColumns = {
  environmentId: relayEnvironmentTeamShares.environmentId,
  organizationId: relayEnvironmentTeamShares.organizationId,
  ownerUserId: relayEnvironmentTeamShares.ownerUserId,
  createdAt: relayEnvironmentTeamShares.createdAt,
};

function toShare(row: {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
}): EnvironmentTeamShare {
  return {
    environmentId: row.environmentId as EnvironmentId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    sharedAt: row.createdAt,
  };
}

const persistenceError =
  (operation: EnvironmentTeamSharePersistenceError["operation"]) => (cause: unknown) =>
    new EnvironmentTeamSharePersistenceError({ operation, cause });

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return EnvironmentTeamShares.of({
    share: Effect.fn("relay.environment_team_shares.share")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.organization_id": input.organizationId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayEnvironmentTeamShares)
        .values({
          environmentId: input.environmentId,
          organizationId: input.organizationId,
          ownerUserId: input.ownerUserId,
          createdAt: now,
          revokedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            relayEnvironmentTeamShares.environmentId,
            relayEnvironmentTeamShares.organizationId,
          ],
          set: { ownerUserId: input.ownerUserId, createdAt: now, revokedAt: null },
        })
        .returning(shareColumns)
        .pipe(Effect.mapError(persistenceError("share")));
      const row = rows[0];
      return row ? toShare(row) : toShare({ ...input, createdAt: now });
    }),

    unshare: Effect.fn("relay.environment_team_shares.unshare")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.organization_id": input.organizationId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentTeamShares)
        .set({ revokedAt })
        .where(
          and(
            eq(relayEnvironmentTeamShares.environmentId, input.environmentId),
            eq(relayEnvironmentTeamShares.organizationId, input.organizationId),
            isNull(relayEnvironmentTeamShares.revokedAt),
          ),
        )
        .returning({ environmentId: relayEnvironmentTeamShares.environmentId })
        .pipe(Effect.mapError(persistenceError("unshare")));
      return rows.length > 0;
    }),

    listForEnvironment: Effect.fn("relay.environment_team_shares.list_for_environment")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
        const rows = yield* db
          .select(shareColumns)
          .from(relayEnvironmentTeamShares)
          .where(
            and(
              eq(relayEnvironmentTeamShares.environmentId, input.environmentId),
              isNull(relayEnvironmentTeamShares.revokedAt),
            ),
          )
          .orderBy(asc(relayEnvironmentTeamShares.createdAt))
          .pipe(Effect.mapError(persistenceError("list-for-environment")));
        return rows.map(toShare);
      },
    ),

    listForOrganization: Effect.fn("relay.environment_team_shares.list_for_organization")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
        const rows = yield* db
          .select({
            ...shareColumns,
            environmentLabel: relayEnvironmentLinks.environmentLabel,
            environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
            endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
            endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
            endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
            linkedAt: relayEnvironmentLinks.createdAt,
          })
          .from(relayEnvironmentTeamShares)
          .innerJoin(
            relayEnvironmentLinks,
            and(
              eq(relayEnvironmentLinks.environmentId, relayEnvironmentTeamShares.environmentId),
              eq(relayEnvironmentLinks.userId, relayEnvironmentTeamShares.ownerUserId),
              isNull(relayEnvironmentLinks.revokedAt),
            ),
          )
          .where(
            and(
              eq(relayEnvironmentTeamShares.organizationId, input.organizationId),
              isNull(relayEnvironmentTeamShares.revokedAt),
            ),
          )
          .orderBy(asc(relayEnvironmentTeamShares.createdAt))
          .pipe(Effect.mapError(persistenceError("list-for-organization")));
        return rows.map((row) => ({
          share: toShare(row),
          link: {
            environmentId: row.environmentId as EnvironmentId,
            label:
              row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
            endpoint: {
              httpBaseUrl: row.endpointHttpBaseUrl,
              wsBaseUrl: row.endpointWsBaseUrl,
              providerKind:
                row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
            },
            environmentPublicKey: row.environmentPublicKey,
            linkedAt: row.linkedAt,
          },
        }));
      },
    ),

    revokeForOwner: Effect.fn("relay.environment_team_shares.revoke_for_owner")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayEnvironmentTeamShares)
        .set({ revokedAt })
        .where(
          and(
            eq(relayEnvironmentTeamShares.environmentId, input.environmentId),
            eq(relayEnvironmentTeamShares.ownerUserId, input.ownerUserId),
            isNull(relayEnvironmentTeamShares.revokedAt),
          ),
        )
        .pipe(Effect.mapError(persistenceError("revoke-for-owner")));
    }),
  });
});

export const layer = Layer.effect(EnvironmentTeamShares, make);
