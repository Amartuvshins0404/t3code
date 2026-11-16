import {
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ProviderSessionId,
  type ResolvedProviderInstanceEnvironment,
  type TeamConnectivityDriver,
  type TeamConnectivityStatus,
  type ThreadId,
  type ThreadTeamShare,
} from "@t3tools/contracts";
import type { RelayEnvironmentTeamConnectivityResponse } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { T3CODE_CODEX_LAUNCH_ARGS_ENV } from "../provider/codexLaunchArgs.ts";

const TEAM_CONNECTIVITY_DRIVERS: ReadonlyArray<TeamConnectivityDriver> = ["claudeAgent", "codex"];

export const isTeamConnectivityDriver = (
  driver: ProviderDriverKind | string,
): driver is TeamConnectivityDriver =>
  (TEAM_CONNECTIVITY_DRIVERS as ReadonlyArray<string>).includes(driver);

export interface TeamConnection {
  readonly organizationId: string;
  readonly url: string;
  readonly clientKey: string;
  readonly version: string;
}

export interface TeamConnectivityMemory {
  readonly sharedOrganizationIds: ReadonlyArray<string>;
  readonly connections: ReadonlyMap<string, TeamConnection>;
  readonly configured: ReadonlyMap<string, string>;
}

export const applyRelayTeamConnectivity = (
  previous: TeamConnectivityMemory,
  localSharedOrganizationIds: ReadonlyArray<string>,
  response: RelayEnvironmentTeamConnectivityResponse,
): TeamConnectivityMemory => {
  const validlyShared = new Set(
    response.sharedOrganizationIds.filter((id) => localSharedOrganizationIds.includes(id)),
  );
  const connections = new Map<string, TeamConnection>();
  for (const team of response.teams) {
    if (!validlyShared.has(team.organizationId)) continue;
    connections.set(team.organizationId, {
      organizationId: team.organizationId,
      url: team.url,
      clientKey: team.clientKey,
      version: team.version,
    });
  }
  const configured = new Map<string, string>();
  for (const organizationId of localSharedOrganizationIds) {
    const connection = connections.get(organizationId);
    if (connection !== undefined) {
      configured.set(organizationId, connection.version);
      continue;
    }
    if (validlyShared.has(organizationId)) continue;
    const known = previous.configured.get(organizationId);
    if (known !== undefined) configured.set(organizationId, known);
  }
  return { sharedOrganizationIds: [...localSharedOrganizationIds], connections, configured };
};

export const withSharedOrganizations = (
  previous: TeamConnectivityMemory,
  organizationIds: ReadonlyArray<string>,
): TeamConnectivityMemory => ({
  sharedOrganizationIds: [...organizationIds],
  connections: new Map(
    [...previous.connections].filter(([organizationId]) =>
      organizationIds.includes(organizationId),
    ),
  ),
  configured: new Map(
    [...previous.configured].filter(([organizationId]) => organizationIds.includes(organizationId)),
  ),
});

export const teamConnectivityStatus = (
  memory: TeamConnectivityMemory,
  input: { readonly checkedAt: string; readonly organizationId?: string | undefined },
): TeamConnectivityStatus => ({
  organizations: memory.sharedOrganizationIds
    .filter((id) => input.organizationId === undefined || id === input.organizationId)
    .map((organizationId) => {
      const state = memory.connections.has(organizationId)
        ? ("ready" as const)
        : memory.configured.has(organizationId)
          ? ("unavailable" as const)
          : ("not_configured" as const);
      return {
        organizationId,
        state,
        drivers: state === "not_configured" ? [] : [...TEAM_CONNECTIVITY_DRIVERS],
        checkedAt: input.checkedAt,
      };
    }),
});

export type TeamTurnRoute =
  | { readonly type: "owner" }
  | { readonly type: "team"; readonly organizationId: string; readonly version: string }
  | { readonly type: "unavailable"; readonly organizationId: string };

export const teamRouteOrganization = (
  memory: TeamConnectivityMemory,
  input: {
    readonly teamShare: ThreadTeamShare | null | undefined;
    readonly driver: ProviderDriverKind | string;
  },
): string | undefined => {
  const organizationId = input.teamShare?.organizationId;
  if (organizationId === undefined) return undefined;
  if (!memory.sharedOrganizationIds.includes(organizationId)) return undefined;
  if (!isTeamConnectivityDriver(input.driver)) return undefined;
  return organizationId;
};

export const routedTeamShare = <E, R>(
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "teamShare">,
  rootTeamShare: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<ThreadTeamShare | null | undefined, E, R>,
): Effect.Effect<ThreadTeamShare | null | undefined, E, R> =>
  thread.teamShare != null ||
  thread.lineage.relationshipToParent !== "subagent" ||
  thread.lineage.rootThreadId === thread.id
    ? Effect.succeed(thread.teamShare)
    : rootTeamShare(thread.lineage.rootThreadId);

export const decideTeamTurnRoute = (
  memory: TeamConnectivityMemory,
  input: {
    readonly teamShare: ThreadTeamShare | null | undefined;
    readonly driver: ProviderDriverKind | string;
  },
): TeamTurnRoute => {
  const organizationId = teamRouteOrganization(memory, input);
  if (organizationId === undefined) return { type: "owner" };
  const connection = memory.connections.get(organizationId);
  if (connection !== undefined) {
    return { type: "team", organizationId, version: connection.version };
  }
  if (memory.configured.has(organizationId)) return { type: "unavailable", organizationId };
  return { type: "owner" };
};

const TEAM_SESSION_PREFIX = ["provider-session", "team"] as const;

export const teamProviderSessionId = (input: {
  readonly organizationId: string;
  readonly version: string;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}): ProviderSessionId =>
  ProviderSessionId.make(
    [
      ...TEAM_SESSION_PREFIX,
      ...[input.organizationId, input.version, input.instanceId, input.threadId].map(
        encodeURIComponent,
      ),
    ].join(":"),
  );

export interface TeamProviderSession {
  readonly organizationId: string;
  readonly version: string;
  readonly instanceId: string;
  readonly threadId: string;
}

export const parseTeamProviderSessionId = (
  providerSessionId: string,
): TeamProviderSession | undefined => {
  const parts = providerSessionId.split(":");
  if (parts[0] !== TEAM_SESSION_PREFIX[0] || parts[1] !== TEAM_SESSION_PREFIX[1]) return undefined;
  if (parts.length !== 6) return undefined;
  try {
    const [organizationId, version, instanceId, threadId] = parts.slice(2).map(decodeURIComponent);
    if (!organizationId || !version || !instanceId || !threadId) return undefined;
    return { organizationId, version, instanceId, threadId };
  } catch {
    return undefined;
  }
};

export const isTeamProviderSessionId = (providerSessionId: string): boolean =>
  parseTeamProviderSessionId(providerSessionId) !== undefined;

export const turnProviderSessionId = (input: {
  readonly route: TeamTurnRoute;
  readonly current: ProviderSessionId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly ownerSessionId: () => Effect.Effect<ProviderSessionId>;
}): Effect.Effect<ProviderSessionId> => {
  if (input.route.type === "team") {
    return Effect.succeed(
      teamProviderSessionId({
        organizationId: input.route.organizationId,
        version: input.route.version,
        instanceId: input.instanceId,
        threadId: input.threadId,
      }),
    );
  }
  return isTeamProviderSessionId(input.current)
    ? input.ownerSessionId()
    : Effect.succeed(input.current);
};

const TEAM_PROXY_KEY_VARIABLE = "T3_TEAM_PROXY_API_KEY";
export const CODEX_TEAM_KEY_FD = 3;
export const CODEX_TEAM_KEY_COMMAND = {
  command: "/bin/sh",
  args: ["-c", `cat <&${CODEX_TEAM_KEY_FD}`],
} as const;
const CLAUDE_TEAM_BLANKED_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
];
export const CLAUDE_TEAM_PINNED_VARIABLES: ReadonlySet<string> = new Set([
  "ANTHROPIC_BASE_URL",
  ...CLAUDE_TEAM_BLANKED_VARIABLES,
]);
const CODEX_TEAM_BLANKED_VARIABLES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  T3CODE_CODEX_LAUNCH_ARGS_ENV,
];

export const withoutTeamProxyKey = (environment: NodeJS.ProcessEnv) => {
  const { [TEAM_PROXY_KEY_VARIABLE]: key, ...rest } = environment;
  return { key, environment: rest };
};

const codexTeamLaunchArgs = (url: string) =>
  [
    "model_provider=t3team",
    "model_providers.t3team.name=Team CLI Proxy",
    `model_providers.t3team.base_url=${new URL("v1", `${url.replace(/\/+$/, "")}/`).toString()}`,
    `model_providers.t3team.auth.command=${JSON.stringify(CODEX_TEAM_KEY_COMMAND.command)}`,
    `model_providers.t3team.auth.args=${JSON.stringify(CODEX_TEAM_KEY_COMMAND.args)}`,
    "features.shell_snapshot=false",
  ]
    .map((override) => `-c "${override.replace(/["\\$`]/g, "\\$&")}"`)
    .join(" ");

export const teamProviderEnvironment = (
  driver: TeamConnectivityDriver,
  environment: ResolvedProviderInstanceEnvironment,
  connection: Pick<TeamConnection, "url" | "clientKey">,
): ResolvedProviderInstanceEnvironment => {
  if (driver === "claudeAgent") {
    return [
      ...environment.filter(
        (variable) =>
          !CLAUDE_TEAM_PINNED_VARIABLES.has(variable.name) &&
          variable.name !== TEAM_PROXY_KEY_VARIABLE,
      ),
      { name: "ANTHROPIC_BASE_URL", value: connection.url, sensitive: false },
      ...CLAUDE_TEAM_BLANKED_VARIABLES.map((name) => ({ name, value: "", sensitive: false })),
      { name: TEAM_PROXY_KEY_VARIABLE, value: connection.clientKey, sensitive: true },
    ];
  }
  const blanked = new Set([
    ...CODEX_TEAM_BLANKED_VARIABLES,
    ...environment.filter((variable) => variable.sensitive).map((variable) => variable.name),
  ]);
  blanked.delete(TEAM_PROXY_KEY_VARIABLE);
  return [
    ...environment.filter(
      (variable) => !blanked.has(variable.name) && variable.name !== TEAM_PROXY_KEY_VARIABLE,
    ),
    ...[...blanked].map((name) => ({ name, value: "", sensitive: false })),
    { name: TEAM_PROXY_KEY_VARIABLE, value: connection.clientKey, sensitive: true },
  ];
};

export const teamProviderConfig = (
  driver: TeamConnectivityDriver,
  config: unknown,
  connection: Pick<TeamConnection, "url">,
): unknown => {
  if (driver === "claudeAgent") return config;
  const base =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  return { ...base, setupMode: "existing", launchArgs: codexTeamLaunchArgs(connection.url) };
};

export class TeamConnectivityUnavailableError extends Schema.TaggedError<TeamConnectivityUnavailableError>()(
  "TeamConnectivityUnavailableError",
  { organizationId: Schema.String },
) {
  override get message(): string {
    return `This thread is shared with a team, and the team's provider connection can't be reached from this machine right now. The turn did not run on the owner's account. Try again when the machine can reach T3 Connect.`;
  }
}

export interface TeamProviderRoutesShape {
  readonly routeTurn: (input: {
    readonly teamShare: ThreadTeamShare | null | undefined;
    readonly driver: ProviderDriverKind;
  }) => Effect.Effect<TeamTurnRoute>;
  readonly openAdapter: (input: {
    readonly session: TeamProviderSession;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    TeamConnectivityUnavailableError,
    Scope.Scope
  >;
}

export const TeamProviderRoutes = Context.Reference<TeamProviderRoutesShape>(
  "t3/team/TeamProviderRoutes",
  {
    defaultValue: () => ({
      routeTurn: () => Effect.succeed({ type: "owner" }),
      openAdapter: ({ session }) =>
        Effect.fail(
          new TeamConnectivityUnavailableError({ organizationId: session.organizationId }),
        ),
    }),
  },
);
