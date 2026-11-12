import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";

export const layer = Layer.effect(
  RelayDb.RelayDb,
  Effect.gen(function* () {
    const migrationsFolder = yield* Config.String("RELAY_MIGRATIONS_DIR").pipe(
      Config.withDefault(new URL("../../migrations/postgres", import.meta.url).pathname),
    );
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrate(db, { migrationsFolder, migrationsTable: "relay_migrations" });
    yield* Effect.logInfo("Relay database migrations applied");
    return db;
  }),
).pipe(
  Layer.provide(
    Layer.unwrap(Effect.map(Config.Redacted("DATABASE_URL"), (url) => PgClient.layer({ url }))),
  ),
);
