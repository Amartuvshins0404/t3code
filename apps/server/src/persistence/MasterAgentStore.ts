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

export const MasterAgentWatchRow = Schema.Struct({
  threadId: ThreadId,
  startedAt: Schema.String,
  notice: Schema.NullOr(Schema.String),
  batchId: Schema.NullOr(Schema.String),
});
export type MasterAgentWatchRow = typeof MasterAgentWatchRow.Type;

/** A delivered "needs you" notice: the watch stays on to report how the thread ends. */
export const NEEDS_YOU_TOLD = "needs-you-told";

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
    readonly listWatches: Effect.Effect<ReadonlyArray<MasterAgentWatchRow>, MasterAgentStoreError>;
    /** Starts or restarts the watch, dropping any notice it had not delivered yet. */
    readonly addWatch: (input: {
      readonly threadId: ThreadId;
      readonly startedAt: string;
    }) => Effect.Effect<void, MasterAgentStoreError>;
    readonly removeWatch: (threadId: ThreadId) => Effect.Effect<void, MasterAgentStoreError>;
    /** Changes only the watch that started at `startedAt` and is not being delivered. */
    readonly setWatchNotice: (input: {
      readonly threadId: ThreadId;
      readonly startedAt: string;
      readonly notice: string | null;
    }) => Effect.Effect<void, MasterAgentStoreError>;
    /** Puts every undelivered notice into batch `batchId`, unless an earlier batch is still owed. */
    readonly claimNoticeBatch: (
      batchId: string,
    ) => Effect.Effect<ReadonlyArray<MasterAgentWatchRow>, MasterAgentStoreError>;
    /** Ends a delivered batch; `keep` rows were told the thread needs the owner and stay watched. */
    readonly finishNoticeBatch: (input: {
      readonly batchId: string;
      readonly keep: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<void, MasterAgentStoreError>;
    /** Returns an undeliverable batch to the queue, to go out under a new id. */
    readonly releaseNoticeBatch: (batchId: string) => Effect.Effect<void, MasterAgentStoreError>;
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

  const watchColumns = sql`
    thread_id AS "threadId", started_at AS "startedAt", notice AS "notice", batch_id AS "batchId"
  `;
  const selectWatches = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MasterAgentWatchRow,
    execute: () => sql`SELECT ${watchColumns} FROM master_agent_watch ORDER BY started_at`,
  });
  const selectBatch = SqlSchema.findAll({
    Request: Schema.String,
    Result: MasterAgentWatchRow,
    execute: (batchId) => sql`
      SELECT ${watchColumns} FROM master_agent_watch
      WHERE batch_id = ${batchId}
      ORDER BY started_at
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
    listWatches: selectWatches(undefined).pipe(
      Effect.mapError(toStoreError("MasterAgentStore.listWatches")),
    ),
    addWatch: Effect.fn("MasterAgentStore.addWatch")(function* (input) {
      yield* sql`
        INSERT INTO master_agent_watch (thread_id, started_at, notice, batch_id)
        VALUES (${input.threadId}, ${input.startedAt}, NULL, NULL)
        ON CONFLICT (thread_id) DO UPDATE SET
          started_at = excluded.started_at,
          notice = NULL,
          batch_id = NULL
      `.pipe(Effect.mapError(toStoreError("MasterAgentStore.addWatch")));
    }),
    removeWatch: Effect.fn("MasterAgentStore.removeWatch")(function* (threadId) {
      yield* sql`DELETE FROM master_agent_watch WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(toStoreError("MasterAgentStore.removeWatch")),
      );
    }),
    setWatchNotice: Effect.fn("MasterAgentStore.setWatchNotice")(function* (input) {
      yield* sql`
        UPDATE master_agent_watch SET notice = ${input.notice}
        WHERE thread_id = ${input.threadId}
          AND started_at = ${input.startedAt}
          AND batch_id IS NULL
      `.pipe(Effect.mapError(toStoreError("MasterAgentStore.setWatchNotice")));
    }),
    claimNoticeBatch: Effect.fn("MasterAgentStore.claimNoticeBatch")(function* (batchId) {
      return yield* Effect.gen(function* () {
        const owed = yield* sql<{ readonly batchId: string }>`
          SELECT batch_id AS "batchId" FROM master_agent_watch
          WHERE batch_id IS NOT NULL
          ORDER BY batch_id
          LIMIT 1
        `;
        const claimed = owed[0]?.batchId ?? batchId;
        if (owed[0] === undefined) {
          yield* sql`
            UPDATE master_agent_watch SET batch_id = ${batchId}
            WHERE notice IS NOT NULL AND notice != ${NEEDS_YOU_TOLD} AND batch_id IS NULL
          `;
        }
        return yield* selectBatch(claimed);
      }).pipe(
        sql.withTransaction,
        Effect.mapError(toStoreError("MasterAgentStore.claimNoticeBatch")),
      );
    }),
    finishNoticeBatch: Effect.fn("MasterAgentStore.finishNoticeBatch")(function* (input) {
      yield* Effect.gen(function* () {
        if (input.keep.length > 0)
          yield* sql`
            UPDATE master_agent_watch SET batch_id = NULL, notice = ${NEEDS_YOU_TOLD}
            WHERE batch_id = ${input.batchId} AND thread_id IN ${sql.in(input.keep)}
          `;
        yield* sql`DELETE FROM master_agent_watch WHERE batch_id = ${input.batchId}`;
      }).pipe(
        sql.withTransaction,
        Effect.mapError(toStoreError("MasterAgentStore.finishNoticeBatch")),
      );
    }),
    releaseNoticeBatch: Effect.fn("MasterAgentStore.releaseNoticeBatch")(function* (batchId) {
      yield* sql`UPDATE master_agent_watch SET batch_id = NULL WHERE batch_id = ${batchId}`.pipe(
        Effect.mapError(toStoreError("MasterAgentStore.releaseNoticeBatch")),
      );
    }),
  });
});

export const layer = Layer.effect(MasterAgentStore, make);
