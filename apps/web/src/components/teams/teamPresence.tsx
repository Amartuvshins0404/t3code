import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ScopedThreadRef,
  TeamPerson,
  TeamPresenceSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useCloudAuth } from "~/cloud/cloudAuth";
import { useIsTeammateEnvironment, useTeamMachine } from "~/cloud/teamWorkspace";
import { serverEnvironment } from "~/state/server";
import { Avatar, AvatarStack, type AvatarStackPerson } from "../ui/avatar";
import { useThreadTeamShare } from "./teamShareAvailability";

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

export interface TeamMessageSender {
  readonly person: TeamPerson;
  readonly self: boolean;
}

export function useTeamMessageSender(
  threadRef: ScopedThreadRef | null,
  member: TeamPerson | undefined,
): TeamMessageSender | null {
  const shared = useThreadTeamShare(threadRef) !== null;
  const teammate = useIsTeammateEnvironment(threadRef?.environmentId ?? null);
  const owner = useTeamMachine(threadRef?.environmentId ?? null)?.owner ?? null;
  const auth = useCloudAuth();
  if (member !== undefined) return { person: member, self: member.userId === auth.userId };
  if (!shared) return null;
  if (teammate) return owner ? { person: owner, self: false } : null;
  if (!auth.user) return null;
  return {
    person: {
      userId: auth.user.id,
      name: auth.user.name,
      ...(auth.user.image ? { image: auth.user.image } : {}),
    },
    self: true,
  };
}

export function TeamMessageSenderLine({ sender }: { readonly sender: TeamMessageSender }) {
  return (
    <p aria-hidden className="me-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
      <Avatar
        name={sender.person.name}
        src={sender.person.image ?? null}
        seed={sender.person.userId}
        size="xs"
      />
      {sender.self ? "You" : sender.person.name}
    </p>
  );
}
