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
