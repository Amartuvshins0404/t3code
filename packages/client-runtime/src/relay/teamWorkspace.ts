import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import type { ThreadTeamShare } from "@t3tools/contracts";

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
    readonly teamShare?: Pick<ThreadTeamShare, "organizationId"> | null | undefined;
  },
): boolean {
  if (!workspaceListsEnvironment(scope, thread.environmentId)) return false;
  return scope.kind === "personal" || thread.teamShare?.organizationId === scope.teamId;
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
