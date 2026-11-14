import type { TeamPerson, TeamPresenceEntry, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface TeamPresenceRecord {
  readonly entry: TeamPresenceEntry;
  readonly organizationId: string | undefined;
}

export class TeamPresence extends Context.Service<
  TeamPresence,
  {
    readonly join: (input: {
      readonly clientId: string;
      readonly person?: TeamPerson | undefined;
      readonly organizationId?: string | undefined;
    }) => Effect.Effect<void>;
    readonly report: (
      clientId: string,
      input: { readonly threadId?: ThreadId | undefined; readonly typing: boolean },
    ) => Effect.Effect<void>;
    readonly leave: (clientId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<ReadonlyArray<TeamPresenceRecord>>;
  }
>()("t3/team/TeamPresence") {}

const sameEntry = (left: TeamPresenceEntry, right: TeamPresenceEntry) =>
  left.threadId === right.threadId && left.typing === right.typing;

const make = Effect.gen(function* () {
  const records = yield* SubscriptionRef.make<ReadonlyMap<string, TeamPresenceRecord>>(new Map());

  const join: TeamPresence["Service"]["join"] = (input) =>
    SubscriptionRef.update(records, (current) => {
      const next = new Map(current);
      next.set(input.clientId, {
        entry: {
          clientId: input.clientId,
          ...(input.person === undefined ? {} : { person: input.person }),
          owner: input.person === undefined,
          typing: false,
        },
        organizationId: input.organizationId,
      });
      return next;
    });

  const report: TeamPresence["Service"]["report"] = (clientId, input) =>
    SubscriptionRef.update(records, (current) => {
      const record = current.get(clientId);
      if (record === undefined) return current;
      const { threadId: _threadId, ...rest } = record.entry;
      const entry: TeamPresenceEntry = {
        ...rest,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        typing: input.threadId !== undefined && input.typing,
      };
      if (sameEntry(entry, record.entry)) return current;
      const next = new Map(current);
      next.set(clientId, { ...record, entry });
      return next;
    });

  const leave: TeamPresence["Service"]["leave"] = (clientId) =>
    SubscriptionRef.update(records, (current) => {
      if (!current.has(clientId)) return current;
      const next = new Map(current);
      next.delete(clientId);
      return next;
    });

  return TeamPresence.of({
    join,
    report,
    leave,
    changes: SubscriptionRef.changes(records).pipe(
      Stream.changes,
      Stream.map((current) => [...current.values()]),
    ),
  });
});

export const layer = Layer.effect(TeamPresence, make);
