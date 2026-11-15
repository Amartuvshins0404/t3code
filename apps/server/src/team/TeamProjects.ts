import {
  CommandId,
  type ModelSelection,
  type ProjectTeamShare,
  type ProviderDriverKind,
  type RuntimeMode,
  TeamAccessError,
  type TeamMemberIdentity,
  type TeamProjectShareClearInput,
  type TeamProjectShareSetInput,
  type TeamProjectThreadStartInput,
  type TeamProjectThreadStartResult,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { teamPerson } from "./TeamMemberAccess.ts";
import { ownerTeamPerson, questionTitle } from "./TeamAgent.ts";
import * as TeamSharing from "./TeamSharing.ts";

const TEAM_PROJECT_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "kiro",
  "muse",
]);

const TEAM_PROJECT_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set(["full-access"]);

export class TeamProjects extends Context.Service<
  TeamProjects,
  {
    readonly setProjectShare: (
      input: TeamProjectShareSetInput,
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<ProjectTeamShare, TeamAccessError>;
    readonly clearProjectShare: (
      input: TeamProjectShareClearInput,
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<void, TeamAccessError>;
    readonly startProjectThread: (
      input: TeamProjectThreadStartInput,
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<TeamProjectThreadStartResult, TeamAccessError>;
  }
>()("t3/team/TeamProjects") {}

const refused = (reason: TeamAccessError["reason"], message: string) =>
  new TeamAccessError({ reason, message });

export function decideTeamProjectRun(input: {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly modelDriver: ProviderDriverKind | undefined;
  readonly modelEnabled: boolean;
}): Result.Result<
  { readonly modelSelection: ModelSelection; readonly runtimeMode: RuntimeMode },
  TeamAccessError
> {
  if (input.modelDriver === undefined || !input.modelEnabled) {
    return Result.fail(refused("internal", "Pick a model whose provider is set up and turned on."));
  }
  if (!TEAM_PROJECT_DRIVERS.has(input.modelDriver)) {
    return Result.fail(
      refused(
        "internal",
        "This provider can stop to ask for approval, and nobody on the team can answer it. Pick another provider.",
      ),
    );
  }
  if (!TEAM_PROJECT_RUNTIME_MODES.has(input.runtimeMode)) {
    return Result.fail(
      refused(
        "internal",
        "Team project threads run with Full access, so they never wait for an approval nobody can answer.",
      ),
    );
  }
  return Result.succeed({ modelSelection: input.modelSelection, runtimeMode: input.runtimeMode });
}

export function decideTeamProjectThreadStart(input: {
  readonly start: TeamProjectThreadStartInput;
  readonly member: Pick<TeamMemberIdentity, "organizationId"> | undefined;
  readonly project:
    | Pick<ProjectStore.ProjectRow, "teamShare" | "archivedAt" | "deletedAt">
    | undefined;
  readonly sharedOrganizationIds: ReadonlyArray<string>;
}): Result.Result<ProjectTeamShare, TeamAccessError> {
  const { project, member } = input;
  const notShared = () =>
    refused("project_not_shared", "This project is not shared with your team.");
  if (project === undefined || project.deletedAt !== null || project.archivedAt !== null) {
    return Result.fail(
      member === undefined
        ? refused("project_unavailable", "This project is not available.")
        : notShared(),
    );
  }
  const share = project.teamShare;
  if (share === null || !input.sharedOrganizationIds.includes(share.organizationId)) {
    return Result.fail(notShared());
  }
  if (member !== undefined && member.organizationId !== share.organizationId) {
    return Result.fail(notShared());
  }
  if (input.start.text.trimStart().startsWith("/")) {
    return Result.fail(
      refused(
        "not_allowed_for_teammates",
        "A team project thread cannot start with a slash command. Start with a word.",
      ),
    );
  }
  return Result.succeed(share);
}

const make = Effect.gen(function* () {
  const sharing = yield* TeamSharing.TeamSharing;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const random = yield* SecureRandom.SecureRandom;
  const owner = ownerTeamPerson(yield* ServerSecretStore.ServerSecretStore, settings);

  const uuid = random.uuidV4().pipe(Effect.orDie);
  const commandId = (label: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:team-project:${label}:${id}`)));
  const hostOnly = (member: TeamMemberIdentity | undefined) =>
    member === undefined
      ? Effect.void
      : Effect.fail(
          refused("not_allowed_for_teammates", "Only the machine's owner can share its projects."),
        );

  const decideRun = Effect.fn("TeamProjects.decideRun")(function* (
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  ) {
    const instance = yield* providerInstances.getInstance(modelSelection.instanceId);
    return yield* Effect.fromResult(
      decideTeamProjectRun({
        modelSelection,
        runtimeMode,
        modelDriver: instance?.driverKind,
        modelEnabled: instance?.enabled === true,
      }),
    );
  });

  const setProjectShare = Effect.fn("TeamProjects.setProjectShare")(function* (
    input: TeamProjectShareSetInput,
    member: TeamMemberIdentity | undefined,
  ) {
    yield* hostOnly(member);
    const run = yield* decideRun(input.modelSelection, input.runtimeMode);
    const share: ProjectTeamShare = {
      organizationId: input.organizationId,
      sharedAt: DateTime.formatIso(yield* DateTime.now),
      ...run,
    };
    yield* sharing.setProjectShare(input.projectId, share);
    const saved = Option.getOrUndefined(
      yield* projects
        .get(input.projectId)
        .pipe(Effect.mapError(() => refused("internal", "Could not read the project."))),
    );
    if (saved?.teamShare == null) {
      return yield* refused("internal", "The project's share was not saved.");
    }
    return saved.teamShare;
  });

  const clearProjectShare = Effect.fn("TeamProjects.clearProjectShare")(function* (
    input: TeamProjectShareClearInput,
    member: TeamMemberIdentity | undefined,
  ) {
    yield* hostOnly(member);
    yield* sharing.clearProjectShare(input.projectId);
  });

  const workspaceStrategy = Effect.fn("TeamProjects.workspaceStrategy")(function* (
    project: ProjectStore.ProjectRow,
  ) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isNone(current)) return { type: "root" as const };
    const resolved = resolveProjectSettings(current.value, project.projectId, project).settings;
    if (resolved.defaultThreadEnvMode !== "worktree") return { type: "root" as const };
    const branch = yield* git.statusDetailsLocal(project.workspaceRoot).pipe(
      Effect.map((details) => (details.isRepo ? details.branch : null)),
      Effect.orElseSucceed(() => null),
    );
    if (branch === null) return { type: "root" as const };
    return {
      type: "worktree" as const,
      baseRef: branch,
      startFromOrigin: resolved.newWorktreesStartFromOrigin,
    };
  });

  const startProjectThread = Effect.fn("TeamProjects.startProjectThread")(function* (
    input: TeamProjectThreadStartInput,
    member: TeamMemberIdentity | undefined,
  ) {
    const project = Option.getOrUndefined(
      yield* projects
        .get(input.projectId)
        .pipe(Effect.mapError(() => refused("internal", "Could not read the project."))),
    );
    const state = yield* sharing.readState;
    const share = yield* Effect.fromResult(
      decideTeamProjectThreadStart({
        start: input,
        member,
        project,
        sharedOrganizationIds: state.organizationIds,
      }),
    );
    if (project === undefined) return yield* refused("internal", "The project disappeared.");
    const run = yield* decideRun(share.modelSelection, share.runtimeMode);
    const threadId = ThreadId.make(yield* uuid);
    const launched = yield* threadLaunch
      .launch({
        commandId: yield* commandId("start"),
        threadId,
        projectId: project.projectId,
        title: questionTitle(input.text),
        generateTitle: true,
        modelSelection: run.modelSelection,
        runtimeMode: run.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: yield* workspaceStrategy(project),
        initialMessage: {
          text: input.text,
          attachments: [],
          ...(member === undefined
            ? {}
            : { context: { version: 1, records: [], member: teamPerson(member) } }),
        },
        createdBy: "user",
        creationSource: "web",
        teamShare: {
          organizationId: share.organizationId,
          access: "steer",
          startedBy: member === undefined ? yield* owner : teamPerson(member),
        },
      })
      .pipe(Effect.result);
    if (Result.isFailure(launched)) {
      yield* commandId("undo").pipe(
        Effect.flatMap((id) =>
          threadManagement.dispatch({ type: "thread.delete", commandId: id, threadId }),
        ),
        Effect.ignore,
      );
      return yield* refused("internal", "Could not start the thread.");
    }
    return { threadId: launched.success.threadId };
  });

  return TeamProjects.of({ setProjectShare, clearProjectShare, startProjectThread });
});

export const layer = Layer.effect(TeamProjects, make);
