import type { TeamPerson } from "@t3tools/contracts";
import type { RelayTeamConnectivityRecord } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { eq, inArray } from "drizzle-orm";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayTeamConnectivity } from "../persistence/schema.ts";
import { makeTeamConnectivityLock } from "./TeamConnectivityLock.ts";

export class TeamConnectivityPersistenceError extends Schema.TaggedError<TeamConnectivityPersistenceError>()(
  "TeamConnectivityPersistenceError",
  {
    operation: Schema.Literals(["get", "set", "remove", "list-with-keys", "seal-key", "open-key"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Team connectivity query '${this.operation}' failed`;
  }
}

export interface TeamConnectivityWithKey {
  readonly organizationId: string;
  readonly url: string;
  readonly clientKey: Redacted.Redacted<string>;
  readonly version: string;
}

export class TeamConnectivity extends Context.Service<
  TeamConnectivity,
  {
    readonly get: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<RelayTeamConnectivityRecord | null, TeamConnectivityPersistenceError>;
    readonly set: (input: {
      readonly organizationId: string;
      readonly url: string;
      readonly clientKey: Redacted.Redacted<string>;
      readonly updatedBy: TeamPerson;
    }) => Effect.Effect<RelayTeamConnectivityRecord, TeamConnectivityPersistenceError>;
    readonly remove: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<boolean, TeamConnectivityPersistenceError>;
    readonly listWithKeys: (input: {
      readonly organizationIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<TeamConnectivityWithKey>, TeamConnectivityPersistenceError>;
  }
>()("t3code-relay/teams/TeamConnectivity") {}

const recordColumns = {
  organizationId: relayTeamConnectivity.organizationId,
  url: relayTeamConnectivity.url,
  version: relayTeamConnectivity.version,
  updatedAt: relayTeamConnectivity.updatedAt,
  updatedByJson: relayTeamConnectivity.updatedByJson,
};

function toRecord(row: {
  readonly organizationId: string;
  readonly url: string;
  readonly version: string;
  readonly updatedAt: string;
  readonly updatedByJson: TeamPerson;
}): RelayTeamConnectivityRecord {
  return {
    organizationId: row.organizationId,
    url: row.url,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: {
      userId: row.updatedByJson.userId,
      name: row.updatedByJson.name,
      ...(row.updatedByJson.image ? { image: row.updatedByJson.image } : {}),
    },
  };
}

const persistenceError =
  (operation: TeamConnectivityPersistenceError["operation"]) => (cause: unknown) =>
    new TeamConnectivityPersistenceError({ operation, cause });

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* makeTeamConnectivityLock(config.cloudMintPrivateKey).pipe(Effect.orDie);

  return TeamConnectivity.of({
    get: Effect.fn("relay.team_connectivity.get")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const rows = yield* db
        .select(recordColumns)
        .from(relayTeamConnectivity)
        .where(eq(relayTeamConnectivity.organizationId, input.organizationId))
        .limit(1)
        .pipe(Effect.mapError(persistenceError("get")));
      const row = rows[0];
      return row ? toRecord(row) : null;
    }),

    set: Effect.fn("relay.team_connectivity.set")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const clientKeyCiphertext = yield* lock
        .seal({ organizationId: input.organizationId, clientKey: input.clientKey })
        .pipe(Effect.mapError(persistenceError("seal-key")));
      const values = {
        url: input.url,
        clientKeyCiphertext,
        version: yield* random.uuidV4(),
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        updatedByJson: {
          userId: input.updatedBy.userId,
          name: input.updatedBy.name,
          ...(input.updatedBy.image ? { image: input.updatedBy.image } : {}),
        },
      };
      yield* db
        .insert(relayTeamConnectivity)
        .values({ organizationId: input.organizationId, ...values })
        .onConflictDoUpdate({ target: relayTeamConnectivity.organizationId, set: values })
        .pipe(Effect.mapError(persistenceError("set")));
      return toRecord({ organizationId: input.organizationId, ...values });
    }),

    remove: Effect.fn("relay.team_connectivity.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const rows = yield* db
        .delete(relayTeamConnectivity)
        .where(eq(relayTeamConnectivity.organizationId, input.organizationId))
        .returning({ organizationId: relayTeamConnectivity.organizationId })
        .pipe(Effect.mapError(persistenceError("remove")));
      return rows.length > 0;
    }),

    listWithKeys: Effect.fn("relay.team_connectivity.list_with_keys")(function* (input) {
      if (input.organizationIds.length === 0) return [];
      const rows = yield* db
        .select({
          organizationId: relayTeamConnectivity.organizationId,
          url: relayTeamConnectivity.url,
          version: relayTeamConnectivity.version,
          clientKeyCiphertext: relayTeamConnectivity.clientKeyCiphertext,
        })
        .from(relayTeamConnectivity)
        .where(inArray(relayTeamConnectivity.organizationId, [...input.organizationIds]))
        .pipe(Effect.mapError(persistenceError("list-with-keys")));
      return yield* Effect.forEach(rows, (row) =>
        lock.open({ organizationId: row.organizationId, sealed: row.clientKeyCiphertext }).pipe(
          Effect.map((clientKey) => ({
            organizationId: row.organizationId,
            url: row.url,
            clientKey,
            version: row.version,
          })),
          Effect.mapError(persistenceError("open-key")),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(TeamConnectivity, make);
