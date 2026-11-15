import { useAtomValue } from "@effect/atom-react";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CloudTeamMember } from "@t3tools/client-runtime/cloud-auth";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  TeamAccessError,
  type TeamAgentStatus,
  type TeamPerson,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { useTeamDetail } from "~/cloud/cloudTeams";
import { teammateConnectionAtom, useTeamMachines } from "~/cloud/teamWorkspace";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { useSelfUserId } from "./teamPresence";
import { teamAccessMessage } from "./teamPresentation";

export const TEAM_AGENT_SECTION_ID = "team-agent";

const machineAgentStateAtom = Atom.family((key: string) => {
  const [environmentId, organizationId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get): TeamWorkspace.AgentMachineState => {
    const phase = get(environmentPresentations.presentationAtom(environmentId))?.connection.phase;
    if (phase === "offline" || phase === "error") return { kind: "offline" };
    if (phase === "unsupported") return { kind: "outdated" };
    if (phase !== "connected") return { kind: "connecting" };
    if (!get(teammateConnectionAtom(environmentId))) {
      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (config === null) return { kind: "checking" };
      if (config.environment.capabilities.teamAgent !== true) return { kind: "outdated" };
    }
    const result = get(serverEnvironment.teamAgents({ environmentId, input: {} }));
    if (result._tag === "Initial") return { kind: "checking" };
    if (result._tag === "Failure") return { kind: "outdated" };
    return {
      kind: "answered",
      agent: result.value.agents.find((agent) => agent.organizationId === organizationId) ?? null,
    };
  }).pipe(Atom.withLabel(`team-agent:machine:${key}`));
});

function machineAgentKey(environmentId: string, organizationId: string): string {
  return JSON.stringify([environmentId, organizationId]);
}

const NOT_ASKED_ATOM = Atom.make<TeamWorkspace.AgentMachineState>({ kind: "checking" }).pipe(
  Atom.withLabel("team-agent:not-asked"),
);

export function useMachineAgentState(
  environmentId: EnvironmentId,
  organizationId: string | null,
): TeamWorkspace.AgentMachineState {
  return useAtomValue(
    organizationId === null
      ? NOT_ASKED_ATOM
      : machineAgentStateAtom(machineAgentKey(environmentId, organizationId)),
  );
}

interface TeamAgentsKey {
  readonly organizationId: string;
  readonly people: ReadonlyArray<
    readonly [userId: string, machines: ReadonlyArray<readonly [EnvironmentId, string]>]
  >;
}

const teamAgentStatusesAtom = Atom.family((key: string) => {
  const { organizationId, people } = JSON.parse(key) as TeamAgentsKey;
  return Atom.make(
    (get): ReadonlyMap<string, TeamWorkspace.PersonAgentStatus> =>
      new Map(
        people.map(([userId, machines]) => [
          userId,
          TeamWorkspace.personAgentStatus(
            machines.map(([environmentId, sharedAt]) => ({
              environmentId,
              sharedAt,
              state: get(machineAgentStateAtom(machineAgentKey(environmentId, organizationId))),
            })),
          ),
        ]),
      ),
  ).pipe(Atom.withLabel(`team-agent:people:${key}`));
});

export function useTeamAgentStatuses(
  organizationId: string,
  userIds: ReadonlyArray<string>,
  machines: ReadonlyArray<RelayTeamEnvironmentRecord>,
): ReadonlyMap<string, TeamWorkspace.PersonAgentStatus> {
  const key: TeamAgentsKey = {
    organizationId,
    people: userIds.map((userId) => [
      userId,
      machines
        .filter((machine) => machine.owner.userId === userId)
        .map((machine) => [machine.environmentId, machine.sharedAt] as const),
    ]),
  };
  return useAtomValue(teamAgentStatusesAtom(JSON.stringify(key)));
}

export interface TeamPersonEntry {
  readonly person: TeamPerson;
  readonly self: boolean;
  readonly machines: ReadonlyArray<RelayTeamEnvironmentRecord>;
}

function teamPeople(input: {
  readonly members: ReadonlyArray<CloudTeamMember>;
  readonly machines: ReadonlyArray<RelayTeamEnvironmentRecord>;
  readonly selfUserId: string | null;
}): ReadonlyArray<TeamPersonEntry> {
  const people = new Map<string, TeamPerson>();
  for (const member of input.members) {
    people.set(member.userId, {
      userId: member.userId,
      name: member.name,
      ...(member.image ? { image: member.image } : {}),
    });
  }
  for (const machine of input.machines) {
    if (!people.has(machine.owner.userId)) people.set(machine.owner.userId, machine.owner);
  }
  return [...people.values()]
    .map((person) => ({
      person,
      self: person.userId === input.selfUserId,
      machines: input.machines.filter((machine) => machine.owner.userId === person.userId),
    }))
    .sort((left, right) =>
      left.self !== right.self
        ? left.self
          ? -1
          : 1
        : left.person.name.localeCompare(right.person.name),
    );
}

export type TeamPeopleState =
  | { readonly status: "personal" }
  | {
      readonly status: "loading" | "ready" | "failed";
      readonly teamId: string;
      readonly machines: ReadonlyArray<RelayTeamEnvironmentRecord>;
      readonly people: ReadonlyArray<TeamPersonEntry>;
    };

export function useTeamPeople(): TeamPeopleState {
  const state = useTeamMachines();
  const detail = useTeamDetail(state.status === "personal" ? "" : state.teamId);
  const selfUserId = useSelfUserId();
  if (state.status === "personal") return state;
  return {
    status: state.status,
    teamId: state.teamId,
    machines: state.machines,
    people: teamPeople({
      members: detail.status === "ready" ? detail.detail.members : [],
      machines: state.machines,
      selfUserId,
    }),
  };
}

async function runOrThrow<W, A, E>(command: AtomCommand<W, A, E>, value: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { reportFailure: false });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function refreshMachineAgents(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(serverEnvironment.teamAgents({ environmentId, input: {} }));
}

export async function askTeamAgent(input: {
  readonly environmentId: EnvironmentId;
  readonly organizationId: string;
  readonly projectId: ProjectId | null;
  readonly text: string;
}): Promise<ThreadId> {
  try {
    const result = await runOrThrow(serverEnvironment.askTeamAgent, {
      environmentId: input.environmentId,
      input: {
        organizationId: input.organizationId,
        text: input.text,
        ...(input.projectId === null ? {} : { projectId: input.projectId }),
      },
    });
    return result.threadId;
  } catch (cause) {
    refreshMachineAgents(input.environmentId);
    throw cause;
  }
}

export async function saveTeamAgent(input: {
  readonly environmentId: EnvironmentId;
  readonly organizationId: string;
  readonly enabled: boolean;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly modelSelection: ModelSelection | null;
}): Promise<TeamAgentStatus> {
  try {
    return await runOrThrow(serverEnvironment.setTeamAgent, {
      environmentId: input.environmentId,
      input: {
        organizationId: input.organizationId,
        enabled: input.enabled,
        projectIds: [...input.projectIds],
        ...(input.modelSelection === null ? {} : { modelSelection: input.modelSelection }),
      },
    });
  } finally {
    refreshMachineAgents(input.environmentId);
  }
}

const isTeamAccessError = Schema.is(TeamAccessError);

export function teamAgentMessage(cause: unknown, person: TeamPerson, self: boolean): string {
  const owner = self ? "Your" : `${person.name}'s`;
  if (isTeamAccessError(cause)) {
    switch (cause.reason) {
      case "agent_off":
        return `${owner} agent is off.`;
      case "agent_project_not_allowed":
        return `${owner} agent does not answer about that project.`;
      case "agent_provider_unsupported":
        return self
          ? "Pick a Claude or Codex model."
          : `${person.name} needs to pick a Claude or Codex model for their agent.`;
      case "agent_busy":
        return `${owner} agent is answering two questions. Try again in a moment.`;
      default:
        break;
    }
  }
  return teamAccessMessage(cause, "Could not send the question. Try again.");
}

const NO_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("team-agent:no-thread"),
);

export interface AgentConversation {
  readonly organizationId: string;
  readonly projectId: ProjectId;
}

export function useAgentConversation(threadRef: ScopedThreadRef | null): AgentConversation | null {
  const key = useAtomValue(
    threadRef === null ? NO_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(threadRef),
    (shell) => {
      const share = shell?.source.teamShare;
      return shell && share?.agent ? JSON.stringify([share.organizationId, shell.projectId]) : "";
    },
  );
  if (key === "") return null;
  const [organizationId, projectId] = JSON.parse(key) as [string, ProjectId];
  return { organizationId, projectId };
}

export function agentAnswersOff(state: TeamWorkspace.AgentMachineState): boolean {
  return state.kind === "answered" && !TeamWorkspace.agentIsReady(state.agent);
}
