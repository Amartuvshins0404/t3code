import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AgentMachine,
  personAgentStatus,
  planTeamConnections,
  shareMachineWithTeam,
  stopSharingMachine,
  teamPanel,
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

  it("lists an agent conversation in its team and never in Personal", () => {
    const agentShare = {
      organizationId: "team-a",
      agent: { startedBy: { userId: "asker", name: "Asker" } },
    };
    const personal: WorkspaceScope = { kind: "personal", teamOnlyEnvironmentIds: new Set() };
    const team: WorkspaceScope = {
      kind: "team",
      teamId: "team-a",
      environmentIds: new Set(["my-machine"]),
    };
    expect(
      workspaceListsThread(personal, { environmentId: "my-machine", teamShare: agentShare }),
    ).toBe(false);
    expect(workspaceListsThread(team, { environmentId: "my-machine", teamShare: agentShare })).toBe(
      true,
    );
    expect(
      workspaceListsThread(personal, {
        environmentId: "my-machine",
        teamShare: teamShare("team-a"),
      }),
    ).toBe(true);
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

describe("team projects in the team panel", () => {
  const machines = [
    { environmentId: "my-machine", ownerUserId: "me" },
    { environmentId: "bat-machine", ownerUserId: "bat" },
  ];
  const project = (
    environmentId: string,
    id: string,
    title: string,
    organizationId: string | null,
  ) => ({
    environmentId,
    id,
    title,
    archivedAt: null,
    teamShare: organizationId === null ? null : { organizationId },
  });
  const thread = (
    id: string,
    environmentId: string,
    projectId: string,
    updatedAt: string,
    share: { organizationId: string; agent?: { startedBy: { userId: string; name: string } } },
  ) => ({
    id,
    environmentId,
    projectId,
    updatedAt,
    archivedAt: null,
    source: { teamShare: share },
  });

  it("lists another member's team project and leaves out projects not shared with this team", () => {
    const panel = teamPanel({
      teamId: "team-a",
      machines,
      projects: [
        project("bat-machine", "api", "api", "team-a"),
        project("my-machine", "web", "web", "team-a"),
        project("bat-machine", "secret", "secret", null),
        project("my-machine", "other-team", "other", "team-b"),
        project("stranger-machine", "far", "far", "team-a"),
      ],
      threads: [],
    });
    expect(panel.projects.map((entry) => entry.project.id)).toEqual(["api", "web"]);
  });

  it("puts a team project's thread under the project only, and keeps agent conversations under the person", () => {
    const panel = teamPanel({
      teamId: "team-a",
      machines,
      projects: [project("bat-machine", "api", "api", "team-a")],
      threads: [
        thread("old", "bat-machine", "api", "2026-11-01", { organizationId: "team-a" }),
        thread("new", "bat-machine", "api", "2026-11-02", { organizationId: "team-a" }),
        thread("loose", "bat-machine", "private-project", "2026-11-03", {
          organizationId: "team-a",
        }),
        thread("ask", "bat-machine", "api", "2026-11-04", {
          organizationId: "team-a",
          agent: { startedBy: { userId: "me", name: "Me" } },
        }),
        thread("elsewhere", "bat-machine", "api", "2026-11-05", { organizationId: "team-b" }),
      ],
    });
    expect(panel.projects[0]?.threads.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(panel.threadsByPerson.get("bat")?.map((entry) => entry.id)).toEqual(["ask", "loose"]);
    expect(panel.threadsByPerson.get("me")).toBeUndefined();
  });

  it("leaves Personal unchanged for threads in my own shared project", () => {
    const personal: WorkspaceScope = { kind: "personal", teamOnlyEnvironmentIds: new Set() };
    expect(
      workspaceListsThread(personal, {
        environmentId: "my-machine",
        teamShare: teamShare("team-a"),
      }),
    ).toBe(true);
    expect(workspaceListsThread(personal, { environmentId: "my-machine", teamShare: null })).toBe(
      true,
    );
  });
});

describe("a person's agent", () => {
  const agent = (enabled: boolean, projects = enabled ? 1 : 0) => ({
    organizationId: "team-a",
    enabled,
    projects: Array.from({ length: projects }, (_, index) => ({
      projectId: ProjectId.make(`project-${index}`),
      title: `Project ${index}`,
    })),
  });
  const machine = (
    environmentId: string,
    sharedAt: string,
    state: AgentMachine["state"],
  ): AgentMachine => ({ environmentId: EnvironmentId.make(environmentId), sharedAt, state });

  it.each([
    ["no machine yet", [], "no_machine"],
    [
      "agent ready",
      [machine("m1", "2026-01-01", { kind: "answered", agent: agent(true) })],
      "ready",
    ],
    ["agent off", [machine("m1", "2026-01-01", { kind: "answered", agent: agent(false) })], "off"],
    [
      "agent on with no project counts as off",
      [machine("m1", "2026-01-01", { kind: "answered", agent: agent(true, 0) })],
      "off",
    ],
    [
      "agent never set counts as off",
      [machine("m1", "2026-01-01", { kind: "answered", agent: null })],
      "off",
    ],
    ["offline", [machine("m1", "2026-01-01", { kind: "offline" })], "offline"],
    ["needs an update", [machine("m1", "2026-01-01", { kind: "outdated" })], "needs_update"],
    ["still connecting", [machine("m1", "2026-01-01", { kind: "connecting" })], "loading"],
    ["still checking", [machine("m1", "2026-01-01", { kind: "checking" })], "loading"],
    [
      "several machines, only the second online and on",
      [
        machine("m1", "2026-01-01", { kind: "offline" }),
        machine("m2", "2026-02-01", { kind: "answered", agent: agent(true) }),
      ],
      "ready",
    ],
  ] as const)("%s", (_, machines, kind) => {
    expect(personAgentStatus(machines).kind).toBe(kind);
  });

  it("sends a question to the oldest shared machine that is online with the agent on", () => {
    const status = personAgentStatus([
      machine("newest-on", "2026-03-01", { kind: "answered", agent: agent(true) }),
      machine("oldest-offline", "2026-01-01", { kind: "offline" }),
      machine("older-off", "2026-01-15", { kind: "answered", agent: agent(false) }),
      machine("older-on", "2026-02-01", { kind: "answered", agent: agent(true) }),
    ]);
    expect(status).toMatchObject({ kind: "ready", environmentId: "older-on" });
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
