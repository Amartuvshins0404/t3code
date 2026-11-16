import type { EnvironmentId, ProjectId, ScopedThreadRef, TeamPerson } from "@t3tools/contracts";
import { create } from "zustand";

export type TeamDialog =
  | { readonly kind: "create" }
  | { readonly kind: "invite"; readonly teamId: string }
  | { readonly kind: "share-thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "share-machine"; readonly environmentId: EnvironmentId }
  | { readonly kind: "ask-agent"; readonly teamId: string; readonly person: TeamPerson }
  | {
      readonly kind: "team-project";
      readonly teamId: string | null;
      readonly environmentId: EnvironmentId | null;
      readonly projectId: ProjectId | null;
    }
  | {
      readonly kind: "team-project-thread";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: "stop-team-project";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }
  | null;

export interface AwaitedTeamProject {
  readonly teamId: string;
  readonly environmentId: EnvironmentId;
  readonly knownProjectIds: ReadonlyArray<ProjectId>;
  readonly addStarted: boolean;
}

interface TeamUiState {
  readonly dialog: TeamDialog;
  readonly awaitedProject: AwaitedTeamProject | null;
  readonly switcherRequest: number;
}

export const useTeamUiStore = create<TeamUiState>(() => ({
  dialog: null,
  awaitedProject: null,
  switcherRequest: 0,
}));

function openDialog(dialog: TeamDialog): void {
  useTeamUiStore.setState({ dialog, awaitedProject: null });
}

export function openCreateTeamDialog(): void {
  openDialog({ kind: "create" });
}

export function openInviteTeamDialog(teamId: string): void {
  openDialog({ kind: "invite", teamId });
}

export function openTeamShareThreadDialog(threadRef: ScopedThreadRef): void {
  openDialog({ kind: "share-thread", threadRef });
}

export function openTeamShareMachineDialog(environmentId: EnvironmentId): void {
  openDialog({ kind: "share-machine", environmentId });
}

export function openAskAgentDialog(teamId: string, person: TeamPerson): void {
  openDialog({ kind: "ask-agent", teamId, person });
}

export function openTeamProjectDialog(
  input: {
    readonly teamId?: string | null;
    readonly environmentId?: EnvironmentId | null;
    readonly projectId?: ProjectId | null;
  } = {},
): void {
  openDialog({
    kind: "team-project",
    teamId: input.teamId ?? null,
    environmentId: input.environmentId ?? null,
    projectId: input.projectId ?? null,
  });
}

export function openTeamProjectThreadDialog(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  openDialog({ kind: "team-project-thread", environmentId, projectId });
}

export function openStopTeamProjectDialog(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  openDialog({ kind: "stop-team-project", environmentId, projectId });
}

export function awaitNewTeamProject(awaited: Omit<AwaitedTeamProject, "addStarted">): void {
  useTeamUiStore.setState({ dialog: null, awaitedProject: { ...awaited, addStarted: false } });
}

export function markProjectAddStarted(environmentId: EnvironmentId): void {
  const awaited = useTeamUiStore.getState().awaitedProject;
  if (awaited === null || awaited.environmentId !== environmentId) return;
  useTeamUiStore.setState({ awaitedProject: { ...awaited, addStarted: true } });
}

export function closeTeamDialog(): void {
  useTeamUiStore.setState({ dialog: null, awaitedProject: null });
}

export function requestWorkspaceSwitcher(): void {
  useTeamUiStore.setState((state) => ({ switcherRequest: state.switcherRequest + 1 }));
}
