import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const codeSearchStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:code-search:status",
  tag: WS_METHODS.codeSearchStatus,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const codeSearchConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:code-search:connect",
  tag: WS_METHODS.codeSearchConnect,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId }) => environmentId,
  },
});
