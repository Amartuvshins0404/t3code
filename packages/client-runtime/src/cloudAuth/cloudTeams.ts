import { TeamRole } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { CloudOrganization } from "./cloudAuth.ts";

export const CloudTeam = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  logo: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CloudTeam = typeof CloudTeam.Type;

export interface CloudTeamSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo: string | null;
  readonly role: TeamRole;
}

const RawMember = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  role: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const RawInvite = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Schema.String,
  status: Schema.String,
  organizationId: Schema.String,
  organizationName: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optional(Schema.Unknown),
});

const RawFullTeam = Schema.Struct({
  ...CloudTeam.fields,
  members: Schema.Array(RawMember),
  invitations: Schema.Array(RawInvite),
});

export interface CloudTeamMember {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly role: TeamRole;
}

export interface CloudTeamInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly teamId: string;
  readonly teamName: string | null;
}

export interface CloudTeamDetail {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo: string | null;
  readonly members: ReadonlyArray<CloudTeamMember>;
  readonly invites: ReadonlyArray<CloudTeamInvite>;
}

export type CloudTeamRequest = (
  path: string,
  init: {
    readonly method: "GET" | "POST";
    readonly query?: Record<string, string>;
    readonly body?: Record<string, unknown>;
  },
) => Promise<unknown>;

export interface CloudTeams {
  readonly list: () => Promise<ReadonlyArray<CloudTeamSummary>>;
  readonly create: (input: { readonly name: string; readonly slug: string }) => Promise<CloudTeam>;
  readonly get: (teamId: string) => Promise<CloudTeamDetail>;
  readonly invite: (input: {
    readonly teamId: string;
    readonly email: string;
    readonly role: TeamRole;
  }) => Promise<void>;
  readonly cancelInvite: (invitationId: string) => Promise<void>;
  readonly myInvites: () => Promise<ReadonlyArray<CloudTeamInvite>>;
  readonly accept: (invitationId: string) => Promise<void>;
  readonly reject: (invitationId: string) => Promise<void>;
  readonly setRole: (input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly role: TeamRole;
  }) => Promise<void>;
  readonly remove: (input: { readonly teamId: string; readonly memberId: string }) => Promise<void>;
  readonly leave: (teamId: string) => Promise<void>;
  readonly delete: (teamId: string) => Promise<void>;
}

export function normalizeTeamRole(role: string): TeamRole {
  const roles = role.split(",").map((entry) => entry.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

export function teamSlugFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return base.length > 0 ? base : "team";
}

const decodeTeams = Schema.decodeUnknownSync(Schema.Array(CloudTeam));
const decodeTeam = Schema.decodeUnknownSync(CloudTeam);
const decodeFullTeam = Schema.decodeUnknownSync(RawFullTeam);
const decodeInvites = Schema.decodeUnknownSync(Schema.Array(RawInvite));

function toInvite(raw: typeof RawInvite.Type): CloudTeamInvite {
  return {
    id: raw.id,
    email: raw.email,
    role: normalizeTeamRole(raw.role),
    teamId: raw.organizationId,
    teamName: raw.organizationName ?? null,
  };
}

export function createCloudTeams(input: {
  readonly request: CloudTeamRequest;
  readonly organizations: (fresh: boolean) => Promise<ReadonlyArray<CloudOrganization>>;
  readonly membershipChanged: () => void;
}): CloudTeams {
  const { request } = input;
  const post = (path: string, body: Record<string, unknown>) =>
    request(path, { method: "POST", body });
  const changed = <A>(run: Promise<A>) =>
    run.then((value) => {
      input.membershipChanged();
      return value;
    });

  return {
    list: async () => {
      const teams = decodeTeams(await request("/organization/list", { method: "GET" }));
      let orgs = await input.organizations(false);
      if (teams.some((team) => !orgs.some((org) => org.id === team.id))) {
        orgs = await input.organizations(true);
      }
      return teams.map((team) => ({
        id: team.id,
        name: team.name,
        slug: team.slug,
        logo: team.logo ?? null,
        role: normalizeTeamRole(orgs.find((org) => org.id === team.id)?.role ?? "member"),
      }));
    },
    create: ({ name, slug }) =>
      changed(
        post("/organization/create", { name, slug, keepCurrentActiveOrganization: true }).then(
          decodeTeam,
        ),
      ),
    get: async (teamId) => {
      const raw = decodeFullTeam(
        await request("/organization/get-full-organization", {
          method: "GET",
          query: { organizationId: teamId },
        }),
      );
      return {
        id: raw.id,
        name: raw.name,
        slug: raw.slug,
        logo: raw.logo ?? null,
        members: raw.members.map((member) => ({
          memberId: member.id,
          userId: member.userId,
          name: member.user.name,
          email: member.user.email,
          image: member.user.image ?? null,
          role: normalizeTeamRole(member.role),
        })),
        invites: raw.invitations
          .filter((invite) => invite.status === "pending")
          .map((invite) => ({ ...toInvite(invite), teamName: raw.name })),
      };
    },
    invite: async ({ teamId, email, role }) => {
      await post("/organization/invite-member", { organizationId: teamId, email, role });
    },
    cancelInvite: async (invitationId) => {
      await post("/organization/cancel-invitation", { invitationId });
    },
    myInvites: async () =>
      decodeInvites(await request("/organization/list-user-invitations", { method: "GET" }))
        .filter((invite) => invite.status === "pending")
        .map(toInvite),
    accept: async (invitationId) => {
      await changed(post("/organization/accept-invitation", { invitationId }));
    },
    reject: async (invitationId) => {
      await post("/organization/reject-invitation", { invitationId });
    },
    setRole: async ({ teamId, memberId, role }) => {
      await post("/organization/update-member-role", { organizationId: teamId, memberId, role });
    },
    remove: async ({ teamId, memberId }) => {
      await post("/organization/remove-member", {
        organizationId: teamId,
        memberIdOrEmail: memberId,
      });
    },
    leave: async (teamId) => {
      await changed(post("/organization/leave", { organizationId: teamId }));
    },
    delete: async (teamId) => {
      await changed(post("/organization/delete", { organizationId: teamId }));
    },
  };
}

export interface CloudTeamsSnapshot {
  readonly userId: string;
  readonly teams: ReadonlyArray<CloudTeamSummary>;
  readonly invites: ReadonlyArray<CloudTeamInvite>;
}

export type CloudTeamsState =
  | { readonly status: "signedOut" }
  | {
      readonly status: "loading" | "ready" | "failed";
      readonly userId: string;
      readonly teams: ReadonlyArray<CloudTeamSummary>;
      readonly invites: ReadonlyArray<CloudTeamInvite>;
      readonly fresh: boolean;
    };

export interface CloudTeamsCache {
  readonly read: () => CloudTeamsSnapshot | null;
  readonly write: (snapshot: CloudTeamsSnapshot | null) => void;
}

export interface CloudTeamsStore {
  readonly getState: () => CloudTeamsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  readonly teams: CloudTeams;
}

export function createCloudTeamsStore(input: {
  readonly auth: {
    readonly getState: () =>
      | { readonly status: "loading" }
      | { readonly status: "signedOut" }
      | { readonly status: "signedIn"; readonly user: { readonly id: string } };
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly teams: CloudTeams;
  readonly cache?: CloudTeamsCache;
}): CloudTeamsStore {
  const { auth, cache } = input;
  const listeners = new Set<() => void>();
  let state: CloudTeamsState = { status: "signedOut" };
  let generation = 0;

  const setState = (next: CloudTeamsState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const startFor = (userId: string) => {
    const cached = cache?.read();
    const seed = cached?.userId === userId ? cached : null;
    setState({
      status: "loading",
      userId,
      teams: seed?.teams ?? [],
      invites: seed?.invites ?? [],
      fresh: false,
    });
  };

  const refresh = async () => {
    const authState = auth.getState();
    if (authState.status !== "signedIn") return;
    const userId = authState.user.id;
    if (state.status === "signedOut" || state.userId !== userId) startFor(userId);
    else if (state.status !== "loading") setState({ ...state, status: "loading" });
    const run = ++generation;
    const result = await Promise.all([
      input.teams.list(),
      input.teams.myInvites().catch(() => null),
    ]).then(
      ([teams, invites]) => ({ ok: true as const, teams, invites }),
      () => ({ ok: false as const }),
    );
    if (run !== generation || state.status === "signedOut" || state.userId !== userId) return;
    if (!result.ok) {
      setState({ ...state, status: "failed" });
      return;
    }
    const invites = result.invites ?? state.invites;
    cache?.write({ userId, teams: result.teams, invites });
    setState({ status: "ready", userId, teams: result.teams, invites, fresh: true });
  };

  let lastUserId: string | null = null;
  const syncAuth = () => {
    const authState = auth.getState();
    if (authState.status === "loading") return;
    const userId = authState.status === "signedIn" ? authState.user.id : null;
    if (userId === lastUserId) return;
    lastUserId = userId;
    generation += 1;
    if (userId === null) {
      cache?.write(null);
      setState({ status: "signedOut" });
      return;
    }
    startFor(userId);
    void refresh();
  };
  auth.subscribe(syncAuth);
  syncAuth();

  const thenRefresh =
    <Args extends ReadonlyArray<unknown>, A>(run: (...args: Args) => Promise<A>) =>
    (...args: Args) =>
      run(...args).finally(() => void refresh());
  const source = input.teams;
  const teams: CloudTeams = {
    ...source,
    create: thenRefresh(source.create),
    invite: thenRefresh(source.invite),
    cancelInvite: thenRefresh(source.cancelInvite),
    accept: thenRefresh(source.accept),
    reject: thenRefresh(source.reject),
    setRole: thenRefresh(source.setRole),
    remove: thenRefresh(source.remove),
    leave: thenRefresh(source.leave),
    delete: thenRefresh(source.delete),
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    teams,
  };
}

export function canManageTeam(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

export function assignableTeamRoles(myRole: TeamRole): ReadonlyArray<TeamRole> {
  if (myRole === "owner") return ["member", "admin", "owner"];
  if (myRole === "admin") return ["member", "admin"];
  return [];
}

export function canEditTeamMember(input: {
  readonly myRole: TeamRole;
  readonly myUserId: string | null;
  readonly member: Pick<CloudTeamMember, "role" | "userId">;
}): boolean {
  const { myRole, myUserId, member } = input;
  if (!canManageTeam(myRole) || member.userId === myUserId) return false;
  return member.role !== "owner" || myRole === "owner";
}

export function canLeaveTeam(input: {
  readonly myRole: TeamRole;
  readonly members: ReadonlyArray<Pick<CloudTeamMember, "role">>;
}): boolean {
  if (input.myRole !== "owner") return true;
  return input.members.filter((member) => member.role === "owner").length > 1;
}
