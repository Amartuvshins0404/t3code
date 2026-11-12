import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const cliproxyLocalStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-status",
  tag: WS_METHODS.cliproxyLocalStatus,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

const singleFlight = {
  mode: "singleFlight",
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
} as const;

export const cliproxyLocalInstall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-install",
  tag: WS_METHODS.cliproxyLocalInstall,
  concurrency: singleFlight,
});

export const cliproxyLocalConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-connect",
  tag: WS_METHODS.cliproxyLocalConnect,
  concurrency: singleFlight,
});

export const cliproxyLocalSetNewKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-set-new-key",
  tag: WS_METHODS.cliproxyLocalSetNewKey,
  concurrency: singleFlight,
});

export const cliproxyLocalAddProviders = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-add-providers",
  tag: WS_METHODS.cliproxyLocalAddProviders,
  concurrency: singleFlight,
});

export const cliproxyLocalRevealKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:local-reveal-key",
  tag: WS_METHODS.cliproxyLocalRevealKey,
});

export const cliproxyDisconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:disconnect",
  tag: WS_METHODS.cliproxyDisconnect,
  concurrency: singleFlight,
});

export const cliproxyAccounts = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cliproxy:accounts",
  tag: WS_METHODS.cliproxyAccountsList,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const cliproxyRouting = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:cliproxy:routing",
  tag: WS_METHODS.cliproxyRoutingGet,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const cliproxySignInStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:sign-in-start",
  tag: WS_METHODS.cliproxyAccountsSignInStart,
  concurrency: singleFlight,
});

export const cliproxySignInStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:sign-in-status",
  tag: WS_METHODS.cliproxyAccountsSignInStatus,
});

export const cliproxySignInCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:sign-in-cancel",
  tag: WS_METHODS.cliproxyAccountsSignInCancel,
});

export const cliproxyRemoveAccount = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:remove-account",
  tag: WS_METHODS.cliproxyAccountsRemove,
});

export const cliproxySetAccountEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:set-account-enabled",
  tag: WS_METHODS.cliproxyAccountsSetEnabled,
});

export const cliproxySetRouting = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cliproxy:set-routing",
  tag: WS_METHODS.cliproxyRoutingSet,
  concurrency: singleFlight,
});
