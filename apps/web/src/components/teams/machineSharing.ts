import { TeamWorkspace, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  shareManagedRelayEnvironmentWithTeamCommand,
  unshareManagedRelayEnvironmentWithTeamCommand,
} from "~/cloud/managedRelayState";
import { refreshTeamMachines } from "~/cloud/teamWorkspace";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";

async function runOrThrow<W, A, E>(command: AtomCommand<W, A, E>, value: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { reportFailure: false });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function refreshAfterChange(environmentId: EnvironmentId, organizationId: string) {
  refreshTeamMachines(organizationId);
  appAtomRegistry.refresh(serverEnvironment.teamSharedOrganizations({ environmentId, input: {} }));
}

function relayAccountId(): string {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) throw new Error("Sign in to T3 Connect to share a machine.");
  return accountId;
}

export async function shareMachineWithTeam(input: {
  readonly environmentId: EnvironmentId;
  readonly organizationId: string;
}): Promise<TeamWorkspace.MachineShareResult> {
  const target = { ...input, accountId: relayAccountId() };
  const result = await TeamWorkspace.shareMachineWithTeam({
    shareOnRelay: () =>
      runOrThrow(shareManagedRelayEnvironmentWithTeamCommand, target).then(() => undefined),
    consentOnMachine: () =>
      runOrThrow(serverEnvironment.addTeamSharedOrganization, {
        environmentId: input.environmentId,
        input: { organizationId: input.organizationId },
      }).then(() => undefined),
    unshareOnRelay: () =>
      runOrThrow(unshareManagedRelayEnvironmentWithTeamCommand, target).then(() => undefined),
  });
  refreshAfterChange(input.environmentId, input.organizationId);
  return result;
}

export async function stopSharingMachineWithTeam(input: {
  readonly environmentId: EnvironmentId;
  readonly organizationId: string;
}): Promise<TeamWorkspace.MachineShareResult> {
  const target = { ...input, accountId: relayAccountId() };
  const reachable = readEnvironment(input.environmentId)?.connection.phase === "connected";
  const result = await TeamWorkspace.stopSharingMachine({
    unshareOnRelay: () =>
      runOrThrow(unshareManagedRelayEnvironmentWithTeamCommand, target).then(() => undefined),
    withdrawOnMachine: () =>
      reachable
        ? runOrThrow(serverEnvironment.removeTeamSharedOrganization, {
            environmentId: input.environmentId,
            input: { organizationId: input.organizationId },
          }).then(() => undefined)
        : Promise.resolve(),
    shareOnRelay: () =>
      runOrThrow(shareManagedRelayEnvironmentWithTeamCommand, target).then(() => undefined),
  });
  refreshAfterChange(input.environmentId, input.organizationId);
  return result;
}

export function machineShareFailureMessage(
  result: Extract<TeamWorkspace.MachineShareResult, { ok: false }>,
  sharing: boolean,
): string {
  const detail = result.cause instanceof Error ? result.cause.message : null;
  if (result.failed === "relay") {
    return (
      detail ??
      (sharing ? "T3 Connect could not share the machine." : "T3 Connect could not stop the share.")
    );
  }
  const machine = sharing
    ? "The machine did not accept the share, so nothing was shared."
    : "The machine did not stop sharing, so it is still shared.";
  return result.undone ? machine : `${machine} Try again to finish.`;
}
