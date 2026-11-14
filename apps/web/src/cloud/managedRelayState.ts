import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  deregisterManagedRelayEnvironment,
  ManagedRelay,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  shareManagedRelayEnvironmentWithTeam,
  unshareManagedRelayEnvironmentWithTeam,
} from "@t3tools/client-runtime/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
  RelayTeamEnvironmentRecord,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/reactivity";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const managedRelayAtomRuntime = Atom.runtime(
  Layer.effect(
    ManagedRelay.ManagedRelayClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, ManagedRelay.ManagedRelayClient)),
    ),
  ),
);

const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const deregisterManagedRelayEnvironmentCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:deregister-environment",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId: string; readonly environmentId: EnvironmentId }) =>
        input.accountId,
    },
    execute: (input, registry) => deregisterManagedRelayEnvironment(registry, input),
  },
);

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:environments:null"));

const EMPTY_DEVICES_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientDeviceRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:devices:null"));

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  };

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function useManagedRelayDevices() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId ? managedRelayQueryManager.devicesAtom(accountId) : EMPTY_DEVICES_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = () => {
    if (accountId) {
      managedRelayQueryManager.refreshDevices(appAtomRegistry, accountId);
    }
  };

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

const teamShareScheduler = createAtomCommandScheduler();
const teamShareConcurrency = {
  mode: "serial" as const,
  key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
};

export const shareManagedRelayEnvironmentWithTeamCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:share-environment-with-team",
    scheduler: teamShareScheduler,
    concurrency: teamShareConcurrency,
    execute: (
      input: {
        readonly accountId: string;
        readonly environmentId: EnvironmentId;
        readonly organizationId: string;
      },
      registry,
    ) => shareManagedRelayEnvironmentWithTeam(registry, input),
  },
);

export const unshareManagedRelayEnvironmentWithTeamCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:unshare-environment-with-team",
    scheduler: teamShareScheduler,
    concurrency: teamShareConcurrency,
    execute: (
      input: {
        readonly accountId: string;
        readonly environmentId: EnvironmentId;
        readonly organizationId: string;
      },
      registry,
    ) => unshareManagedRelayEnvironmentWithTeam(registry, input),
  },
);

const EMPTY_TEAM_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayTeamEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:team-environments:null"));

const PENDING_TEAM_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.initial<ReadonlyArray<RelayTeamEnvironmentRecord>>(true),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:team-environments:pending"));

export function useManagedRelayTeamEnvironments(organizationId: string | null) {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom =
    organizationId === null
      ? EMPTY_TEAM_ENVIRONMENTS_ATOM
      : accountId
        ? managedRelayQueryManager.teamEnvironmentsAtom(accountId, organizationId)
        : PENDING_TEAM_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  return { ...readManagedRelaySnapshotState(result), accountId };
}

export function refreshManagedRelayTeamEnvironments(organizationId: string) {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) return;
  managedRelayQueryManager.refreshTeamEnvironments(appAtomRegistry, accountId, organizationId);
}

export function refreshManagedTunnelUsage() {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) return;
  managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
}
