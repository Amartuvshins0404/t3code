import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import {
  type EnvironmentId,
  type TeamAgentStatus,
  TeamConnectivityDriver,
  type TeamConnectivityOrganizationStatus,
  type ThreadTeamShare,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type ThreadConnectivity =
  | { readonly kind: "team" }
  | {
      readonly kind: "owner";
      readonly reason: "no_connection" | "provider" | "machine_outdated";
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown" };

const isTeamConnectivityDriver = Schema.is(TeamConnectivityDriver);

export function threadConnectivity(input: {
  readonly machineSupportsTeamConnectivity: boolean;
  readonly organizationId: string;
  readonly status: ReadonlyArray<TeamConnectivityOrganizationStatus> | null;
  readonly driver: string | null;
}): ThreadConnectivity {
  if (!input.machineSupportsTeamConnectivity) {
    return { kind: "owner", reason: "machine_outdated" };
  }
  if (input.status === null || input.driver === null) return { kind: "unknown" };
  const team = input.status.find((entry) => entry.organizationId === input.organizationId);
  if (team === undefined || team.state === "not_configured") {
    return { kind: "owner", reason: "no_connection" };
  }
  const driver = input.driver;
  if (!isTeamConnectivityDriver(driver)) return { kind: "owner", reason: "provider" };
  if (team.state === "unavailable") return { kind: "unavailable" };
  return team.drivers.includes(driver) ? { kind: "team" } : { kind: "owner", reason: "provider" };
}

export type WorkspaceScope =
  | { readonly kind: "personal"; readonly teamOnlyEnvironmentIds: ReadonlySet<string> }
  | {
      readonly kind: "team";
      readonly teamId: string;
      readonly environmentIds: ReadonlySet<string>;
    };

function workspaceListsEnvironment(scope: WorkspaceScope, environmentId: string): boolean {
  return scope.kind === "personal"
    ? !scope.teamOnlyEnvironmentIds.has(environmentId)
    : scope.environmentIds.has(environmentId);
}

export function workspaceListsThread(
  scope: WorkspaceScope,
  thread: {
    readonly environmentId: string;
    readonly teamShare?: Pick<ThreadTeamShare, "organizationId" | "agent"> | null | undefined;
  },
): boolean {
  if (!workspaceListsEnvironment(scope, thread.environmentId)) return false;
  if (scope.kind === "personal") return thread.teamShare?.agent === undefined;
  return thread.teamShare?.organizationId === scope.teamId;
}

export type AgentMachineState =
  | { readonly kind: "connecting" }
  | { readonly kind: "offline" }
  | { readonly kind: "outdated" }
  | { readonly kind: "checking" }
  | { readonly kind: "answered"; readonly agent: TeamAgentStatus | null };

export interface AgentMachine {
  readonly environmentId: EnvironmentId;
  readonly sharedAt: string;
  readonly state: AgentMachineState;
}

export type PersonAgentStatus =
  | {
      readonly kind: "ready";
      readonly environmentId: EnvironmentId;
      readonly agent: TeamAgentStatus;
    }
  | { readonly kind: "off" }
  | { readonly kind: "offline" }
  | { readonly kind: "no_machine" }
  | { readonly kind: "needs_update" }
  | { readonly kind: "loading" };

export function agentIsReady(agent: TeamAgentStatus | null): agent is TeamAgentStatus {
  return (
    agent !== null && agent.enabled && agent.projects.length > 0 && agent.claudeOutdated !== true
  );
}

export function personAgentStatus(machines: ReadonlyArray<AgentMachine>): PersonAgentStatus {
  if (machines.length === 0) return { kind: "no_machine" };
  const oldestFirst = [...machines].sort((left, right) =>
    left.sharedAt.localeCompare(right.sharedAt),
  );
  for (const machine of oldestFirst) {
    if (machine.state.kind === "answered" && agentIsReady(machine.state.agent)) {
      return {
        kind: "ready",
        environmentId: machine.environmentId,
        agent: machine.state.agent,
      };
    }
  }
  const kinds = new Set(machines.map((machine) => machine.state.kind));
  if (kinds.has("connecting") || kinds.has("checking")) return { kind: "loading" };
  if (
    machines.some(
      (machine) =>
        machine.state.kind === "answered" && machine.state.agent?.claudeOutdated === true,
    )
  ) {
    return { kind: "needs_update" };
  }
  if (kinds.has("answered")) return { kind: "off" };
  if (kinds.has("outdated")) return { kind: "needs_update" };
  return { kind: "offline" };
}

export type ThreadComposerMode = "owner" | "steer" | "view" | "unshared";

export function threadComposerMode(input: {
  readonly teammate: boolean;
  readonly teamShare: Pick<ThreadTeamShare, "access"> | null | undefined;
}): ThreadComposerMode {
  if (!input.teammate) return "owner";
  if (!input.teamShare) return "unshared";
  return input.teamShare.access === "steer" ? "steer" : "view";
}

export function orderTeamMachines(
  machines: ReadonlyArray<RelayTeamEnvironmentRecord>,
): ReadonlyArray<RelayTeamEnvironmentRecord> {
  return [...machines].sort((left, right) => {
    if (left.isOwner !== right.isOwner) return left.isOwner ? -1 : 1;
    return left.owner.name.localeCompare(right.owner.name) || left.label.localeCompare(right.label);
  });
}

export interface TeamConnectionPlan {
  readonly register: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
  readonly tracked: ReadonlyArray<string>;
}

export function planTeamConnections(input: {
  readonly catalogIds: ReadonlySet<string>;
  readonly tracked: ReadonlyArray<string>;
  readonly wanted: ReadonlyArray<string>;
}): TeamConnectionPlan {
  const wanted = new Set(input.wanted);
  const register = [...wanted].filter((id) => !input.catalogIds.has(id));
  const remove = input.tracked.filter((id) => !wanted.has(id) && input.catalogIds.has(id));
  const kept = input.tracked.filter((id) => wanted.has(id) && input.catalogIds.has(id));
  return { register, remove, tracked: [...new Set([...kept, ...register])] };
}

export type MachineShareResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failed: "relay" | "machine";
      readonly cause: unknown;
      readonly undone: boolean;
    };

export async function shareMachineWithTeam(steps: {
  readonly shareOnRelay: () => Promise<void>;
  readonly consentOnMachine: () => Promise<void>;
  readonly unshareOnRelay: () => Promise<void>;
}): Promise<MachineShareResult> {
  try {
    await steps.shareOnRelay();
  } catch (cause) {
    return { ok: false, failed: "relay", cause, undone: true };
  }
  try {
    await steps.consentOnMachine();
  } catch (cause) {
    const undone = await steps.unshareOnRelay().then(
      () => true,
      () => false,
    );
    return { ok: false, failed: "machine", cause, undone };
  }
  return { ok: true };
}

export async function stopSharingMachine(steps: {
  readonly unshareOnRelay: () => Promise<void>;
  readonly withdrawOnMachine: () => Promise<void>;
  readonly shareOnRelay: () => Promise<void>;
}): Promise<MachineShareResult> {
  try {
    await steps.unshareOnRelay();
  } catch (cause) {
    return { ok: false, failed: "relay", cause, undone: true };
  }
  try {
    await steps.withdrawOnMachine();
  } catch (cause) {
    const undone = await steps.shareOnRelay().then(
      () => true,
      () => false,
    );
    return { ok: false, failed: "machine", cause, undone };
  }
  return { ok: true };
}
