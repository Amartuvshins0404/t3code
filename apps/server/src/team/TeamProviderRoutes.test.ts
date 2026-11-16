import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { teamConnectivityStatusRequest } from "./TeamMemberAccess.ts";
import {
  applyRelayTeamConnectivity,
  decideTeamTurnRoute,
  isTeamProviderSessionId,
  type TeamConnectivityMemory,
  TeamConnectivityUnavailableError,
  teamConnectivityStatus,
  teamProviderConfig,
  teamProviderEnvironment,
  turnProviderSessionId,
  withSharedOrganizations,
} from "./TeamProviderRoutes.ts";
import { codexAppServerArgs, codexLaunchArgModelProvider } from "../provider/codexLaunchArgs.ts";

const FAKE_KEY = "fake-team-client-key-for-tests";
const share = (organizationId: string) => ({
  organizationId,
  access: "steer" as const,
  sharedAt: "2026-11-15T00:00:00.000Z",
});
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");

const memory: TeamConnectivityMemory = {
  sharedOrganizationIds: ["org-ready", "org-lost", "org-none"],
  connections: new Map([
    [
      "org-ready",
      {
        organizationId: "org-ready",
        url: "https://proxy.test",
        clientKey: FAKE_KEY,
        version: "v2",
      },
    ],
  ]),
  configured: new Map([
    ["org-ready", "v2"],
    ["org-lost", "v1"],
  ]),
};

const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread-shared");
const ownerSessionId = ProviderSessionId.make("provider-session:owner");
const freshOwnerSessionId = ProviderSessionId.make("provider-session:owner-fresh");

describe("decideTeamTurnRoute", () => {
  it.each([claude, codex])("runs a %s turn on a shared thread through a ready team", (driver) => {
    expect(decideTeamTurnRoute(memory, { teamShare: share("org-ready"), driver })).toEqual({
      type: "team",
      organizationId: "org-ready",
      version: "v2",
    });
  });

  it("refuses a team turn when the team has a connection but the key is not here", () => {
    expect(decideTeamTurnRoute(memory, { teamShare: share("org-lost"), driver: claude })).toEqual({
      type: "unavailable",
      organizationId: "org-lost",
    });
  });

  it.each([
    ["a team without a connection", share("org-none"), claude],
    ["another driver", share("org-ready"), cursor],
    ["an unshared thread", null, claude],
    ["a team this machine is no longer shared with", share("org-gone"), claude],
  ] as const)("keeps the owner's account for %s", (_, teamShare, driver) => {
    expect(decideTeamTurnRoute(memory, { teamShare, driver })).toEqual({ type: "owner" });
  });

  it.effect("gives a team turn its own session and puts an unshared thread back on the owner", () =>
    Effect.gen(function* () {
      const teamSession = yield* turnProviderSessionId({
        route: { type: "team", organizationId: "org-ready", version: "v2" },
        current: ownerSessionId,
        instanceId,
        threadId,
        ownerSessionId: () => Effect.succeed(freshOwnerSessionId),
      });
      expect(isTeamProviderSessionId(teamSession)).toBe(true);
      expect(teamSession).not.toContain(FAKE_KEY);

      const newVersion = yield* turnProviderSessionId({
        route: { type: "team", organizationId: "org-ready", version: "v3" },
        current: teamSession,
        instanceId,
        threadId,
        ownerSessionId: () => Effect.succeed(freshOwnerSessionId),
      });
      expect(newVersion).not.toBe(teamSession);

      const unshared = yield* turnProviderSessionId({
        route: { type: "owner" },
        current: teamSession,
        instanceId,
        threadId,
        ownerSessionId: () => Effect.succeed(freshOwnerSessionId),
      });
      expect(unshared).toBe(freshOwnerSessionId);

      const untouched = yield* turnProviderSessionId({
        route: { type: "owner" },
        current: ownerSessionId,
        instanceId,
        threadId,
        ownerSessionId: () => Effect.succeed(freshOwnerSessionId),
      });
      expect(untouched).toBe(ownerSessionId);
    }),
  );
});

describe("team connectivity memory", () => {
  it("drops a team's key as soon as the machine stops sharing with it", () => {
    const next = withSharedOrganizations(memory, ["org-lost", "org-none"]);
    expect(next.connections.has("org-ready")).toBe(false);
    expect(decideTeamTurnRoute(next, { teamShare: share("org-ready"), driver: claude })).toEqual({
      type: "owner",
    });
  });

  it("keeps a team unavailable when the relay does not vouch for the share, and forgets one it says has none", () => {
    const next = applyRelayTeamConnectivity(memory, memory.sharedOrganizationIds, {
      sharedOrganizationIds: ["org-ready"],
      teams: [],
    });
    expect(next.connections.size).toBe(0);
    expect(decideTeamTurnRoute(next, { teamShare: share("org-ready"), driver: claude }).type).toBe(
      "owner",
    );
    expect(decideTeamTurnRoute(next, { teamShare: share("org-lost"), driver: claude }).type).toBe(
      "unavailable",
    );
  });

  it("ignores relay keys for teams this machine is not shared with", () => {
    const next = applyRelayTeamConnectivity(memory, ["org-none"], {
      sharedOrganizationIds: ["org-none", "org-other"],
      teams: [
        {
          organizationId: "org-other",
          url: "https://other.test",
          clientKey: FAKE_KEY,
          version: "v1",
        },
      ],
    });
    expect(next.connections.size).toBe(0);
  });
});

describe("what clients receive", () => {
  it("never carries the key in a status, a session id or a refusal", () => {
    const status = teamConnectivityStatus(memory, { checkedAt: "2026-11-15T00:00:00.000Z" });
    expect(
      status.organizations.map(({ organizationId, state }) => [organizationId, state]),
    ).toEqual([
      ["org-ready", "ready"],
      ["org-lost", "unavailable"],
      ["org-none", "not_configured"],
    ]);
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
    expect(
      new TeamConnectivityUnavailableError({ organizationId: "org-lost" }).message,
    ).not.toContain(FAKE_KEY);
  });

  it("hands the key over only under T3's own name, and blanks every Claude credential", () => {
    for (const driver of ["claudeAgent", "codex"] as const) {
      const environment = teamProviderEnvironment(
        driver,
        [
          { name: "ANTHROPIC_API_KEY", value: "owner-key-not-real", sensitive: true },
          { name: "ANTHROPIC_AUTH_TOKEN", value: "owner-token-not-real", sensitive: true },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "owner-oauth-not-real", sensitive: true },
        ],
        { url: "https://proxy.test", clientKey: FAKE_KEY },
      );
      expect(environment.filter((variable) => variable.value === FAKE_KEY)).toEqual([
        { name: "T3_TEAM_PROXY_API_KEY", value: FAKE_KEY, sensitive: true },
      ]);
      if (driver === "claudeAgent") {
        expect(
          Object.fromEntries(environment.map((variable) => [variable.name, variable.value])),
        ).toMatchObject({
          ANTHROPIC_BASE_URL: "https://proxy.test",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        });
      }
    }
  });

  it("starts Codex on the team proxy after the owner's own launch args", () => {
    const config = teamProviderConfig(
      "codex",
      { launchArgs: "-c model_provider=owner" },
      { url: "https://proxy.test/base" },
    ) as { readonly launchArgs: string };
    const argv = codexAppServerArgs(config.launchArgs);
    const strays = argv.filter(
      (arg, index) => arg !== "app-server" && arg !== "-c" && argv[index - 1] !== "-c",
    );
    const overrides = argv.filter((_, index) => argv[index - 1] === "-c");
    expect(strays).toEqual([]);
    expect(overrides.findLast((arg) => arg.startsWith("model_provider="))).toBe(
      "model_provider=t3team",
    );
    expect(overrides).toContain("model_providers.t3team.base_url=https://proxy.test/base/v1");
    expect(overrides).toContain('model_providers.t3team.auth.command="/bin/sh"');
    expect(overrides).toContain('model_providers.t3team.auth.args=["-c","cat <&3"]');
    expect(overrides.some((arg) => arg.includes("env_key"))).toBe(false);
    expect(overrides).toContain("features.shell_snapshot=false");
    expect(codexLaunchArgModelProvider(config.launchArgs)).toBe("t3team");
  });
});

describe("team.getConnectivity for a teammate", () => {
  it("shows only the teammate's own team and never refreshes for them", () => {
    const request = teamConnectivityStatusRequest(
      { refresh: true },
      { organizationId: "org-ready" },
    );
    expect(request.refresh).toBe(false);
    const status = teamConnectivityStatus(memory, {
      checkedAt: "2026-11-15T00:00:00.000Z",
      organizationId: request.organizationId,
    });
    expect(status.organizations.map((entry) => entry.organizationId)).toEqual(["org-ready"]);
  });

  it("lets the owner refresh and see every team", () => {
    expect(teamConnectivityStatusRequest({ refresh: true }, undefined)).toEqual({ refresh: true });
  });
});
