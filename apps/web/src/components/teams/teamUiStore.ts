import { create } from "zustand";

export type TeamDialog =
  | { readonly kind: "create" }
  | { readonly kind: "invite"; readonly teamId: string }
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

export function closeTeamDialog(): void {
  useTeamUiStore.setState({ dialog: null });
}

export function requestWorkspaceSwitcher(): void {
  useTeamUiStore.setState((state) => ({ switcherRequest: state.switcherRequest + 1 }));
}
