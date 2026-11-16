import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export function hideMasterAgentThreadKeys<
  Shells extends {
    readonly hiddenThreadKeysAtom: Atom.Atom<ReadonlySet<string>>;
    readonly masterAgentThreadIdsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ThreadId>>;
  },
>(shells: Shells): Shells {
  let previous: ReadonlySet<string> = new Set();
  const hiddenThreadKeysAtom = Atom.make((get) => {
    const hidden = get(shells.hiddenThreadKeysAtom);
    const agentKeys = Array.from(
      get(shells.masterAgentThreadIdsAtom),
      ([environmentId, threadId]) => threadKey({ environmentId, threadId }),
    );
    if (agentKeys.every((key) => hidden.has(key))) return hidden;
    const next = new Set([...hidden, ...agentKeys]);
    if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel("mobile:hidden-thread-keys-with-master-agent"));
  return { ...shells, hiddenThreadKeysAtom };
}
