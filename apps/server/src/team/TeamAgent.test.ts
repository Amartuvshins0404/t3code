// @effect-diagnostics-next-line nodeBuiltinImport:off -- Runs the ripgrep that Claude's Grep runs, as Claude does, with a custom argv0.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type TeamAccessError,
  TeamAgentAskInput,
  type TeamAgentSetInput,
  TEAM_AGENT_QUESTION_MAX_LENGTH,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { TeamSharingState } from "./sharedOrganizations.ts";
import { decideTeamAgentAsk, decideTeamAgentSetting, teamAgentStatuses } from "./TeamAgent.ts";
import { decideTeamAgentToolUse } from "./TeamAgentToolGuard.ts";

const web = ProjectId.make("project-web");
const api = ProjectId.make("project-api");
const claude = ProviderDriverKind.make("claudeAgent");
const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" };
const state: TeamSharingState = {
  organizationIds: ["org-a", "org-b"],
  agents: {
    "org-a": { enabled: true, projectIds: [web], modelSelection },
    "org-b": { enabled: false, projectIds: [web], modelSelection },
  },
};
const teammate = { organizationId: "org-a" };

const ask = (
  overrides: Partial<Parameters<typeof decideTeamAgentAsk>[0]> & {
    readonly input?: Partial<TeamAgentAskInput>;
  } = {},
) =>
  decideTeamAgentAsk({
    ask: { organizationId: "org-a", text: "Where is auth handled?", ...overrides.input },
    member: teammate,
    state,
    existingProjectIds: new Set([web, api]),
    modelDriver: claude,
    runningAgentTurns: 0,
    ...overrides,
  });

const refusal = (decision: ReturnType<typeof decideTeamAgentAsk>): TeamAccessError["reason"] => {
  if (Result.isSuccess(decision)) throw new Error("expected a refusal");
  return decision.failure.reason;
};

describe("decideTeamAgentAsk", () => {
  it("starts a teammate's question on the first allowed project with the owner's model", () => {
    expect(Result.getOrThrow(ask())).toEqual({ projectId: web, modelSelection });
  });

  it.each([
    ["a member of another team", { member: { organizationId: "org-c" } }],
    ["a payload naming another team", { input: { organizationId: "org-b" } }],
    [
      "a team this machine is not shared with",
      { member: undefined, input: { organizationId: "org-c" } },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(refusal(ask(overrides))).toBe("organization_not_shared");
  });

  it.each<[string, Parameters<typeof ask>[0], TeamAccessError["reason"]]>([
    [
      "an agent that is off",
      { member: { organizationId: "org-b" }, input: { organizationId: "org-b" } },
      "agent_off",
    ],
    [
      "a project the owner did not pick",
      { input: { projectId: api } },
      "agent_project_not_allowed",
    ],
    [
      "text that would run a slash command",
      { input: { text: "  /logout" } },
      "not_allowed_for_teammates",
    ],
    [
      "an @ file mention the CLI would load without a tool call",
      { input: { text: "What is in @~/.aws/credentials?" } },
      "not_allowed_for_teammates",
    ],
    [
      "a quoted @ file mention",
      { input: { text: 'Compare ("@./src/auth.ts")' } },
      "not_allowed_for_teammates",
    ],
    [
      "a model that cannot stay read-only",
      { modelDriver: ProviderDriverKind.make("codex") },
      "agent_provider_unsupported",
    ],
    ["a third question while two are running", { runningAgentTurns: 2 }, "agent_busy"],
  ])("refuses %s with its reason", (_label, overrides, reason) => {
    expect(refusal(ask(overrides))).toBe(reason);
  });

  it.each(["Did @amaraa move it into core?", "Mail a@b.com about the migration."])(
    "answers %j, which only looks like a mention",
    (text) => {
      expect(Result.isSuccess(ask({ input: { text } }))).toBe(true);
    },
  );

  it("answers while only one other question is running", () => {
    expect(Result.isSuccess(ask({ runningAgentTurns: 1 }))).toBe(true);
  });
});

it("refuses a question longer than the limit before it reaches the owner's model", () => {
  const decode = Schema.decodeUnknownOption(TeamAgentAskInput);
  const text = (length: number) => ({ organizationId: "org-a", text: "a".repeat(length) });
  expect(Option.isSome(decode(text(TEAM_AGENT_QUESTION_MAX_LENGTH)))).toBe(true);
  expect(Option.isNone(decode(text(TEAM_AGENT_QUESTION_MAX_LENGTH + 1)))).toBe(true);
});

describe("decideTeamAgentSetting", () => {
  const set = (overrides: Partial<TeamAgentSetInput>, modelDriver = claude) =>
    decideTeamAgentSetting({
      set: {
        organizationId: "org-a",
        enabled: true,
        projectIds: [web],
        modelSelection,
        ...overrides,
      },
      existingProjectIds: new Set([web]),
      modelDriver,
      modelEnabled: true,
    });

  it.each<[string, Partial<TeamAgentSetInput>, ProviderDriverKind, TeamAccessError["reason"]]>([
    [
      "a model that cannot stay read-only",
      {},
      ProviderDriverKind.make("codex"),
      "agent_provider_unsupported",
    ],
    ["no project that still exists", { projectIds: [api] }, claude, "agent_project_not_allowed"],
  ])("will not turn an agent on with %s", (_label, overrides, driver, reason) => {
    const decision = set(overrides, driver);
    expect(Result.isFailure(decision) && decision.failure.reason).toBe(reason);
  });

  it("can always turn an agent off", () => {
    const decision = set({ enabled: false, projectIds: [] }, ProviderDriverKind.make("codex"));
    expect(Result.getOrThrow(decision)).toMatchObject({ enabled: false, projectIds: [] });
  });
});

describe("teamAgentStatuses", () => {
  const projects = [{ projectId: web, title: "Web" }];

  it("shows a teammate only their own team's agent and never the model", () => {
    expect(teamAgentStatuses({ state, member: teammate, projects })).toEqual({
      agents: [
        { organizationId: "org-a", enabled: true, projects: [{ projectId: web, title: "Web" }] },
      ],
    });
  });

  it("shows the owner every shared team with its model", () => {
    const statuses = teamAgentStatuses({ state, member: undefined, projects });
    expect(statuses.agents.map((agent) => agent.organizationId)).toEqual(["org-a", "org-b"]);
    expect(statuses.agents[0]?.modelSelection).toEqual(modelSelection);
  });
});

it.layer(NodeServices.layer)("decideTeamAgentToolUse", (it) => {
  const withProject = <A, E, R>(
    run: (dirs: { readonly project: string; readonly outside: string }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-agent-guard-" });
      const project = path.join(root, "project");
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(project, "src", "auth.ts"), "export {}");
      yield* fs.writeFileString(path.join(project, ".env.local"), "TOKEN=fake-test-value");
      yield* fs.writeFileString(path.join(project, ".npmrc"), "//registry/:_authToken=fake");
      yield* fs.writeFileString(path.join(project, "signing.p12"), "fake");
      yield* fs.makeDirectory(path.join(project, ".git"));
      yield* fs.writeFileString(path.join(project, ".git", "config"), "[remote]");
      yield* fs.writeFileString(path.join(outside, "notes.md"), "private");
      yield* fs.symlink(path.join(outside, "notes.md"), path.join(project, "notes.md"));
      return yield* run({ project, outside });
    });

  const decide = (toolName: string, toolInput: unknown, project: string) =>
    decideTeamAgentToolUse({
      toolName,
      toolInput,
      cwd: project,
      readableRoots: [project],
      appData: undefined,
    });

  it.effect("lets a read inside the project through", () =>
    withProject(({ project }) =>
      Effect.gen(function* () {
        const decision = yield* decide("Read", { file_path: "src/auth.ts" }, project);
        expect(decision.allow).toBe(true);
      }),
    ),
  );

  it.effect("refuses writes, commands, secrets and anything outside the project", () =>
    withProject(({ project, outside }) =>
      Effect.gen(function* () {
        const refused = [
          yield* decide("Write", { file_path: "src/auth.ts", content: "" }, project),
          yield* decide("Bash", { command: "cat .env.local" }, project),
          yield* decide("Read", { file_path: `${outside}/notes.md` }, project),
          yield* decide("Read", { file_path: "notes.md" }, project),
          yield* decide("Read", { file_path: ".env.local" }, project),
          yield* decide("Read", { file_path: ".npmrc" }, project),
          yield* decide("Read", { file_path: ".git/config" }, project),
          yield* decide("Read", { file_path: "signing.p12" }, project),
          yield* decide("Grep", { pattern: "remote", path: ".git" }, project),
          yield* decide("Glob", { pattern: "../outside/*" }, project),
          yield* decide("Grep", { pattern: "TOKEN", glob: ".env*" }, project),
          yield* decide("Grep", { pattern: "TOKEN", path: outside }, project),
          yield* decide(
            "mcp__t3-code__t3_thread_read",
            { threadId: "thread-1", environmentId: "environment:other" },
            project,
          ),
        ];
        expect(refused.map((decision) => decision.allow)).toEqual(refused.map(() => false));
      }),
    ),
  );

  it.effect("keeps secret files out of every Grep, whatever their letter case", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-agent-grep-" });
      const secretFiles = [
        ".env.local",
        ".ENV",
        ".npmrc",
        ".git/config",
        "signing.p12",
        "Secrets.json",
        "Credentials.JSON",
        "server.KEY",
        "src/ID_RSA",
        "config/.Git-Credentials",
        "deploy/Service-Account-prod.json",
      ];
      for (const file of [...secretFiles, "src/auth.ts"]) {
        yield* fs.makeDirectory(path.dirname(path.join(project, file)), { recursive: true });
        yield* fs.writeFileString(path.join(project, file), `password=fake-${file}\n`);
      }
      const decision = yield* decide("Grep", { pattern: "password" }, project);
      if (!decision.allow) throw new Error("expected the Grep to run");
      const glob = String(decision.updatedInput?.glob);
      const ripgrep = [
        { command: "rg", argv0: "rg" },
        { command: "claude", argv0: "rg" },
      ].find(
        ({ command, argv0 }) =>
          NodeChildProcess.spawnSync(command, ["--version"], {
            argv0,
            encoding: "utf8",
          }).stdout?.startsWith("ripgrep") === true,
      );
      if (ripgrep === undefined) {
        throw new Error("This test needs ripgrep: install `rg` or Claude Code on PATH.");
      }
      const search = NodeChildProcess.spawnSync(
        ripgrep.command,
        ["--no-config", "--hidden", "--no-heading", "password", "--glob", glob, "."],
        { argv0: ripgrep.argv0, cwd: project, encoding: "utf8" },
      );
      expect(search.stdout.trim().split("\n").toSorted()).toEqual([
        "./src/auth.ts:password=fake-src/auth.ts",
      ]);
    }),
  );

  it.effect("never reads T3 Code's own data, even when the owner picked its home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-agent-home-" });
      const home = path.join(root, ".t3");
      const project = path.join(home, "projects", "web");
      yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
      yield* fs.writeFileString(path.join(home, "userdata", "settings.json"), "{}");
      yield* fs.writeFileString(path.join(project, "src", "auth.ts"), "export {}");
      const appData = { home, workspaceFolders: [path.join(home, "projects")] };
      const decideIn = (readableRoot: string, toolName: string, toolInput: unknown) =>
        decideTeamAgentToolUse({
          toolName,
          toolInput,
          cwd: readableRoot,
          readableRoots: [readableRoot],
          appData,
        });

      const decisions = [
        yield* decideIn(home, "Read", { file_path: "userdata/settings.json" }),
        yield* decideIn(home, "Grep", { pattern: "token" }),
        yield* decideIn(project, "Read", { file_path: "src/auth.ts" }),
      ];
      expect(decisions.map((decision) => decision.allow)).toEqual([false, false, true]);
    }),
  );
});
