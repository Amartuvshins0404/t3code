import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectTeamShare,
  type RuntimeMode,
  type TeamAccessError,
  type TeamMemberIdentity,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  decideTeamProjectRun,
  decideTeamProjectThreadStart,
  layer as teamProjectsLayer,
  TeamProjects,
} from "./TeamProjects.ts";
import * as TeamSharing from "./TeamSharing.ts";

const projectId = ProjectId.make("project-team");
const shareModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-team" };
const share: ProjectTeamShare = {
  organizationId: "org-a",
  sharedAt: "2026-11-15T00:00:00.000Z",
  modelSelection: shareModel,
  runtimeMode: "full-access",
};
const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Team",
  workspaceRoot: "/repo",
  defaultModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-host" },
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  teamShare: share,
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});
const ana: TeamMemberIdentity = {
  userId: "user-ana",
  name: "Ana",
  organizationId: "org-a",
  organizationSlug: "team-a",
  role: "member",
};

const reason = <A>(decision: Result.Result<A, TeamAccessError>) => {
  if (Result.isSuccess(decision)) throw new Error("expected a refusal");
  return decision.failure.reason;
};

describe("decideTeamProjectThreadStart", () => {
  const start = (overrides: Partial<Parameters<typeof decideTeamProjectThreadStart>[0]> = {}) =>
    decideTeamProjectThreadStart({
      start: { projectId, text: "Fix the login bug" },
      member: { organizationId: "org-a" },
      project: row(),
      sharedOrganizationIds: ["org-a", "org-b"],
      ...overrides,
    });

  it("lets a teammate of the project's team and the host start a thread", () => {
    expect(Result.getOrThrow(start())).toEqual(share);
    expect(Result.getOrThrow(start({ member: undefined }))).toEqual(share);
  });

  it.each<[string, Partial<Parameters<typeof decideTeamProjectThreadStart>[0]>]>([
    ["a member of another team", { member: { organizationId: "org-b" } }],
    ["a teammate once the share is cleared", { project: row({ teamShare: null }) }],
    [
      "the host once the share is cleared",
      { member: undefined, project: row({ teamShare: null }) },
    ],
    ["a teammate after the machine is unshared", { sharedOrganizationIds: ["org-b"] }],
    ["a teammate in an archived project", { project: row({ archivedAt: share.sharedAt }) }],
  ])("refuses %s", (_label, overrides) => {
    expect(reason(start(overrides))).toBe("project_not_shared");
  });

  it("refuses text that would run a slash command", () => {
    expect(reason(start({ start: { projectId, text: " /logout" } }))).toBe(
      "not_allowed_for_teammates",
    );
  });
});

describe("decideTeamProjectRun", () => {
  const run = (runtimeMode: RuntimeMode, driver = "codex", enabled = true) =>
    decideTeamProjectRun({
      modelSelection: shareModel,
      runtimeMode,
      modelDriver: ProviderDriverKind.make(driver),
      modelEnabled: enabled,
    });

  it.each<RuntimeMode>(["approval-required", "auto-accept-edits", "auto"])(
    "refuses %s, which can wait for an approval nobody on the team can answer",
    (mode) => {
      expect(reason(run(mode))).toBe("internal");
    },
  );

  it.each(["antigravity", "fx", "acpRegistry", "pi"])(
    "refuses full access on %s, which can still ask or does not offer it",
    (driver) => {
      expect(reason(run("full-access", driver))).toBe("internal");
    },
  );

  it("refuses a model whose provider is turned off", () => {
    expect(reason(run("full-access", "codex", false))).toBe("internal");
  });

  it("accepts full access on a provider that never asks in it", () => {
    expect(Result.getOrThrow(run("full-access", "claudeAgent"))).toEqual({
      modelSelection: shareModel,
      runtimeMode: "full-access",
    });
  });
});

const teamProjects = (
  input: {
    readonly launches?: Array<ThreadLaunchService.ThreadLaunchInput>;
    readonly shared?: Array<ProjectTeamShare>;
    readonly scratchProjectId?: ProjectId;
  } = {},
) =>
  TeamProjects.pipe(
    Effect.provide(
      teamProjectsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TeamSharing.TeamSharing)({
              readState: Effect.succeed({ organizationIds: ["org-a"], agents: {} }),
              setProjectShare: (_projectId, teamShare) => {
                input.shared?.push(teamShare);
                return Effect.void;
              },
            }),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: (id) => Effect.succeed(id === input.scratchProjectId),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(row()),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () =>
                Effect.succeed({
                  driverKind: ProviderDriverKind.make("codex"),
                  enabled: true,
                } as never),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (launch) => {
                input.launches?.push(launch);
                return Effect.succeed({
                  threadId: launch.threadId ?? ThreadId.make("thread-new"),
                  projection: {} as never,
                  resumed: false,
                });
              },
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            ServerSettings.layerTest({
              defaultThreadEnvMode: "worktree",
              newWorktreesStartFromOrigin: false,
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetailsLocal: () => Effect.succeed({ isRepo: true, branch: "main" } as never),
            }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedNone,
            }),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(7)),
            ),
          ),
        ),
      ),
    ),
  );

it.effect("the No project space cannot be shared with a team, while a project can", () =>
  Effect.gen(function* () {
    const scratchProjectId = ProjectId.make("project-scratch");
    const shared: Array<ProjectTeamShare> = [];
    const service = yield* teamProjects({ shared, scratchProjectId });
    const shareInput = {
      organizationId: "org-a",
      modelSelection: shareModel,
      runtimeMode: "full-access",
    } as const;

    const refusal = yield* service
      .setProjectShare({ ...shareInput, projectId: scratchProjectId }, undefined)
      .pipe(Effect.flip);
    expect(refusal.reason).toBe("project_unavailable");
    expect(shared).toEqual([]);

    yield* service.setProjectShare({ ...shareInput, projectId }, undefined);
    expect(shared.map((entry) => entry.organizationId)).toEqual(["org-a"]);
  }),
);

it.effect("a teammate's thread runs with the share's model, access and workspace only", () =>
  Effect.gen(function* () {
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const service = yield* teamProjects({ launches });

    const result = yield* service.startProjectThread(
      {
        projectId,
        text: "Fix the login bug",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-max" },
        runtimeMode: "full-access",
        workspaceStrategy: { type: "existing_worktree", worktreePath: "/etc" },
        attachments: [{ type: "image" }],
      } as never,
      ana,
    );

    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(result.threadId).toBe(launch.threadId);
    expect(launch.modelSelection).toEqual(shareModel);
    expect(launch.runtimeMode).toBe("full-access");
    expect(launch.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "main",
      startFromOrigin: false,
    });
    expect(launch.initialMessage).toEqual({
      text: "Fix the login bug",
      attachments: [],
      context: { version: 1, records: [], member: { userId: "user-ana", name: "Ana" } },
    });
    expect(launch.teamShare).toEqual({
      organizationId: "org-a",
      access: "steer",
      startedBy: { userId: "user-ana", name: "Ana" },
    });
  }),
);
