import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { projectEnvironment } from "./projects";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const primaryMasterAgentThreadIdAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  return environmentId === null
    ? null
    : get(serverEnvironment.masterAgentThreadIdAtom(environmentId));
}).pipe(Atom.withLabel("web-primary-master-agent-thread-id"));

export const primaryMasterAgentAvailableAtom = Atom.make(
  (get) =>
    get(primaryMasterAgentThreadIdAtom) !== null &&
    get(projectEnvironment.ensureMasterAgent.permissionAtom(get(primaryEnvironmentIdAtom))),
).pipe(Atom.withLabel("web-primary-master-agent-available"));

export function usePrimaryMasterAgentAvailable(): boolean {
  return useAtomValue(primaryMasterAgentAvailableAtom);
}

export function useIsMasterAgentThread(ref: ScopedThreadRef | null): boolean {
  const ids = useAtomValue(environmentThreadShells.masterAgentThreadIdsAtom);
  return ref !== null && ids.get(ref.environmentId) === ref.threadId;
}
