import { describe, expect, it } from "vite-plus/test";

import {
  planTeamConnections,
  shareMachineWithTeam,
  stopSharingMachine,
  threadComposerMode,
  threadConnectivity,
  workspaceListsThread,
  type WorkspaceScope,
} from "./teamWorkspace.ts";

const teamShare = (organizationId: string) => ({ organizationId });

describe("workspace scope", () => {
  it("Personal never lists a machine the team workspace connected", () => {
    const personal: WorkspaceScope = {
      kind: "personal",
      teamOnlyEnvironmentIds: new Set(["teammate-machine"]),
    };
    expect(
      workspaceListsThread(personal, {
        environmentId: "teammate-machine",
        teamShare: teamShare("team-a"),
      }),
    ).toBe(false);
    expect(workspaceListsThread(personal, { environmentId: "my-machine", teamShare: null })).toBe(
      true,
    );
  });

  it("a team workspace lists only threads shared with that team on its machines", () => {
    const team: WorkspaceScope = {
      kind: "team",
      teamId: "team-a",
      environmentIds: new Set(["my-machine", "teammate-machine"]),
    };
    expect(workspaceListsThread(team, { environmentId: "my-machine", teamShare: null })).toBe(
      false,
    );
    expect(
      workspaceListsThread(team, { environmentId: "my-machine", teamShare: teamShare("team-b") }),
    ).toBe(false);
    expect(
      workspaceListsThread(team, { environmentId: "my-machine", teamShare: teamShare("team-a") }),
    ).toBe(true);
    expect(
      workspaceListsThread(team, {
        environmentId: "unshared-machine",
        teamShare: teamShare("team-a"),
      }),
    ).toBe(false);
  });

  it("leaving a team drops only the connections the team workspace added", () => {
    const plan = planTeamConnections({
      catalogIds: new Set(["my-machine", "teammate-machine"]),
      tracked: ["teammate-machine"],
      wanted: [],
    });
    expect(plan.remove).toEqual(["teammate-machine"]);
    expect(plan.register).toEqual([]);
    expect(plan.tracked).toEqual([]);

    const joined = planTeamConnections({
      catalogIds: new Set(["my-machine"]),
      tracked: [],
      wanted: ["my-machine", "teammate-machine"],
    });
    expect(joined.register).toEqual(["teammate-machine"]);
    expect(joined.remove).toEqual([]);
    expect(joined.tracked).toEqual(["teammate-machine"]);
  });
});

describe("thread composer", () => {
  it("gives a View teammate no composer, and none once the share ends", () => {
    expect(threadComposerMode({ teammate: true, teamShare: { access: "view" } })).toBe("view");
    expect(threadComposerMode({ teammate: true, teamShare: null })).toBe("unshared");
    expect(threadComposerMode({ teammate: true, teamShare: { access: "steer" } })).toBe("steer");
    expect(threadComposerMode({ teammate: false, teamShare: { access: "view" } })).toBe("owner");
  });
});

describe("machine sharing", () => {
  it("undoes the relay share when the machine refuses its half", async () => {
    const calls: string[] = [];
    const result = await shareMachineWithTeam({
      shareOnRelay: async () => void calls.push("relay:share"),
      consentOnMachine: async () => {
        calls.push("machine:add");
        throw new Error("machine offline");
      },
      unshareOnRelay: async () => void calls.push("relay:unshare"),
    });
    expect(result).toMatchObject({ ok: false, failed: "machine", undone: true });
    expect(calls).toEqual(["relay:share", "machine:add", "relay:unshare"]);
  });

  it("never asks the machine to consent when the relay refuses", async () => {
    const calls: string[] = [];
    const result = await shareMachineWithTeam({
      shareOnRelay: async () => {
        calls.push("relay:share");
        throw new Error("not a member");
      },
      consentOnMachine: async () => void calls.push("machine:add"),
      unshareOnRelay: async () => void calls.push("relay:unshare"),
    });
    expect(result).toMatchObject({ ok: false, failed: "relay" });
    expect(calls).toEqual(["relay:share"]);
  });

  it("re-shares on the relay when the machine cannot withdraw, so both halves agree", async () => {
    const calls: string[] = [];
    const result = await stopSharingMachine({
      unshareOnRelay: async () => void calls.push("relay:unshare"),
      withdrawOnMachine: async () => {
        calls.push("machine:remove");
        throw new Error("refused");
      },
      shareOnRelay: async () => void calls.push("relay:share"),
    });
    expect(result).toMatchObject({ ok: false, failed: "machine", undone: true });
    expect(calls).toEqual(["relay:unshare", "machine:remove", "relay:share"]);
  });
});

describe("what a shared thread runs on", () => {
  const status = (
    state: "ready" | "not_configured" | "unavailable",
    drivers: ReadonlyArray<"claudeAgent" | "codex"> = ["claudeAgent", "codex"],
  ) => [{ organizationId: "team-a", state, drivers, checkedAt: "2026-11-15T00:00:00.000Z" }];
  const decide = (input: Partial<Parameters<typeof threadConnectivity>[0]>) =>
    threadConnectivity({
      machineSupportsTeamConnectivity: true,
      organizationId: "team-a",
      status: status("ready"),
      driver: "claudeAgent",
      ...input,
    });

  it("spends the team's accounts only when the machine is ready and the provider is Claude or Codex", () => {
    expect(decide({ driver: "claudeAgent" })).toEqual({ kind: "team" });
    expect(decide({ driver: "codex" })).toEqual({ kind: "team" });
  });

  it("stays on the owner's accounts in every other case, with the reason", () => {
    expect(decide({ driver: "cursor" })).toEqual({ kind: "owner", reason: "provider" });
    expect(decide({ status: status("ready", ["claudeAgent"]), driver: "codex" })).toEqual({
      kind: "owner",
      reason: "provider",
    });
    expect(decide({ status: status("not_configured") })).toEqual({
      kind: "owner",
      reason: "no_connection",
    });
    expect(decide({ organizationId: "team-b" })).toEqual({
      kind: "owner",
      reason: "no_connection",
    });
    expect(decide({ machineSupportsTeamConnectivity: false })).toEqual({
      kind: "owner",
      reason: "machine_outdated",
    });
  });

  it("warns when the team has a connection the machine cannot use right now", () => {
    expect(decide({ status: status("unavailable", []) })).toEqual({ kind: "unavailable" });
    expect(decide({ status: status("unavailable", []), driver: "opencode" })).toEqual({
      kind: "owner",
      reason: "provider",
    });
  });

  it("claims nothing before the machine answers", () => {
    expect(decide({ status: null })).toEqual({ kind: "unknown" });
    expect(decide({ driver: null })).toEqual({ kind: "unknown" });
  });
});
