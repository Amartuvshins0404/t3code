import {
  AuthAccessReadScope,
  type AuthSessionState,
  AuthTeamMemberScopes,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ServerConfig,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcSchema } from "effect/rpc";

import type { WsRpcProtocolClient } from "./protocol.ts";

const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);

const TEAMMATE_AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["dpop-access-token"],
  sessionCookieName: "t3_session",
} as const;

export function teammateServerConfig(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverVersion: string;
}): ServerConfig {
  return decodeServerConfig({
    environment: {
      environmentId: input.environmentId,
      label: input.label.trim() || "Team machine",
      platform: { os: "unknown", arch: "other" },
      serverVersion: input.serverVersion,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      capabilities: { repositoryIdentity: true },
    },
    auth: TEAMMATE_AUTH,
    cwd: "/",
    keybindingsConfigPath: "/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
    threadSnapshotPagination: true,
    threadResumeCompletionMarker: true,
    shellResumeCompletionMarker: true,
  });
}

const TEAMMATE_RPC_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.serverProbe,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  WS_METHODS.teamReportPresence,
  WS_METHODS.teamSubscribePresence,
]);

export function teammateProtocolClient(client: WsRpcProtocolClient): WsRpcProtocolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || TEAMMATE_RPC_METHODS.has(property)) return value;
      const rpc = WsRpcGroup.requests.get(property);
      if (rpc === undefined) return value;
      const refusal = new EnvironmentAuthorizationError({
        message: "Teammates cannot use this on a shared machine.",
        requiredScope: AuthAccessReadScope,
        requiredPermission: "team-member-allowlist",
      });
      return RpcSchema.isStreamSchema(rpc.successSchema)
        ? () => Stream.fail(refusal)
        : () => Effect.fail(refusal);
    },
  });
}

export const TEAMMATE_SESSION_STATE: AuthSessionState = {
  authenticated: true,
  auth: TEAMMATE_AUTH,
  scopes: AuthTeamMemberScopes,
  permissions: AuthTeamMemberScopes,
  sessionMethod: "dpop-access-token",
};
