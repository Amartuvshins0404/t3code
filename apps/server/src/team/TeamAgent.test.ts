// @effect-diagnostics-next-line nodeBuiltinImport:off -- Runs the ripgrep that Claude's Grep runs, as Claude does, with a custom argv0.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { TeamSharingState } from "./sharedOrganizations.ts";
import * as TeamAgent from "./TeamAgent.ts";
import { decideTeamAgentAsk, decideTeamAgentSetting, teamAgentStatuses } from "./TeamAgent.ts";
import { decideTeamAgentToolUse, TEAM_AGENT_SECRET_READ_DENY_RULES } from "./TeamAgentToolGuard.ts";
import * as TeamSharing from "./TeamSharing.ts";

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
    modelVersion: "2.1.248",
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
      "a bracketed @ file mention",
      { input: { text: 'Compare ("@./src/auth.ts")' } },
      "not_allowed_for_teammates",
    ],
    [
      "an @ mention of a parent folder",
      { input: { text: "Read @../secrets/notes.md" } },
      "not_allowed_for_teammates",
    ],
    [
      "a quoted @ file mention",
      { input: { text: 'Summarise @"my file.txt"' } },
      "not_allowed_for_teammates",
    ],
    [
      "a model that cannot stay read-only",
      { modelDriver: ProviderDriverKind.make("codex") },
      "agent_provider_unsupported",
    ],
    ["a Claude Code older than 2.1.248", { modelVersion: "2.1.247" }, "agent_claude_outdated"],
    ["a Claude Code of unknown version", { modelVersion: null }, "agent_claude_outdated"],
    ["a third question while two are running", { runningAgentTurns: 2 }, "agent_busy"],
  ])("refuses %s with its reason", (_label, overrides, reason) => {
    expect(refusal(ask(overrides))).toBe(reason);
  });

  it.each([
    "Did @amaraa move it into core?",
    "Mail a@b.com about the migration.",
    "Which @effect/platform version do we use?",
    "Do we still need @types/node and @angular/core?",
    "Where does @/components resolve?",
    "What changed in @v1.2?",
    "Is @media.print still used?",
    "Why is @Injectable() on the service?",
  ])("answers %j, which only looks like a mention", (text) => {
    expect(Result.isSuccess(ask({ input: { text } }))).toBe(true);
  });

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

it.effect("keeps the No project folder away from a team agent", () => {
  const scratch = ProjectId.make("project-scratch");
  const row = (projectId: ProjectId, title: string): ProjectStore.ProjectRow => ({
    projectId,
    title,
    workspaceRoot: `/work/${projectId}`,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    deletedAt: null,
    teamShare: null,
  });
  const rows = [row(scratch, "No project"), row(web, "Web")];
  let saved: TeamSharingState = {
    organizationIds: ["org-a", "org-b"],
    agents: {
      "org-a": { enabled: true, projectIds: [scratch, web], modelSelection },
      "org-b": { enabled: true, projectIds: [scratch], modelSelection },
    },
  };
  return Effect.gen(function* () {
    const agent = yield* TeamAgent.TeamAgent;
    const refused = yield* agent
      .setAgent(
        { organizationId: "org-a", enabled: true, projectIds: [scratch], modelSelection },
        undefined,
      )
      .pipe(Effect.flip);
    expect(refused.reason).toBe("agent_project_not_allowed");
    expect(saved.agents).toEqual({
      "org-a": { enabled: true, projectIds: [web], modelSelection },
      "org-b": { enabled: false, projectIds: [], modelSelection },
    });
  }).pipe(
    Effect.provide(
      TeamAgent.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.mock(TeamSharing.TeamSharing)({
              readState: Effect.sync(() => saved),
              setAgentSetting: (organizationId, setting) =>
                Effect.sync(() => {
                  saved = { ...saved, agents: { ...saved.agents, [organizationId]: setting } };
                  return setting;
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              list: (options) =>
                Effect.succeed(
                  rows.filter((candidate) => options?.projectIds?.includes(candidate.projectId)),
                ),
            }),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/work",
              isScratchProject: (projectId) => Effect.succeed(projectId === scratch),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.undefined,
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(ServerSecretStore.ServerSecretStore)({}),
          ),
        ),
      ),
    ),
  );
});

describe("teamAgentStatuses", () => {
  const projects = [{ projectId: web, title: "Web" }];

  it("shows a teammate only their own team's agent and never the model", () => {
    expect(
      teamAgentStatuses({
        state,
        member: teammate,
        projects,
        claudeOutdatedOrganizationIds: new Set(),
      }),
    ).toEqual({
      agents: [
        { organizationId: "org-a", enabled: true, projects: [{ projectId: web, title: "Web" }] },
      ],
    });
  });

  it("shows the owner every shared team with its model and whether Claude Code is too old", () => {
    const statuses = teamAgentStatuses({
      state,
      member: undefined,
      projects,
      claudeOutdatedOrganizationIds: new Set(["org-a"]),
    });
    expect(statuses.agents.map((agent) => agent.organizationId)).toEqual(["org-a", "org-b"]);
    expect(statuses.agents[0]?.modelSelection).toEqual(modelSelection);
    expect(statuses.agents.map((agent) => agent.claudeOutdated === true)).toEqual([true, false]);
  });
});

const secretCopies = [
  "server.key.bak",
  "server.key.backup",
  "server.key.old",
  "server.key.orig",
  "server.key.save",
  "server.key.copy",
  "server.key.tmp",
  "server.key.swp",
  "server.key.swo",
  "server.key~",
  "server.key.1",
  "server.key.2025-01-01",
  ".server.key.swp",
  "#server.key#",
  "cert.pem.old",
  "store.p12.bak",
  "prod.tfvars~",
  "prod.tfstate.bak",
  "credentials.orig",
  "credentials~",
  "#credentials#",
  ".credentials.swp",
  "kubeconfig.bak",
  ".npmrc.bak",
  ".netrc~",
  "database.yml.bak",
  ".git-credentials.bak",
  "#.env#",
];
const ordinaryFiles = [
  "keyboard.ts",
  "api.keys.ts",
  "monkey.png",
  "pem-utils.ts",
  "i18n.keys.json",
  "README.md",
  "package.json",
];

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

  it.effect("refuses secret names spelled with look-alike or hidden characters", () =>
    withProject(({ project }) =>
      Effect.gen(function* () {
        const refused = [
          yield* decide("Read", { file_path: ".Kube/config" }, project),
          yield* decide("Read", { file_path: ".ſsh/config" }, project),
          yield* decide("Read", { file_path: "certs/master.Key" }, project),
          yield* decide("Read", { file_path: "kubeconﬁg" }, project),
          yield* decide("Read", { file_path: ".e​nv.local" }, project),
          yield* decide("Read", { file_path: ".ｅnv.local" }, project),
          yield* decide("Grep", { pattern: "token", path: ".ſsh" }, project),
          yield* decide("Glob", { pattern: "*", path: ".Kube" }, project),
        ];
        expect(refused.map((decision) => (decision.allow ? "allowed" : decision.reason))).toEqual(
          refused.map(() => expect.stringContaining("Secret files")),
        );
      }),
    ),
  );

  it.effect("refuses backup and editor copies of secret files, not source files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-agent-copies-" });
      const copies = [...secretCopies, "server.ｋey.bak", "cert.p​em.old"];
      yield* fs.makeDirectory(path.join(project, "certs"));
      for (const file of [...ordinaryFiles, ...copies.map((copy) => `certs/${copy}`)]) {
        yield* fs.writeFileString(path.join(project, file), "");
      }
      const refused = [];
      for (const file of copies) {
        refused.push(yield* decide("Read", { file_path: `certs/${file}` }, project));
      }
      expect(refused.map((decision) => (decision.allow ? "allowed" : decision.reason))).toEqual(
        refused.map(() => expect.stringContaining("Secret files")),
      );
      const readable = [];
      for (const file of ordinaryFiles) {
        readable.push(yield* decide("Read", { file_path: file }, project));
      }
      expect(readable.map((decision) => decision.allow)).toEqual(ordinaryFiles.map(() => true));
    }),
  );

  it.effect("keeps secret files out of every Grep and every Read rule, whatever their case", () =>
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
        ...secretCopies.map((file) => `certs/${file}`),
        "certs/SERVER.KEY.BAK",
      ];
      const readableFiles = ["src/auth.ts", ...ordinaryFiles.map((file) => `src/${file}`)];
      for (const file of [...secretFiles, ...readableFiles]) {
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
      const rg = (args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync(ripgrep.command, ["--no-config", "--hidden", ...args, "."], {
          argv0: ripgrep.argv0,
          cwd: project,
          encoding: "utf8",
        })
          .stdout.trim()
          .split("\n")
          .toSorted();
      expect(rg(["--no-heading", "password", "--glob", glob])).toEqual(
        readableFiles.map((file) => `./${file}:password=fake-${file}`).toSorted(),
      );
      const readRuleGlobs = TEAM_AGENT_SECRET_READ_DENY_RULES.flatMap((rule) => [
        "--iglob",
        `!${rule.slice("Read(".length, -1)}`,
      ]);
      expect(rg(["--files", ...readRuleGlobs])).toEqual(
        readableFiles.map((file) => `./${file}`).toSorted(),
      );
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
