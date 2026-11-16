import { useAtomValue } from "@effect/atom-react";
import { getConnectName } from "@t3tools/client-runtime/app-name";
import { TeamWorkspace, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CliproxyRoute,
  EnvironmentId,
  ScopedThreadRef,
  TeamConnectivityStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  refreshManagedRelayTeamConnectivity,
  removeManagedRelayTeamConnectivityCommand,
  setManagedRelayTeamConnectivityCommand,
} from "~/cloud/managedRelayState";
import { teammateConnectionAtom } from "~/cloud/teamWorkspace";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { cliproxyRevealRoute } from "~/state/cliproxy";
import {
  readConnectedEnvironmentIds,
  readPrimaryEnvironmentId,
  useEnvironment,
} from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentThreadDetails, environmentThreadShells } from "~/state/threads";

export const TEAM_CONNECTIVITY_SECTION_ID = "team-connectivity";

export type MachineConnectivity =
  | { readonly kind: "offline" }
  | { readonly kind: "outdated" }
  | { readonly kind: "checking" }
  | { readonly kind: "failed" }
  | { readonly kind: "answered"; readonly status: TeamConnectivityStatus };

const NOT_ASKED_ATOM = Atom.make(AsyncResult.initial<TeamConnectivityStatus>()).pipe(
  Atom.withLabel("team-connectivity:not-asked"),
);

export function useMachineConnectivity(environmentId: EnvironmentId): MachineConnectivity {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const teammate = useAtomValue(teammateConnectionAtom(environmentId));
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .teamConnectivity === true || teammate;
  const result = useAtomValue(
    connected && supported
      ? serverEnvironment.teamConnectivity({ environmentId, input: {} })
      : NOT_ASKED_ATOM,
  );
  if (!connected) return { kind: "offline" };
  if (!supported) return { kind: "outdated" };
  if (result._tag === "Initial") return { kind: "checking" };
  if (result._tag === "Failure") return { kind: "failed" };
  return { kind: "answered", status: result.value };
}

async function runOrThrow<W, A, E>(command: AtomCommand<W, A, E>, value: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { reportFailure: false });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function relayAccountId(): string {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) throw new Error(`Sign in to ${getConnectName()} to change the team connection.`);
  return accountId;
}

function ownedMachines(): ReadonlyArray<EnvironmentId> {
  return readConnectedEnvironmentIds().filter(
    (environmentId) => !appAtomRegistry.get(teammateConnectionAtom(environmentId)),
  );
}

export interface SavedProxy extends CliproxyRoute {
  readonly machine: string;
}

const SAVED_PROXY_WAIT_MS = 2_000;

export async function readSavedProxy(): Promise<SavedProxy | null> {
  const primary = readPrimaryEnvironmentId();
  const machines = ownedMachines().toSorted(
    (left, right) => Number(right === primary) - Number(left === primary),
  );
  for (const environmentId of machines) {
    const result = await Promise.race([
      runAtomCommand(
        appAtomRegistry,
        cliproxyRevealRoute,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
      new Promise<null>((resolve) => setTimeout(resolve, SAVED_PROXY_WAIT_MS, null)),
    ]);
    if (result?._tag !== "Success" || result.value === null) continue;
    const machine = appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
      ?.entry.target.label;
    return { ...result.value, machine: machine ?? "this machine" };
  }
  return null;
}

async function refreshMachines(): Promise<void> {
  await Promise.allSettled(
    ownedMachines().map(async (environmentId) => {
      const supported =
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment
          .capabilities.teamConnectivity === true;
      if (!supported) return;
      await runOrThrow(serverEnvironment.refreshTeamConnectivity, {
        environmentId,
        input: { refresh: true },
      }).finally(() =>
        appAtomRegistry.refresh(serverEnvironment.teamConnectivity({ environmentId, input: {} })),
      );
    }),
  );
}

export async function saveTeamConnectivity(input: {
  readonly organizationId: string;
  readonly url: string;
  readonly clientKey: string;
}): Promise<void> {
  await runOrThrow(setManagedRelayTeamConnectivityCommand, {
    accountId: relayAccountId(),
    organizationId: input.organizationId,
    url: input.url,
    clientKey: input.clientKey,
  });
  refreshManagedRelayTeamConnectivity(input.organizationId);
  void refreshMachines();
}

export async function removeTeamConnectivity(organizationId: string): Promise<void> {
  await runOrThrow(removeManagedRelayTeamConnectivityCommand, {
    accountId: relayAccountId(),
    organizationId,
  });
  refreshManagedRelayTeamConnectivity(organizationId);
  void refreshMachines();
}

export function useThreadConnectivity(
  threadRef: ScopedThreadRef,
  organizationId: string,
): TeamWorkspace.ThreadConnectivity {
  const instanceId = useAtomValue(
    environmentThreadShells.quietThreadShellAtom(threadRef),
    (shell) =>
      shell ? (shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId) : null,
  );
  const providers = useAtomValue(
    serverEnvironment.configValueAtom(threadRef.environmentId),
  )?.providers;
  const activeDriver = useAtomValue(environmentThreadDetails.stateAtom(threadRef), (state) => {
    const projection = Option.getOrNull(state.data);
    return (
      projection?.providerThreads.find(
        (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
      )?.driver ?? null
    );
  });
  const machine = useMachineConnectivity(threadRef.environmentId);
  const driver =
    instanceId === null
      ? null
      : (providers?.find((provider) => provider.instanceId === instanceId)?.driver ??
        activeDriver ??
        (instanceId === "claudeAgent" || instanceId === "codex" ? instanceId : null));
  return TeamWorkspace.threadConnectivity({
    machineSupportsTeamConnectivity: machine.kind !== "outdated",
    organizationId,
    status: machine.kind === "answered" ? machine.status.organizations : null,
    driver,
  });
}

const TEAM_CONNECTION_UNAVAILABLE =
  "The team connection cannot be reached. Messages will fail until it is back.";

export function ownerConnectivityLine(
  connectivity: TeamWorkspace.ThreadConnectivity,
  teamName: string,
): string | null {
  switch (connectivity.kind) {
    case "team":
      return `Runs on ${teamName}'s connection.`;
    case "unavailable":
      return TEAM_CONNECTION_UNAVAILABLE;
    case "unknown":
      return null;
    case "owner":
      switch (connectivity.reason) {
        case "no_connection":
          return `Runs on your accounts. ${teamName} has no connection yet.`;
        case "provider":
          return "Runs on your accounts. The team connection covers Claude and Codex only.";
        case "machine_outdated":
          return "Runs on your accounts. Update this machine to use the team connection.";
      }
  }
}

export function teammateConnectivityLine(
  connectivity: TeamWorkspace.ThreadConnectivity,
  teamName: string,
  ownerName: string,
): string | null {
  switch (connectivity.kind) {
    case "team":
      return `Runs on ${teamName}'s connection.`;
    case "unavailable":
      return TEAM_CONNECTION_UNAVAILABLE;
    case "unknown":
      return null;
    case "owner":
      return `Runs on ${ownerName}'s accounts.`;
  }
}

export function proxyHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
