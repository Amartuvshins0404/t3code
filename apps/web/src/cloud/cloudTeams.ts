import {
  type CloudTeamDetail,
  type CloudTeamInvite,
  type CloudTeams,
  type CloudTeamsSnapshot,
  type CloudTeamsState,
  type CloudTeamsStore,
  type CloudTeamSummary,
  createCloudTeamsStore,
  normalizeTeamRole,
} from "@t3tools/client-runtime/cloud-auth";
import { useSyncExternalStore } from "react";

import { useUiStateStore } from "../uiStateStore";
import { getCloudAuth } from "./cloudAuth";

const TEAMS_CACHE_KEY = "t3code:cloud-teams:v1";
export const PERSONAL_WORKSPACE = "personal";

function readCachedTeams(): CloudTeamsSnapshot | null {
  try {
    const raw = window.localStorage.getItem(TEAMS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId, teams, invites } = parsed as Record<string, unknown>;
    if (typeof userId !== "string" || !Array.isArray(teams) || !Array.isArray(invites)) {
      return null;
    }
    return {
      userId,
      teams: teams.flatMap((team: unknown): CloudTeamSummary[] => {
        if (typeof team !== "object" || team === null) return [];
        const { id, name, slug, logo, role } = team as Record<string, unknown>;
        return typeof id === "string" && typeof name === "string" && typeof slug === "string"
          ? [
              {
                id,
                name,
                slug,
                logo: typeof logo === "string" ? logo : null,
                role: normalizeTeamRole(typeof role === "string" ? role : "member"),
              },
            ]
          : [];
      }),
      invites: [],
    };
  } catch {
    return null;
  }
}

function writeCachedTeams(snapshot: CloudTeamsSnapshot | null) {
  try {
    if (snapshot) {
      window.localStorage.setItem(
        TEAMS_CACHE_KEY,
        JSON.stringify({ userId: snapshot.userId, teams: snapshot.teams, invites: [] }),
      );
    } else {
      window.localStorage.removeItem(TEAMS_CACHE_KEY);
    }
  } catch {}
}

let instance: CloudTeamsStore | null | undefined;

function getCloudTeamsStore(): CloudTeamsStore | null {
  if (instance !== undefined) return instance;
  const auth = getCloudAuth();
  instance = auth
    ? createCloudTeamsStore({
        auth,
        teams: auth.teams,
        cache: { read: readCachedTeams, write: writeCachedTeams },
      })
    : null;
  if (instance && typeof window !== "undefined") {
    const store = instance;
    window.addEventListener("focus", () => void store.refresh());
  }
  return instance;
}

const SIGNED_OUT: CloudTeamsState = { status: "signedOut" };
const noop = () => () => {};

export function useCloudTeamsState(): CloudTeamsState {
  const store = getCloudTeamsStore();
  return useSyncExternalStore(
    store?.subscribe ?? noop,
    () => store?.getState() ?? SIGNED_OUT,
    () => SIGNED_OUT,
  );
}

export function readCloudTeamsState(): CloudTeamsState {
  return getCloudTeamsStore()?.getState() ?? SIGNED_OUT;
}

export function getCloudTeams(): CloudTeams | null {
  return getCloudTeamsStore()?.teams ?? null;
}

export function refreshCloudTeams(): void {
  void getCloudTeamsStore()?.refresh();
}

export type ActiveWorkspace =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly team: CloudTeamSummary };

const PERSONAL: ActiveWorkspace = { kind: "personal" };

export function resolveActiveWorkspace(
  saved: string,
  state: CloudTeamsState,
): { readonly workspace: ActiveWorkspace; readonly lostTeamId: string | null } {
  if (saved === PERSONAL_WORKSPACE || state.status === "signedOut") {
    return { workspace: PERSONAL, lostTeamId: null };
  }
  const team = state.teams.find((candidate) => candidate.id === saved);
  if (team) return { workspace: { kind: "team", team }, lostTeamId: null };
  return { workspace: PERSONAL, lostTeamId: state.status === "ready" ? saved : null };
}

export function useActiveWorkspace(): ActiveWorkspace {
  const saved = useUiStateStore((store) => store.activeWorkspace);
  const state = useCloudTeamsState();
  return resolveActiveWorkspace(saved, state).workspace;
}

export function setActiveWorkspace(workspace: string): void {
  useUiStateStore.getState().setActiveWorkspace(workspace);
}

export type TeamDetailState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly cause: unknown }
  | { readonly status: "ready"; readonly detail: CloudTeamDetail };

const TEAM_DETAIL_LOADING: TeamDetailState = { status: "loading" };
const teamDetails = new Map<string, TeamDetailState>();
const teamDetailListeners = new Map<string, Set<() => void>>();
let lastReadyTeamsState: CloudTeamsState | null = null;
let watchingTeamsStore = false;

function publishTeamDetail(teamId: string, next: TeamDetailState) {
  teamDetails.set(teamId, next);
  for (const listener of teamDetailListeners.get(teamId) ?? []) listener();
}

function loadTeamDetail(teamId: string) {
  const teams = getCloudTeams();
  if (!teams) return;
  teams.get(teamId).then(
    (detail) => publishTeamDetail(teamId, { status: "ready", detail }),
    (cause: unknown) => {
      if (teamDetails.get(teamId)?.status !== "ready") {
        publishTeamDetail(teamId, { status: "failed", cause });
      }
    },
  );
}

function subscribeTeamDetail(teamId: string, listener: () => void) {
  const store = getCloudTeamsStore();
  if (store && !watchingTeamsStore) {
    watchingTeamsStore = true;
    store.subscribe(() => {
      const state = store.getState();
      if (state.status !== "ready" || state === lastReadyTeamsState) return;
      lastReadyTeamsState = state;
      for (const [id, listeners] of teamDetailListeners) {
        if (listeners.size > 0) loadTeamDetail(id);
      }
    });
  }
  let listeners = teamDetailListeners.get(teamId);
  if (!listeners) {
    listeners = new Set();
    teamDetailListeners.set(teamId, listeners);
  }
  listeners.add(listener);
  if (listeners.size === 1) loadTeamDetail(teamId);
  return () => {
    listeners.delete(listener);
  };
}

const teamDetailSubscribers = new Map<string, (listener: () => void) => () => void>();

function teamDetailSubscriber(teamId: string) {
  let subscribe = teamDetailSubscribers.get(teamId);
  if (!subscribe) {
    subscribe = (listener) => subscribeTeamDetail(teamId, listener);
    teamDetailSubscribers.set(teamId, subscribe);
  }
  return subscribe;
}

export function useTeamDetail(teamId: string): TeamDetailState {
  return useSyncExternalStore(
    teamDetailSubscriber(teamId),
    () => teamDetails.get(teamId) ?? TEAM_DETAIL_LOADING,
    () => TEAM_DETAIL_LOADING,
  );
}

export function pendingInvites(state: CloudTeamsState): ReadonlyArray<CloudTeamInvite> {
  return state.status === "signedOut" ? [] : state.invites;
}
