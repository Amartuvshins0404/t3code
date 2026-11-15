import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { hideMasterAgentThreadKeys } from "./master-agent-threads";

it("hides every connected environment's agent thread from pending rows next to tag-hidden threads", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const localAgent = ThreadId.make("agent-local");
  const remoteAgent = ThreadId.make("agent-remote");
  const tagHidden = threadKey({ environmentId: local, threadId: ThreadId.make("tagged") });
  const shells = hideMasterAgentThreadKeys({
    hiddenThreadKeysAtom: Atom.make<ReadonlySet<string>>(new Set([tagHidden])),
    masterAgentThreadIdsAtom: Atom.make<ReadonlyMap<EnvironmentId, ThreadId>>(
      new Map([
        [local, localAgent],
        [remote, remoteAgent],
      ]),
    ),
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };

  expect([...registry.get(shells.hiddenThreadKeysAtom)].toSorted()).toEqual(
    [
      tagHidden,
      threadKey({ environmentId: local, threadId: localAgent }),
      threadKey({ environmentId: remote, threadId: remoteAgent }),
    ].toSorted(),
  );
});
