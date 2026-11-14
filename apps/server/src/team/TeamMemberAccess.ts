import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationMessageContext,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type TeamMemberIdentity,
  type TeamPresenceEntry,
  type TeamThreadAccess,
  ThreadId,
  type ThreadTeamShare,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const TEAM_MEMBER_RPC_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.serverProbe,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  WS_METHODS.teamReportPresence,
  WS_METHODS.teamSubscribePresence,
]);

const THREADLESS_RPC_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.serverProbe,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  WS_METHODS.teamReportPresence,
  WS_METHODS.teamSubscribePresence,
]);

const teamMemberRpcRefusal = (method: string, requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `Teammates cannot use ${method} on this machine.`,
    requiredScope,
    requiredPermission: "team-member-allowlist",
  });

const refusal = (message: string, requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message,
    requiredScope,
    requiredPermission: "team-thread-share",
  });

const threadNotSharedError = () =>
  refusal("This thread is not shared with your team.", AuthOrchestrationReadScope);

export const sharedWithTeam = (
  teamShare: ThreadTeamShare | null | undefined,
  organizationId: string,
  need: TeamThreadAccess = "view",
) =>
  teamShare != null &&
  teamShare.organizationId === organizationId &&
  (need === "view" || teamShare.access === "steer");

export interface TeamMemberAuthorization {
  readonly organizationId: string;
  readonly threadShare: (threadId: ThreadId) => Effect.Effect<ThreadTeamShare | null | undefined>;
}

const payloadThreadId = (payload: unknown) =>
  typeof payload === "object" &&
  payload !== null &&
  "threadId" in payload &&
  typeof payload.threadId === "string"
    ? ThreadId.make(payload.threadId)
    : undefined;

export const authorizeTeamMemberRpc = (input: {
  readonly authorization: TeamMemberAuthorization;
  readonly method: string;
  readonly payload: unknown;
  readonly requiredScope: AuthEnvironmentScope;
}): Effect.Effect<void, EnvironmentAuthorizationError> => {
  if (!TEAM_MEMBER_RPC_METHODS.has(input.method)) {
    return Effect.fail(teamMemberRpcRefusal(input.method, input.requiredScope));
  }
  const threadId = payloadThreadId(input.payload);
  if (threadId === undefined) {
    return THREADLESS_RPC_METHODS.has(input.method)
      ? Effect.void
      : Effect.fail(threadNotSharedError());
  }
  return input.authorization
    .threadShare(threadId)
    .pipe(
      Effect.flatMap((teamShare) =>
        sharedWithTeam(teamShare, input.authorization.organizationId)
          ? Effect.void
          : Effect.fail(threadNotSharedError()),
      ),
    );
};

const STEER_DISPATCH_MODES: ReadonlySet<string> = new Set([
  "start_immediately",
  "queue_after_active",
  "steer_active",
]);

export function decideTeamMemberCommand(input: {
  readonly command: OrchestrationV2Command;
  readonly teamShare: ThreadTeamShare | null | undefined;
  readonly member: TeamMemberIdentity;
}): Result.Result<OrchestrationV2Command, EnvironmentAuthorizationError> {
  const { command, member } = input;
  if (command.type !== "message.dispatch" && command.type !== "run.interrupt") {
    return Result.fail(
      refusal(
        "Teammates can only send messages and stop turns on shared threads.",
        AuthOrchestrationOperateScope,
      ),
    );
  }
  if (!sharedWithTeam(input.teamShare, member.organizationId)) {
    return Result.fail(threadNotSharedError());
  }
  if (!sharedWithTeam(input.teamShare, member.organizationId, "steer")) {
    return Result.fail(
      refusal("This thread is shared with your team to view only.", AuthOrchestrationOperateScope),
    );
  }
  if (command.type === "run.interrupt") {
    return Result.succeed({
      type: "run.interrupt",
      commandId: command.commandId,
      threadId: command.threadId,
      runId: command.runId,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    });
  }
  if (!STEER_DISPATCH_MODES.has(command.dispatchMode.type)) {
    return Result.fail(
      refusal(
        "Teammates can send now, queue after the running turn, or steer it.",
        AuthOrchestrationOperateScope,
      ),
    );
  }
  return Result.succeed({
    type: "message.dispatch",
    commandId: command.commandId,
    threadId: command.threadId,
    messageId: command.messageId,
    text: command.text,
    attachments: [],
    context: { version: 1, records: [], member: teamPerson(member) },
    dispatchMode: command.dispatchMode,
    createdBy: "user",
    creationSource: "web",
  });
}

export const teamPerson = (member: TeamMemberIdentity) => ({
  userId: member.userId,
  name: member.name,
  ...(member.image === undefined ? {} : { image: member.image }),
});

export const withoutClientMember = (context: OrchestrationMessageContext) => {
  if (context.member === undefined) return context;
  const { member: _member, ...rest } = context;
  return rest;
};

export function withoutClientMemberAttribution(
  command: OrchestrationV2Command,
): OrchestrationV2Command {
  if (
    (command.type === "message.dispatch" || command.type === "queued-run.edit") &&
    command.context !== undefined
  ) {
    return { ...command, context: withoutClientMember(command.context) };
  }
  return command;
}

export function makeTeamShellFilter(organizationId: string) {
  const projects = new Map<ProjectId, OrchestrationProjectShell>();
  const visibleThreads = new Map<ThreadId, ProjectId>();
  const sentProjects = new Set<ProjectId>();
  const visible = (thread: OrchestrationV2ThreadShell) =>
    sharedWithTeam(thread.teamShare, organizationId);
  const projectInUse = (projectId: ProjectId) =>
    [...visibleThreads.values()].some((candidate) => candidate === projectId);

  return (item: OrchestrationV2ShellStreamItem): ReadonlyArray<OrchestrationV2ShellStreamItem> => {
    switch (item.kind) {
      case "synchronized":
      case "snapshot-required":
        return [item];
      case "snapshot": {
        for (const project of item.snapshot.projects) projects.set(project.id, project);
        const threads = item.snapshot.threads.filter(visible);
        const archivedThreads = item.snapshot.archivedThreads.filter(visible);
        for (const thread of [...threads, ...archivedThreads]) {
          visibleThreads.set(thread.id, thread.projectId);
        }
        const shownProjects = item.snapshot.projects.filter((project) => projectInUse(project.id));
        for (const project of shownProjects) sentProjects.add(project.id);
        const { olderSettled: _olderSettled, ...snapshot } = item.snapshot;
        return [
          {
            ...item,
            snapshot: { ...snapshot, projects: shownProjects, threads, archivedThreads },
          },
        ];
      }
      case "project.updated":
        projects.set(item.project.id, item.project);
        return sentProjects.has(item.project.id) ? [item] : [];
      case "project.removed":
        projects.delete(item.projectId);
        if (!sentProjects.delete(item.projectId)) return [];
        return [item];
      case "thread.updated": {
        if (visible(item.thread)) {
          visibleThreads.set(item.thread.id, item.thread.projectId);
          const project = projects.get(item.thread.projectId);
          if (sentProjects.has(item.thread.projectId) || project === undefined) return [item];
          sentProjects.add(project.id);
          return [{ kind: "project.updated", sequence: item.sequence, project }, item];
        }
        return removeThread(item.thread.id, item.sequence, item.location);
      }
      case "thread.removed":
        return removeThread(item.threadId, item.sequence, item.location);
    }
  };

  function removeThread(
    threadId: ThreadId,
    sequence: number,
    location: "active" | "archive",
  ): ReadonlyArray<OrchestrationV2ShellStreamItem> {
    const projectId = visibleThreads.get(threadId);
    if (projectId === undefined) return [];
    visibleThreads.delete(threadId);
    const removed: OrchestrationV2ShellStreamItem = {
      kind: "thread.removed",
      sequence,
      location,
      threadId,
    };
    if (projectInUse(projectId) || !sentProjects.delete(projectId)) return [removed];
    return [removed, { kind: "project.removed", sequence, projectId }];
  }
}

export function visiblePresenceEntries(input: {
  readonly entries: ReadonlyArray<{
    readonly entry: TeamPresenceEntry;
    readonly organizationId: string | undefined;
  }>;
  readonly organizationId: string;
  readonly sharedThreadIds: ReadonlySet<ThreadId>;
}): ReadonlyArray<TeamPresenceEntry> {
  return input.entries.flatMap(({ entry, organizationId }) => {
    if (!entry.owner && organizationId !== input.organizationId) return [];
    if (entry.threadId === undefined) return [entry];
    if (input.sharedThreadIds.has(entry.threadId)) return [entry];
    const { threadId: _threadId, typing: _typing, ...machineLevel } = entry;
    return [{ ...machineLevel, typing: false }];
  });
}
