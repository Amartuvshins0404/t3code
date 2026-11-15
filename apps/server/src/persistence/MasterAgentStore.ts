import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type MasterAgentStoreError = PersistenceSqlError | PersistenceDecodeError;

export const MasterAgentMemoryEntry = Schema.Struct({
  key: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
});
export type MasterAgentMemoryEntry = typeof MasterAgentMemoryEntry.Type;

const ThreadIdRow = Schema.Struct({ threadId: ThreadId });

export class MasterAgentStore extends Context.Service<
  MasterAgentStore,
  {
    readonly readThreadId: Effect.Effect<ThreadId | null, MasterAgentStoreError>;
    /** Stores `candidate` unless an id is already stored, and returns the stored id. */
    readonly claimThreadId: (candidate: ThreadId) => Effect.Effect<ThreadId, MasterAgentStoreError>;
    /** Swaps `previous` for `next` only while `previous` is stored, and returns the stored id. */
    readonly replaceThreadId: (input: {
      readonly previous: ThreadId;
      readonly next: ThreadId;
    }) => Effect.Effect<ThreadId, MasterAgentStoreError>;
    readonly listMemory: Effect.Effect<
      ReadonlyArray<MasterAgentMemoryEntry>,
      MasterAgentStoreError
    >;
    /** Null content deletes. Writes only while all entries stay within `limitBytes`. */
    readonly writeMemory: (input: {
      readonly key: string;
      readonly content: string | null;
      readonly updatedAt: string;
      readonly limitBytes: number;
    }) => Effect.Effect<
      { readonly written: boolean; readonly otherBytes: number; readonly requestedBytes: number },
      MasterAgentStoreError
    >;
  }
>()("t3/persistence/MasterAgentStore") {}

const encoder = new TextEncoder();
export const masterAgentMemoryEntryBytes = (entry: {
  readonly key: string;
  readonly content: string;
}) => encoder.encode(entry.key).length + encoder.encode(entry.content).length;

const toStoreError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectThreadId = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadIdRow,
    execute: () => sql`SELECT thread_id AS "threadId" FROM master_agent WHERE id = 1`,
  });
  const selectMemory = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MasterAgentMemoryEntry,
    execute: () => sql`
      SELECT key AS "key", content AS "content", updated_at AS "updatedAt"
      FROM master_agent_memory
      ORDER BY key
    `,
  });

  const readThreadId = selectThreadId(undefined).pipe(
    Effect.map((rows) => rows[0]?.threadId ?? null),
    Effect.mapError(toStoreError("MasterAgentStore.readThreadId")),
  );

  const storedThreadId = (operation: string) =>
    selectThreadId(undefined).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(new PersistenceSqlError({ operation, detail: "No master thread stored." }))
          : Effect.succeed(rows[0].threadId),
      ),
    );

  return MasterAgentStore.of({
    readThreadId,
    claimThreadId: Effect.fn("MasterAgentStore.claimThreadId")(function* (candidate) {
      return yield* sql`
        INSERT INTO master_agent (id, thread_id) VALUES (1, ${candidate})
        ON CONFLICT (id) DO NOTHING
      `.pipe(
        Effect.andThen(storedThreadId("MasterAgentStore.claimThreadId")),
        sql.withTransaction,
        Effect.mapError(toStoreError("MasterAgentStore.claimThreadId")),
      );
    }),
    replaceThreadId: Effect.fn("MasterAgentStore.replaceThreadId")(function* (input) {
      return yield* sql`
        UPDATE master_agent SET thread_id = ${input.next}
        WHERE id = 1 AND thread_id = ${input.previous}
      `.pipe(
        Effect.andThen(storedThreadId("MasterAgentStore.replaceThreadId")),
        sql.withTransaction,
        Effect.mapError(toStoreError("MasterAgentStore.replaceThreadId")),
      );
    }),
    listMemory: selectMemory(undefined).pipe(
      Effect.mapError(toStoreError("MasterAgentStore.listMemory")),
    ),
    writeMemory: Effect.fn("MasterAgentStore.writeMemory")(function* (input) {
      return yield* Effect.gen(function* () {
        const entries = yield* selectMemory(undefined);
        const otherBytes = entries
          .filter((entry) => entry.key !== input.key)
          .reduce((total, entry) => total + masterAgentMemoryEntryBytes(entry), 0);
        const requestedBytes =
          input.content === null
            ? 0
            : masterAgentMemoryEntryBytes({ key: input.key, content: input.content });
        if (otherBytes + requestedBytes > input.limitBytes)
          return { written: false, otherBytes, requestedBytes } as const;
        if (input.content === null) {
          yield* sql`DELETE FROM master_agent_memory WHERE key = ${input.key}`;
        } else {
          yield* sql`
            INSERT INTO master_agent_memory (key, content, updated_at)
            VALUES (${input.key}, ${input.content}, ${input.updatedAt})
            ON CONFLICT (key) DO UPDATE SET
              content = excluded.content,
              updated_at = excluded.updated_at
          `;
        }
        return { written: true, otherBytes, requestedBytes } as const;
      }).pipe(sql.withTransaction, Effect.mapError(toStoreError("MasterAgentStore.writeMemory")));
    }),
  });
});

export const layer = Layer.effect(MasterAgentStore, make);
