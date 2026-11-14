import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import { useEffect, useSyncExternalStore } from "react";

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import { environmentCatalog } from "../connection/catalog";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useUiStateStore } from "../uiStateStore";
import { useCloudAuth } from "./cloudAuth";
import {
  PERSONAL_WORKSPACE,
  useActiveWorkspace,
  useCloudTeamsState,
  type ActiveWorkspace,
} from "./cloudTeams";
import {
  refreshManagedRelayTeamEnvironments,
  useManagedRelayTeamEnvironments,
} from "./managedRelayState";

const TRACKED_KEY = "t3code:team-connections:v1";
const trackedListeners = new Set<() => void>();
let trackedSnapshot: ReadonlySet<string> | null = null;

function readTracked(): ReadonlySet<string> {
  if (trackedSnapshot) return trackedSnapshot;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TRACKED_KEY) ?? "[]");
    trackedSnapshot = new Set(
      Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [],
    );
  } catch {
    trackedSnapshot = new Set();
  }
  return trackedSnapshot;
}

function writeTracked(ids: ReadonlyArray<string>) {
  const next = new Set(ids);
  const current = readTracked();
  if (next.size === current.size && [...next].every((id) => current.has(id))) return;
  trackedSnapshot = next;
  try {
    if (next.size === 0) window.localStorage.removeItem(TRACKED_KEY);
    else window.localStorage.setItem(TRACKED_KEY, JSON.stringify([...next]));
  } catch {}
  for (const listener of trackedListeners) listener();
}

function subscribeTracked(listener: () => void) {
  trackedListeners.add(listener);
  return () => {
    trackedListeners.delete(listener);
  };
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function useTeamOnlyEnvironmentIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeTracked, readTracked, () => EMPTY_IDS);
}

let reconciling: Promise<void> = Promise.resolve();

function reconcileTeamConnections(wanted: ReadonlyArray<RelayTeamEnvironmentRecord>) {
  reconciling = reconciling.then(async () => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return;
    const plan = TeamWorkspace.planTeamConnections({
      catalogIds: new Set(catalog.entries.keys()),
      tracked: [...readTracked()],
      wanted: wanted.map((machine) => machine.environmentId),
    });
    const registered: string[] = [];
    for (const environmentId of plan.register) {
      const machine = wanted.find((candidate) => candidate.environmentId === environmentId);
      if (!machine) continue;
      const result = await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.register,
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: machine.environmentId,
            label: machine.label,
            ...(machine.isOwner ? {} : { teammate: true as const }),
          }),
        }),
        { reportFailure: false },
      );
      if (result._tag === "Success" && result.value) registered.push(environmentId);
    }
    const removed = new Set<string>();
    for (const environmentId of plan.remove) {
      const result = await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.remove,
        environmentId as EnvironmentId,
        { reportFailure: false },
      );
      if (result._tag === "Success") removed.add(environmentId);
    }
    writeTracked([
      ...plan.tracked.filter((id) => !plan.register.includes(id) || registered.includes(id)),
      ...plan.remove.filter((id) => !removed.has(id)),
    ]);
  });
  return reconciling;
}

export type TeamMachinesState =
  | { readonly status: "personal" }
  | {
      readonly status: "loading" | "ready" | "failed";
      readonly teamId: string;
      readonly machines: ReadonlyArray<RelayTeamEnvironmentRecord>;
      readonly error: string | null;
    };

const NO_MACHINES: ReadonlyArray<RelayTeamEnvironmentRecord> = [];

function teamMachinesState(
  workspace: ActiveWorkspace,
  snapshot: ReturnType<typeof useManagedRelayTeamEnvironments>,
): TeamMachinesState {
  if (workspace.kind === "personal") return { status: "personal" };
  const machines = snapshot.data ? TeamWorkspace.orderTeamMachines(snapshot.data) : NO_MACHINES;
  return {
    status: snapshot.data ? "ready" : snapshot.error ? "failed" : "loading",
    teamId: workspace.team.id,
    machines,
    error: snapshot.error,
  };
}

export function useTeamMachines(): TeamMachinesState {
  const workspace = useActiveWorkspace();
  const snapshot = useManagedRelayTeamEnvironments(
    workspace.kind === "team" ? workspace.team.id : null,
  );
  return teamMachinesState(workspace, snapshot);
}

export function useTeamMachine(
  environmentId: EnvironmentId | null,
): RelayTeamEnvironmentRecord | null {
  const state = useTeamMachines();
  if (state.status === "personal" || environmentId === null) return null;
  return state.machines.find((machine) => machine.environmentId === environmentId) ?? null;
}

export function useIsTeammateEnvironment(environmentId: EnvironmentId | null): boolean {
  return useTeamMachine(environmentId)?.isOwner === false;
}

export function usePersonalProjects(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  const teamOnly = useTeamOnlyEnvironmentIds();
  if (teamOnly.size === 0) return projects;
  return projects.filter((project) => !teamOnly.has(project.environmentId));
}

export function usePersonalQuietThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useQuietThreadShells();
  const teamOnly = useTeamOnlyEnvironmentIds();
  if (teamOnly.size === 0) return threads;
  return threads.filter((thread) => !teamOnly.has(thread.environmentId));
}

export function useWorkspaceScope(): TeamWorkspace.WorkspaceScope {
  const workspace = useActiveWorkspace();
  const teamOnlyEnvironmentIds = useTeamOnlyEnvironmentIds();
  const snapshot = useManagedRelayTeamEnvironments(
    workspace.kind === "team" ? workspace.team.id : null,
  );
  if (workspace.kind === "personal") return { kind: "personal", teamOnlyEnvironmentIds };
  return {
    kind: "team",
    teamId: workspace.team.id,
    environmentIds: new Set((snapshot.data ?? NO_MACHINES).map((machine) => machine.environmentId)),
  };
}

export function refreshTeamMachines(teamId: string) {
  refreshManagedRelayTeamEnvironments(teamId);
}

export function TeamWorkspaceConnections() {
  const workspace = useActiveWorkspace();
  const teamId = workspace.kind === "team" ? workspace.team.id : null;
  const snapshot = useManagedRelayTeamEnvironments(teamId);
  const catalogReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
  const authLoaded = useCloudAuth().isLoaded;
  const savedWorkspace = useUiStateStore((store) => store.activeWorkspace);
  const teamsStatus = useCloudTeamsState().status;
  const settling =
    !authLoaded ||
    (workspace.kind === "personal" &&
      savedWorkspace !== PERSONAL_WORKSPACE &&
      teamsStatus === "loading");
  const wanted = settling ? null : teamId === null ? NO_MACHINES : snapshot.data;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects the team's shared machines in the connection registry and drops them when the workspace changes
  useEffect(() => {
    if (!catalogReady || wanted === null) return;
    void reconcileTeamConnections(wanted);
  }, [catalogReady, wanted]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the team's machine list when the window regains focus
  useEffect(() => {
    if (teamId === null) return;
    const refresh = () => refreshManagedRelayTeamEnvironments(teamId);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [teamId]);

  return null;
}
