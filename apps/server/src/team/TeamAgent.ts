import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  TeamAccessError,
  type TeamAgentAskInput,
  type TeamAgentAskResult,
  type TeamAgentSetInput,
  type TeamAgentStatus,
  type TeamAgentStatuses,
  type TeamMemberIdentity,
  type TeamPerson,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type TeamAgentSetting,
  type TeamSharingState,
  teamAgentSetting,
} from "./sharedOrganizations.ts";
import {
  claudeVersionServesTeamAgent,
  hasTeamAgentFileMention,
  TEAM_AGENT_CLAUDE_OUTDATED_MESSAGE,
  TEAM_AGENT_FILE_MENTION_MESSAGE,
} from "./TeamAgentToolGuard.ts";
import {
  TEAM_AGENT_BUSY_MESSAGE,
  TEAM_AGENT_MAX_RUNNING_TURNS,
  teamPerson,
} from "./TeamMemberAccess.ts";
import * as TeamSharing from "./TeamSharing.ts";

const TEAM_AGENT_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export class TeamAgent extends Context.Service<
  TeamAgent,
  {
    readonly getAgents: (
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<TeamAgentStatuses, TeamAccessError>;
    readonly setAgent: (
      input: TeamAgentSetInput,
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<TeamAgentStatus, TeamAccessError>;
    readonly askAgent: (
      input: TeamAgentAskInput,
      member: TeamMemberIdentity | undefined,
    ) => Effect.Effect<TeamAgentAskResult, TeamAccessError>;
    readonly followUpState: (
      threadId: ThreadId,
      organizationId: string,
    ) => Effect.Effect<
      { readonly enabled: boolean; readonly runningTurnsElsewhere: number },
      TeamAccessError
    >;
  }
>()("t3/team/TeamAgent") {}

const refused = (reason: TeamAccessError["reason"], message: string) =>
  new TeamAccessError({ reason, message });

export interface TeamAgentProjectRef {
  readonly projectId: ProjectId;
  readonly title: string;
}

export function teamAgentStatuses(input: {
  readonly state: TeamSharingState;
  readonly member: Pick<TeamMemberIdentity, "organizationId"> | undefined;
  readonly projects: ReadonlyArray<TeamAgentProjectRef>;
  readonly claudeOutdatedOrganizationIds: ReadonlySet<string>;
}): TeamAgentStatuses {
  const organizationIds =
    input.member === undefined
      ? input.state.organizationIds
      : input.state.organizationIds.filter((id) => id === input.member?.organizationId);
  return {
    agents: organizationIds.map((organizationId) => {
      const setting = teamAgentSetting(input.state, organizationId);
      const projects = (setting?.projectIds ?? []).flatMap((projectId) => {
        const project = input.projects.find((candidate) => candidate.projectId === projectId);
        return project === undefined ? [] : [{ projectId, title: project.title }];
      });
      return {
        organizationId,
        enabled: setting?.enabled === true && projects.length > 0,
        projects,
        ...(input.claudeOutdatedOrganizationIds.has(organizationId)
          ? { claudeOutdated: true }
          : {}),
        ...(input.member === undefined && setting?.modelSelection !== undefined
          ? { modelSelection: setting.modelSelection }
          : {}),
      };
    }),
  };
}

export function decideTeamAgentAsk(input: {
  readonly ask: TeamAgentAskInput;
  readonly member: Pick<TeamMemberIdentity, "organizationId"> | undefined;
  readonly state: TeamSharingState;
  readonly existingProjectIds: ReadonlySet<ProjectId>;
  readonly modelDriver: ProviderDriverKind | undefined;
  readonly modelVersion: string | null | undefined;
  readonly runningAgentTurns: number;
}): Result.Result<
  { readonly projectId: ProjectId; readonly modelSelection: ModelSelection },
  TeamAccessError
> {
  const { ask, member, state } = input;
  if (member !== undefined && member.organizationId !== ask.organizationId) {
    return Result.fail(
      refused("organization_not_shared", "You can only ask the agents of your own team."),
    );
  }
  if (!state.organizationIds.includes(ask.organizationId)) {
    return Result.fail(
      refused("organization_not_shared", "This machine is not shared with that team."),
    );
  }
  const setting = teamAgentSetting(state, ask.organizationId);
  if (setting?.enabled !== true) {
    return Result.fail(refused("agent_off", "This agent is off."));
  }
  const allowed = setting.projectIds.filter((projectId) => input.existingProjectIds.has(projectId));
  const projectId = ask.projectId ?? allowed[0];
  if (projectId === undefined || !allowed.includes(projectId)) {
    return Result.fail(
      refused("agent_project_not_allowed", "This agent does not answer about that project."),
    );
  }
  if (ask.text.trimStart().startsWith("/")) {
    return Result.fail(
      refused(
        "not_allowed_for_teammates",
        "Questions cannot start with a slash command. Start with a word.",
      ),
    );
  }
  if (hasTeamAgentFileMention(ask.text)) {
    return Result.fail(refused("not_allowed_for_teammates", TEAM_AGENT_FILE_MENTION_MESSAGE));
  }
  if (
    setting.modelSelection === undefined ||
    input.modelDriver === undefined ||
    !TEAM_AGENT_DRIVERS.has(input.modelDriver)
  ) {
    return Result.fail(
      refused("agent_provider_unsupported", "This agent's model cannot answer questions."),
    );
  }
  if (!claudeVersionServesTeamAgent(input.modelVersion)) {
    return Result.fail(refused("agent_claude_outdated", TEAM_AGENT_CLAUDE_OUTDATED_MESSAGE));
  }
  if (input.runningAgentTurns >= TEAM_AGENT_MAX_RUNNING_TURNS) {
    return Result.fail(refused("agent_busy", TEAM_AGENT_BUSY_MESSAGE));
  }
  return Result.succeed({ projectId, modelSelection: setting.modelSelection });
}

export function decideTeamAgentSetting(input: {
  readonly set: TeamAgentSetInput;
  readonly existingProjectIds: ReadonlySet<ProjectId>;
  readonly modelDriver: ProviderDriverKind | undefined;
  readonly modelEnabled: boolean;
}): Result.Result<TeamAgentSetting, TeamAccessError> {
  const projectIds = [...new Set(input.set.projectIds)].filter((projectId) =>
    input.existingProjectIds.has(projectId),
  );
  const setting: TeamAgentSetting = {
    enabled: input.set.enabled,
    projectIds,
    ...(input.set.modelSelection === undefined ? {} : { modelSelection: input.set.modelSelection }),
  };
  if (!input.set.enabled) return Result.succeed(setting);
  if (projectIds.length === 0) {
    return Result.fail(
      refused("agent_project_not_allowed", "Pick at least one project for your agent."),
    );
  }
  if (
    input.set.modelSelection === undefined ||
    input.modelDriver === undefined ||
    !TEAM_AGENT_DRIVERS.has(input.modelDriver) ||
    !input.modelEnabled
  ) {
    return Result.fail(
      refused(
        "agent_provider_unsupported",
        "Pick an enabled Claude model. Other providers cannot keep an agent read-only.",
      ),
    );
  }
  return Result.succeed(setting);
}

export const questionTitle = (text: string) => {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  return title.length === 0 ? "Question" : title;
};

export const ownerTeamPerson = Effect.fn("TeamAgent.ownerTeamPerson")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const userId = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const ownerName = yield* settings.getSettings.pipe(
    Effect.map((current) => current.ownerName.trim()),
    Effect.orElseSucceed(() => ""),
  );
  return {
    userId: Option.getOrElse(
      Option.filter(userId, (id) => id.length > 0),
      () => "owner",
    ),
    name: ownerName.length > 0 ? ownerName : "Owner",
  } satisfies TeamPerson;
});

const make = Effect.gen(function* () {
  const sharing = yield* TeamSharing.TeamSharing;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const asks = yield* Semaphore.make(1);

  const internal = (message: string) => () => refused("internal", message);
  const uuid = random.uuidV4().pipe(Effect.orDie);

  const listProjects = (projectIds: ReadonlyArray<ProjectId>) =>
    projectIds.length === 0
      ? Effect.succeed([])
      : projects
          .list({ projectIds })
          .pipe(Effect.mapError(internal("Could not read the projects.")));

  const modelInstance = (modelSelection: ModelSelection | undefined) =>
    modelSelection === undefined
      ? Effect.void.pipe(Effect.as(undefined))
      : providerInstances.getInstance(modelSelection.instanceId);

  const ownerPerson = ownerTeamPerson(secrets, settings);

  const runningAgentTurns = (exceptThreadId?: ThreadId) =>
    threadManagement.getShellSnapshot().pipe(
      Effect.map(
        (snapshot) =>
          snapshot.threads.filter(
            (thread) =>
              thread.id !== exceptThreadId &&
              thread.teamShare?.agent !== undefined &&
              thread.activeRunId !== null,
          ).length,
      ),
      Effect.mapError(internal("Could not count the agent's running answers.")),
    );

  const followUpState = Effect.fn("TeamAgent.followUpState")(function* (
    threadId: ThreadId,
    organizationId: string,
  ) {
    const state = yield* sharing.readState;
    return {
      enabled: teamAgentSetting(state, organizationId)?.enabled === true,
      runningTurnsElsewhere: yield* runningAgentTurns(threadId),
    };
  });

  const getAgents = Effect.fn("TeamAgent.getAgents")(function* (
    member: TeamMemberIdentity | undefined,
  ) {
    const state = yield* sharing.readState;
    const projectIds = Object.values(state.agents).flatMap((setting) => setting.projectIds);
    const rows = yield* listProjects([...new Set(projectIds)]);
    const claudeOutdatedOrganizationIds = new Set<string>();
    for (const [organizationId, setting] of Object.entries(state.agents)) {
      if (!setting.enabled) continue;
      const instance = yield* modelInstance(setting.modelSelection);
      if (instance === undefined || !TEAM_AGENT_DRIVERS.has(instance.driverKind)) continue;
      if (!claudeVersionServesTeamAgent((yield* instance.snapshot.getSnapshot).version)) {
        claudeOutdatedOrganizationIds.add(organizationId);
      }
    }
    return teamAgentStatuses({
      state,
      member,
      projects: rows.map((row) => ({ projectId: row.projectId, title: row.title })),
      claudeOutdatedOrganizationIds,
    });
  });

  const setAgent = Effect.fn("TeamAgent.setAgent")(function* (
    input: TeamAgentSetInput,
    member: TeamMemberIdentity | undefined,
  ) {
    if (member !== undefined) {
      return yield* refused(
        "not_allowed_for_teammates",
        "Only the machine's owner can set its agent.",
      );
    }
    const existing = yield* listProjects([...new Set(input.projectIds)]);
    const instance = yield* modelInstance(input.modelSelection);
    const setting = yield* Effect.fromResult(
      decideTeamAgentSetting({
        set: input,
        existingProjectIds: new Set(existing.map((row) => row.projectId)),
        modelDriver: instance?.driverKind,
        modelEnabled: instance?.enabled === true,
      }),
    );
    yield* sharing.setAgentSetting(input.organizationId, setting);
    const statuses = yield* getAgents(undefined);
    const status = statuses.agents.find((agent) => agent.organizationId === input.organizationId);
    if (status === undefined) return yield* refused("internal", "The agent setting was not saved.");
    return status;
  });

  const startConversation = Effect.fn("TeamAgent.startConversation")(function* (input: {
    readonly ask: TeamAgentAskInput;
    readonly member: TeamMemberIdentity | undefined;
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
  }) {
    const threadId = ThreadId.make(yield* uuid);
    const commandId = (label: string) =>
      uuid.pipe(Effect.map((id) => CommandId.make(`server:team-agent:${label}:${id}`)));
    const startedBy = input.member === undefined ? yield* ownerPerson : teamPerson(input.member);
    yield* threadManagement
      .dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "server",
        commandId: yield* commandId("create"),
        threadId,
        projectId: input.projectId,
        title: questionTitle(input.ask.text),
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        teamShare: {
          organizationId: input.ask.organizationId,
          access: "steer",
          agent: { startedBy },
        },
      })
      .pipe(Effect.mapError(internal("Could not start the agent conversation.")));
    const started = yield* Effect.gen(function* () {
      const { thread } = yield* threadManagement.getThreadRecords(threadId, []);
      if (thread.teamShare?.agent === undefined) {
        return yield* Effect.fail("The agent conversation was not shared.");
      }
      yield* threadManagement.dispatch({
        type: "message.dispatch",
        commandId: yield* commandId("ask"),
        threadId,
        messageId: MessageId.make(yield* uuid),
        text: input.ask.text,
        attachments: [],
        modelSelection: input.modelSelection,
        ...(input.member === undefined
          ? {}
          : { context: { version: 1, records: [], member: teamPerson(input.member) } }),
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    }).pipe(Effect.result);
    if (Result.isFailure(started)) {
      yield* threadManagement
        .dispatch({ type: "thread.delete", commandId: yield* commandId("undo"), threadId })
        .pipe(Effect.ignore);
      return yield* refused("internal", "Could not send the question to the agent.");
    }
    return { threadId };
  });

  const askAgent = Effect.fn("TeamAgent.askAgent")(function* (
    input: TeamAgentAskInput,
    member: TeamMemberIdentity | undefined,
  ) {
    return yield* asks.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* sharing.readState;
        const setting = teamAgentSetting(state, input.organizationId);
        const existing = yield* listProjects(setting?.projectIds ?? []);
        const instance = yield* modelInstance(setting?.modelSelection);
        const decision = yield* Effect.fromResult(
          decideTeamAgentAsk({
            ask: input,
            member,
            state,
            existingProjectIds: new Set(existing.map((row) => row.projectId)),
            modelDriver: instance?.enabled === true ? instance.driverKind : undefined,
            modelVersion:
              instance === undefined ? undefined : (yield* instance.snapshot.getSnapshot).version,
            runningAgentTurns: yield* runningAgentTurns(),
          }),
        );
        return yield* startConversation({ ask: input, member, ...decision });
      }),
    );
  });

  return TeamAgent.of({ getAgents, setAgent, askAgent, followUpState });
});

export const layer = Layer.effect(TeamAgent, make);
