// @effect-diagnostics-next-line nodeBuiltinImport:off -- Runs the ripgrep that Claude's Grep runs, as Claude does, with a custom argv0.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type TeamAccessError,
  TeamAgentAskInput,
  type TeamAgentSetInput,
  type TeamMemberIdentity,
  TEAM_AGENT_QUESTION_MAX_LENGTH,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { TeamSharingState } from "./sharedOrganizations.ts";
import * as TeamAgentService from "./TeamAgent.ts";
import { decideTeamAgentAsk, decideTeamAgentSetting, teamAgentStatuses } from "./TeamAgent.ts";
import { decideTeamAgentToolUse, TEAM_AGENT_SECRET_READ_DENY_RULES } from "./TeamAgentToolGuard.ts";
import * as TeamConnectivity from "./TeamConnectivity.ts";
import { decideTeamMemberCommand } from "./TeamMemberAccess.ts";
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

const claudeAdapter = {
  instanceId: modelSelection.instanceId,
  driver: claude,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for this test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const ana: TeamMemberIdentity = {
  userId: "user-ana",
  name: "Ana",
  organizationId: "org-a",
  organizationSlug: "team-a",
  role: "member",
};
const makeTeamAgentLayer = (
  hooks: {
    readonly beforeAgentCount?: Effect.Effect<void>;
    readonly onOwnerChange?: Effect.Effect<void>;
    readonly failStop?: Effect.Effect<boolean>;
    readonly revoked?: Array<string>;
  } = {},
) => {
  const secretValues = new Map<string, Uint8Array>();
  const ownerChanged = hooks.onOwnerChange ?? Effect.void;
  const revoke = (store: string) => (organizationId: string, userId?: string) =>
    Effect.sync(
      () => void hooks.revoked?.push([store, organizationId, userId].join(" ").trim()),
    ).pipe(Effect.andThen(ownerChanged), Effect.as(0));
  const stopFaults = Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Orchestrator.OrchestratorV2.of({
        ...orchestrator,
        dispatch: (command) =>
          command.type === "thread.stop" && hooks.failStop !== undefined
            ? hooks.failStop.pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(
                        new Orchestrator.OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                        }),
                      )
                    : orchestrator.dispatch(command),
                ),
              )
            : orchestrator.dispatch(command),
      });
    }),
  );
  return TeamAgentService.layer.pipe(
    Layer.provideMerge(TeamSharing.layer.pipe(Layer.provide(stopFaults))),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
            getShellSnapshot: (options) =>
              (hooks.beforeAgentCount ?? Effect.void).pipe(
                Effect.andThen(orchestrator.getShellSnapshot(options)),
              ),
          });
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: () => Effect.succeed([{ projectId: web, title: "Web" }] as never),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.succeed(Option.fromNullishOr(secretValues.get(name))),
          set: (name, value) =>
            Effect.sync(() => void secretValues.set(name, value)).pipe(
              Effect.andThen(ownerChanged),
            ),
          remove: (name) => Effect.sync(() => void secretValues.delete(name)),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3",
          legacyCookieName: undefined,
          revokeForOrganization: revoke("sessions"),
        }),
        Layer.mock(PairingGrantStore.PairingGrantStore)({
          revokeForOrganization: revoke("pairing links"),
        }),
        Layer.mock(TeamConnectivity.TeamConnectivity)({
          sharedOrganizationsChanged: () => Effect.void,
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({
              driverKind: claude,
              enabled: true,
              snapshot: { getSnapshot: Effect.succeed({ version: "2.1.300" }) },
            } as never),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry(
        { name: "team-agent-off" },
        ProviderAdapterRegistry.layerFromAdapters([claudeAdapter]),
        { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
      ),
    ),
  );
};

const answering = Orchestrator.OrchestratorV2.pipe(
  Effect.flatMap((orchestrator) => orchestrator.getShellSnapshot()),
  Effect.map((snapshot) =>
    snapshot.threads.flatMap((thread) => (thread.activeRunId === null ? [] : [thread.id])),
  ),
);

it.effect("switching the agent off stops its running answer and takes no follow-up", () =>
  Effect.gen(function* () {
    const sharing = yield* TeamSharing.TeamSharing;
    const teamAgent = yield* TeamAgentService.TeamAgent;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const setAgent = (enabled: boolean) =>
      teamAgent.setAgent(
        { organizationId: "org-a", enabled, projectIds: [web], modelSelection },
        undefined,
      );
    yield* sharing.addSharedOrganization("org-a");
    yield* setAgent(true);
    const { threadId } = yield* teamAgent.askAgent(
      { organizationId: "org-a", text: "Where is auth handled?" },
      ana,
    );
    const runs = orchestrator
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.map((records) => records.runs.map((run) => [run.status, run.queueHeld === true])),
      );
    expect(yield* answering).toEqual([threadId]);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queued-follow-up"),
      threadId,
      messageId: MessageId.make("queued-follow-up"),
      text: "And where are sessions stored?",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });

    yield* setAgent(false);

    expect(yield* answering).toEqual([]);
    expect(yield* runs).toEqual([
      ["interrupted", false],
      ["queued", true],
    ]);
    const stopped = yield* orchestrator.getThreadRecords(threadId, []);
    const followUp = decideTeamMemberCommand({
      command: {
        type: "message.dispatch",
        commandId: CommandId.make("follow-up"),
        threadId,
        messageId: MessageId.make("follow-up"),
        text: "Still there?",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      },
      teamShare: stopped.thread.teamShare ?? undefined,
      member: ana,
      agent: yield* teamAgent.followUpState(threadId, "org-a"),
    });
    expect(Result.isFailure(followUp) && followUp.failure.requiredPermission).toBe("agent_off");

    yield* setAgent(true);
    const next = yield* teamAgent.askAgent(
      { organizationId: "org-a", text: "Which file sets the cookie?" },
      ana,
    );
    expect(yield* answering).toEqual([next.threadId]);
    expect(yield* runs).toEqual([
      ["interrupted", false],
      ["queued", true],
    ]);
  }).pipe(Effect.provide(makeTeamAgentLayer())),
);

it.effect("removing the asking teammate, then unsharing the machine, stops their answers", () =>
  Effect.gen(function* () {
    const sharing = yield* TeamSharing.TeamSharing;
    const teamAgent = yield* TeamAgentService.TeamAgent;
    yield* sharing.addSharedOrganization("org-a");
    yield* teamAgent.setAgent(
      { organizationId: "org-a", enabled: true, projectIds: [web], modelSelection },
      undefined,
    );
    const ben = { ...ana, userId: "user-ben", name: "Ben" };
    const fromAna = yield* teamAgent.askAgent({ organizationId: "org-a", text: "Auth?" }, ana);
    const fromBen = yield* teamAgent.askAgent({ organizationId: "org-a", text: "Cache?" }, ben);
    expect((yield* answering).toSorted()).toEqual([fromAna.threadId, fromBen.threadId].toSorted());

    yield* sharing.revokeMemberAccess({ organizationId: "org-a", userId: ana.userId });
    expect(yield* answering).toEqual([fromBen.threadId]);

    yield* sharing.removeSharedOrganization("org-a");
    expect(yield* answering).toEqual([]);
  }).pipe(Effect.provide(makeTeamAgentLayer())),
);

it.effect("unsharing ends the team's access and stops the other answers when one stop fails", () =>
  Effect.gen(function* () {
    const stopFailed = yield* Ref.make(false);
    const revoked: Array<string> = [];
    yield* Effect.gen(function* () {
      const sharing = yield* TeamSharing.TeamSharing;
      const teamAgent = yield* TeamAgentService.TeamAgent;
      yield* sharing.addSharedOrganization("org-a");
      yield* teamAgent.setAgent(
        { organizationId: "org-a", enabled: true, projectIds: [web], modelSelection },
        undefined,
      );
      const ben = { ...ana, userId: "user-ben", name: "Ben" };
      yield* teamAgent.askAgent({ organizationId: "org-a", text: "Auth?" }, ana);
      yield* teamAgent.askAgent({ organizationId: "org-a", text: "Cache?" }, ben);

      const unshared = yield* sharing.removeSharedOrganization("org-a").pipe(Effect.exit);

      expect(revoked).toEqual(["pairing links org-a", "sessions org-a"]);
      expect(yield* answering).toHaveLength(1);
      expect(Exit.isSuccess(unshared)).toBe(true);
    }).pipe(
      Effect.provide(
        makeTeamAgentLayer({
          failStop: Ref.getAndSet(stopFailed, true).pipe(Effect.map((failed) => !failed)),
          revoked,
        }),
      ),
    );
  }),
);

it.effect.each([
  {
    action: "switching the agent off",
    act: (teamAgent: TeamAgentService.TeamAgent["Service"]) =>
      teamAgent.setAgent(
        { organizationId: "org-a", enabled: false, projectIds: [web], modelSelection },
        undefined,
      ),
  },
  {
    action: "removing the asking teammate",
    act: (
      _teamAgent: TeamAgentService.TeamAgent["Service"],
      sharing: TeamSharing.TeamSharing["Service"],
    ) => sharing.revokeMemberAccess({ organizationId: "org-a", userId: ana.userId }),
  },
])("$action while a question is being checked leaves it not answering", ({ act }) =>
  Effect.gen(function* () {
    const checking = yield* Deferred.make<void>();
    const ownerActed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const sharing = yield* TeamSharing.TeamSharing;
      const teamAgent = yield* TeamAgentService.TeamAgent;
      yield* sharing.addSharedOrganization("org-a");
      yield* teamAgent.setAgent(
        { organizationId: "org-a", enabled: true, projectIds: [web], modelSelection },
        undefined,
      );
      const asking = yield* teamAgent
        .askAgent({ organizationId: "org-a", text: "Where is auth handled?" }, ana)
        .pipe(Effect.forkChild);
      yield* Deferred.await(checking);

      yield* act(teamAgent, sharing);
      yield* Fiber.join(asking);

      expect(yield* answering).toEqual([]);
    }).pipe(
      Effect.provide(
        makeTeamAgentLayer({
          beforeAgentCount: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(ownerActed)),
          ),
          onOwnerChange: Deferred.isDone(checking).pipe(
            Effect.flatMap((paused) =>
              paused ? Deferred.succeed(ownerActed, undefined) : Effect.void,
            ),
          ),
        }),
      ),
    );
  }),
);

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
