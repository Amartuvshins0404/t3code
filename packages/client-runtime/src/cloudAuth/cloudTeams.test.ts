import { describe, expect, it, vi } from "vite-plus/test";

import {
  assignableTeamRoles,
  canEditTeamMember,
  canLeaveTeam,
  canManageTeam,
  type CloudTeams,
  type CloudTeamsSnapshot,
  createCloudTeams,
  createCloudTeamsStore,
  normalizeTeamRole,
} from "./cloudTeams.ts";

type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "signedIn"; readonly user: { readonly id: string } };

function fakeAuth(initial: AuthState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: AuthState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

function fakeTeams(overrides: Partial<CloudTeams> = {}): CloudTeams {
  const fail = () => Promise.reject(new Error("not faked"));
  return {
    list: async () => [],
    myInvites: async () => [],
    create: fail,
    get: fail,
    invite: fail,
    cancelInvite: fail,
    accept: fail,
    reject: fail,
    setRole: fail,
    remove: fail,
    leave: fail,
    delete: fail,
    ...overrides,
  };
}

const acme = { id: "org-1", name: "Acme", slug: "acme", logo: null, role: "admin" as const };

describe("team permissions", () => {
  it("lets only owners and admins manage, and only owners hand out owner", () => {
    expect(canManageTeam("member")).toBe(false);
    expect(assignableTeamRoles("member")).toEqual([]);
    expect(assignableTeamRoles("admin")).not.toContain("owner");
    expect(assignableTeamRoles("owner")).toContain("owner");
  });

  it("keeps admins off owners and everyone off their own row", () => {
    const owner = { role: "owner" as const, userId: "u-owner" };
    const member = { role: "member" as const, userId: "u-member" };
    expect(canEditTeamMember({ myRole: "admin", myUserId: "u-admin", member: owner })).toBe(false);
    expect(canEditTeamMember({ myRole: "admin", myUserId: "u-admin", member })).toBe(true);
    expect(canEditTeamMember({ myRole: "member", myUserId: "u-x", member })).toBe(false);
    expect(canEditTeamMember({ myRole: "owner", myUserId: "u-owner", member: owner })).toBe(false);
  });

  it("stops the only owner from leaving", () => {
    expect(canLeaveTeam({ myRole: "owner", members: [{ role: "owner" }, { role: "admin" }] })).toBe(
      false,
    );
    expect(canLeaveTeam({ myRole: "owner", members: [{ role: "owner" }, { role: "owner" }] })).toBe(
      true,
    );
    expect(canLeaveTeam({ myRole: "member", members: [{ role: "owner" }] })).toBe(true);
  });

  it("reads the strongest role from a combined role string", () => {
    expect(normalizeTeamRole("member,admin")).toBe("admin");
    expect(normalizeTeamRole("owner")).toBe("owner");
    expect(normalizeTeamRole("viewer")).toBe("member");
  });
});

describe("createCloudTeams", () => {
  it("takes roles from a fresh identity when a listed team is missing from the cached one", async () => {
    const organizations = vi.fn(async (fresh: boolean) =>
      fresh ? [{ id: "org-1", slug: "acme", role: "owner" }] : [],
    );
    const teams = createCloudTeams({
      request: async () => [{ id: "org-1", name: "Acme", slug: "acme", logo: null }],
      organizations,
      membershipChanged: () => {},
    });
    await expect(teams.list()).resolves.toEqual([
      { id: "org-1", name: "Acme", slug: "acme", logo: null, role: "owner" },
    ]);
    expect(organizations).toHaveBeenLastCalledWith(true);
  });

  it("drops the cached relay identity after joining or leaving, not after a failed call", async () => {
    const membershipChanged = vi.fn();
    let fail = false;
    const teams = createCloudTeams({
      request: async () => {
        if (fail) throw new Error("refused");
        return {};
      },
      organizations: async () => [],
      membershipChanged,
    });
    await teams.accept("inv-1");
    await teams.leave("org-1");
    expect(membershipChanged).toHaveBeenCalledTimes(2);
    fail = true;
    await expect(teams.delete("org-1")).rejects.toThrow("refused");
    expect(membershipChanged).toHaveBeenCalledTimes(2);
  });
});

describe("createCloudTeamsStore", () => {
  it("never seeds one person's teams from another person's cache", () => {
    const cached: CloudTeamsSnapshot = { userId: "someone-else", teams: [acme], invites: [] };
    const store = createCloudTeamsStore({
      auth: fakeAuth({ status: "signedIn", user: { id: "me" } }),
      teams: fakeTeams({ list: () => new Promise(() => {}) }),
      cache: { read: () => cached, write: () => {} },
    });
    expect(store.getState()).toMatchObject({ status: "loading", userId: "me", teams: [] });
  });

  it("clears teams and the cache on sign-out", async () => {
    const auth = fakeAuth({ status: "signedIn", user: { id: "me" } });
    const write = vi.fn();
    const store = createCloudTeamsStore({
      auth,
      teams: fakeTeams({ list: async () => [acme] }),
      cache: { read: () => null, write },
    });
    await store.refresh();
    expect(store.getState()).toMatchObject({ status: "ready", teams: [acme], fresh: true });
    auth.set({ status: "signedOut" });
    expect(store.getState()).toEqual({ status: "signedOut" });
    expect(write).toHaveBeenLastCalledWith(null);
  });

  it("reloads the list after a change and keeps the last list when a reload fails", async () => {
    let listed = [acme];
    let failList = false;
    const store = createCloudTeamsStore({
      auth: fakeAuth({ status: "signedIn", user: { id: "me" } }),
      teams: fakeTeams({
        list: async () => {
          if (failList) throw new Error("offline");
          return listed;
        },
        leave: async () => {
          listed = [];
        },
      }),
    });
    await store.refresh();
    await store.teams.leave("org-1");
    await store.refresh();
    expect(store.getState()).toMatchObject({ status: "ready", teams: [] });
    listed = [acme];
    await store.refresh();
    failList = true;
    await store.refresh();
    expect(store.getState()).toMatchObject({ status: "failed", teams: [acme] });
  });
});
