import type { EnvironmentId, ScopedThreadRef, TeamPerson } from "@t3tools/contracts";
import { create } from "zustand";

export type TeamDialog =
  | { readonly kind: "create" }
  | { readonly kind: "invite"; readonly teamId: string }
  | { readonly kind: "share-thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "share-machine"; readonly environmentId: EnvironmentId }
  | { readonly kind: "ask-agent"; readonly teamId: string; readonly person: TeamPerson }
  | null;

interface TeamUiState {
  readonly dialog: TeamDialog;
  readonly switcherRequest: number;
}

export const useTeamUiStore = create<TeamUiState>(() => ({ dialog: null, switcherRequest: 0 }));

export function openCreateTeamDialog(): void {
  useTeamUiStore.setState({ dialog: { kind: "create" } });
}

export function openInviteTeamDialog(teamId: string): void {
  useTeamUiStore.setState({ dialog: { kind: "invite", teamId } });
}

export function openTeamShareThreadDialog(threadRef: ScopedThreadRef): void {
  useTeamUiStore.setState({ dialog: { kind: "share-thread", threadRef } });
}

export function openTeamShareMachineDialog(environmentId: EnvironmentId): void {
  useTeamUiStore.setState({ dialog: { kind: "share-machine", environmentId } });
}

export function openAskAgentDialog(teamId: string, person: TeamPerson): void {
  useTeamUiStore.setState({ dialog: { kind: "ask-agent", teamId, person } });
}

export function closeTeamDialog(): void {
  useTeamUiStore.setState({ dialog: null });
}

export function requestWorkspaceSwitcher(): void {
  useTeamUiStore.setState((state) => ({ switcherRequest: state.switcherRequest + 1 }));
}
