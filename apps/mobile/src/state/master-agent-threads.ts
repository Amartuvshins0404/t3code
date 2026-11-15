import { arrayElementsEqual, threadKey } from "@t3tools/client-runtime/state/entities";
import { withoutMasterAgentThreads } from "@t3tools/client-runtime/state/master-agent";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

type ListAtom = Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
type ServerConfigsAtom = Atom.Atom<
  ReadonlyMap<EnvironmentId, Pick<ServerConfig, "masterAgentThreadId">>
>;

function withoutMasterAgentList(
  source: ListAtom,
  serverConfigsAtom: ServerConfigsAtom,
  label: string,
) {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const threads = get(source);
    const configs = get(serverConfigsAtom);
    const next = withoutMasterAgentThreads(
      threads,
      (environmentId) => configs.get(environmentId)?.masterAgentThreadId,
    );
    if (next.length === threads.length) return threads;
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(label));
}

export function hideMasterAgentThreads<
  Shells extends {
    readonly navigationThreadShellsAtom: ListAtom;
    readonly visibleThreadShellsAtom: ListAtom;
    readonly hiddenThreadKeysAtom: Atom.Atom<ReadonlySet<string>>;
  },
>(shells: Shells, serverConfigsAtom: ServerConfigsAtom): Shells {
  let previousHidden: ReadonlySet<string> = new Set();
  const hiddenThreadKeysAtom = Atom.make((get) => {
    const hidden = get(shells.hiddenThreadKeysAtom);
    const agentKeys = Array.from(get(serverConfigsAtom), ([environmentId, config]) =>
      config.masterAgentThreadId === undefined
        ? null
        : threadKey({ environmentId, threadId: config.masterAgentThreadId }),
    ).filter((key) => key !== null);
    if (agentKeys.every((key) => hidden.has(key))) return hidden;
    const next = new Set([...hidden, ...agentKeys]);
    if (next.size === previousHidden.size && [...next].every((key) => previousHidden.has(key))) {
      return previousHidden;
    }
    previousHidden = next;
    return next;
  }).pipe(Atom.withLabel("mobile:hidden-thread-keys-with-master-agent"));
  return {
    ...shells,
    navigationThreadShellsAtom: withoutMasterAgentList(
      shells.navigationThreadShellsAtom,
      serverConfigsAtom,
      "mobile:navigation-thread-shells-without-master-agent",
    ),
    visibleThreadShellsAtom: withoutMasterAgentList(
      shells.visibleThreadShellsAtom,
      serverConfigsAtom,
      "mobile:visible-thread-shells-without-master-agent",
    ),
    hiddenThreadKeysAtom,
  };
}
