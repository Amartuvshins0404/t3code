import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import { hideMasterAgentThreads } from "./master-agent-threads";

it("leaves every connected environment's agent thread out of thread lists and pending rows", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const older = EnvironmentId.make("older-server");
  const thread = (environmentId: EnvironmentId, id: string) =>
    makeThreadShellFixture({ environmentId, id: ThreadId.make(id) });
  const localAgent = thread(local, "agent-local");
  const remoteAgent = thread(remote, "agent-remote");
  const localWork = thread(local, "work-local");
  const remoteWork = thread(remote, "work-remote");
  const olderWork = thread(older, "agent-local");
  const all = [localAgent, localWork, remoteAgent, remoteWork, olderWork];
  const tagHidden = threadKey({ environmentId: local, threadId: ThreadId.make("tagged") });
  const shells = hideMasterAgentThreads(
    {
      navigationThreadShellsAtom: Atom.make(all),
      visibleThreadShellsAtom: Atom.make(all),
      hiddenThreadKeysAtom: Atom.make<ReadonlySet<string>>(new Set([tagHidden])),
    },
    Atom.make(
      new Map<EnvironmentId, Pick<ServerConfig, "masterAgentThreadId">>([
        [local, { masterAgentThreadId: localAgent.id }],
        [remote, { masterAgentThreadId: remoteAgent.id }],
        [older, {}],
      ]),
    ),
  );
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };

  const listed = [localWork, remoteWork, olderWork];
  expect(registry.get(shells.navigationThreadShellsAtom)).toEqual(listed);
  expect(registry.get(shells.visibleThreadShellsAtom)).toEqual(listed);
  expect([...registry.get(shells.hiddenThreadKeysAtom)].toSorted()).toEqual(
    [
      tagHidden,
      threadKey({ environmentId: local, threadId: localAgent.id }),
      threadKey({ environmentId: remote, threadId: remoteAgent.id }),
    ].toSorted(),
  );
});
