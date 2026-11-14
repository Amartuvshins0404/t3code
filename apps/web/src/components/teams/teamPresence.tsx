import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TeamPerson, TeamPresenceSnapshot, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useCloudAuth } from "~/cloud/cloudAuth";
import { serverEnvironment } from "~/state/server";
import { AvatarStack, type AvatarStackPerson } from "../ui/avatar";

const EMPTY_PRESENCE_ATOM = Atom.make(AsyncResult.initial<TeamPresenceSnapshot>()).pipe(
  Atom.withLabel("team-presence:empty"),
);

export interface PresenceFilter {
  readonly threadId: ThreadId | null;
  readonly typingOnly?: boolean;
  readonly selfUserId: string | null;
  readonly selfIsOwner: boolean;
  readonly owner: TeamPerson | null;
}

function presenceKey(
  result: AsyncResult.AsyncResult<TeamPresenceSnapshot, unknown>,
  filter: PresenceFilter,
): string {
  const snapshot = AsyncResult.getOrElse(result, () => null);
  if (snapshot === null) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of snapshot.entries) {
    if (filter.threadId !== null && entry.threadId !== filter.threadId) continue;
    if (filter.typingOnly && !entry.typing) continue;
    const person = entry.owner ? filter.owner : (entry.person ?? null);
    if (person === null) continue;
    if (entry.owner ? filter.selfIsOwner : person.userId === filter.selfUserId) continue;
    if (seen.has(person.userId)) continue;
    seen.add(person.userId);
    lines.push([person.userId, person.name, person.image ?? ""].join("\t"));
  }
  return lines.join("\n");
}

function parsePresenceKey(key: string): ReadonlyArray<AvatarStackPerson> {
  if (key === "") return [];
  return key.split("\n").map((line) => {
    const [id = "", name = "", image = ""] = line.split("\t");
    return { id, name, image: image === "" ? null : image };
  });
}

export function usePresencePeople(
  environmentId: EnvironmentId | null,
  filter: PresenceFilter,
): ReadonlyArray<AvatarStackPerson> {
  const key = useAtomValue(
    environmentId === null
      ? EMPTY_PRESENCE_ATOM
      : serverEnvironment.teamPresence({ environmentId, input: {} }),
    (result) => presenceKey(result, filter),
  );
  return parsePresenceKey(key);
}

export function useSelfUserId(): string | null {
  return useCloudAuth().userId;
}

export function PresenceAvatars({
  people,
  size = "xs",
}: {
  readonly people: ReadonlyArray<AvatarStackPerson>;
  readonly size?: "xs" | "sm";
}) {
  if (people.length === 0) return null;
  return <AvatarStack people={people} size={size} max={3} />;
}

export function typingLine(people: ReadonlyArray<AvatarStackPerson>): string | null {
  const [first, second] = people;
  if (!first) return null;
  if (!second) return `${first.name} is typing…`;
  if (people.length === 2) return `${first.name} and ${second.name} are typing…`;
  return `${first.name} and ${people.length - 1} others are typing…`;
}
