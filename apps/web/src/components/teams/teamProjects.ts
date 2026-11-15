import { useAtomValue } from "@effect/atom-react";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProjectTeamShare,
  type RuntimeMode,
  type ScopedThreadRef,
  TEAM_AGENT_QUESTION_MAX_LENGTH,
  TeamAccessError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { readCloudTeamsState } from "~/cloud/cloudTeams";
import { teammateConnectionAtom } from "~/cloud/teamWorkspace";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { runOrThrow } from "./teamAgents";
import { teamAccessMessage } from "./teamPresentation";

export const TEAM_PROJECTS_SECTION_ID = "team-projects";

export const TEAM_PROJECT_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = ["full-access"];

export function teamProjectAccessDetail(mode: RuntimeMode, machine: string): string {
  switch (mode) {
    case "full-access":
      return `Teammates' threads run commands and change files on ${machine} without asking.`;
    case "auto":
      return `Teammates' threads run routine actions on ${machine} without asking.`;
    case "auto-accept-edits":
      return `Teammates' threads change files on ${machine} without asking.`;
    case "approval-required":
      return `Teammates' threads ask before commands and file changes on ${machine}.`;
  }
}

export type TeamProjectMachineState = "online" | "offline" | "connecting" | "outdated";

const machineStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TeamProjectMachineState => {
    const phase = get(environmentPresentations.presentationAtom(environmentId))?.connection.phase;
    if (phase === "offline" || phase === "reconnecting" || phase === "error") return "offline";
    if (phase === "unsupported") return "outdated";
    if (phase !== "connected") return "connecting";
    if (get(teammateConnectionAtom(environmentId))) return "online";
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config === null) return "connecting";
    return config.environment.capabilities.teamProjects === true ? "online" : "outdated";
  }).pipe(Atom.withLabel(`team-projects:machine:${environmentId}`)),
);

const NO_MACHINE_ATOM = Atom.make<TeamProjectMachineState>("connecting").pipe(
  Atom.withLabel("team-projects:no-machine"),
);

export function useTeamProjectMachineState(
  environmentId: EnvironmentId | null,
): TeamProjectMachineState {
  return useAtomValue(environmentId === null ? NO_MACHINE_ATOM : machineStateAtom(environmentId));
}

export function readCanShareTeamProject(environmentId: EnvironmentId): boolean {
  return (
    readCloudTeamsState().status !== "signedOut" &&
    !appAtomRegistry.get(teammateConnectionAtom(environmentId)) &&
    appAtomRegistry.get(serverEnvironment.setTeamProjectShare.permissionAtom(environmentId))
  );
}

const CANNOT_WRITE_ATOM = Atom.make(false).pipe(Atom.withLabel("team-projects:cannot-write"));

export function useCanShareTeamProject(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? CANNOT_WRITE_ATOM
      : serverEnvironment.setTeamProjectShare.permissionAtom(environmentId),
  );
}

export function useMachineProjects(
  environmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentProject> {
  return useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (project.archivedAt ?? null) === null &&
      project.isScratch !== true,
  );
}

export function useTeamProject(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): EnvironmentProject | null {
  return (
    useProjects().find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    ) ?? null
  );
}

const NO_SHELL_ATOM = Atom.make<null>(null).pipe(Atom.withLabel("team-projects:no-thread"));

export function useThreadTeamProject(threadRef: ScopedThreadRef | null): EnvironmentProject | null {
  const key = useAtomValue(
    threadRef === null ? NO_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(threadRef),
    (shell) =>
      shell?.source.teamShare && shell.source.teamShare.agent === undefined
        ? `${shell.projectId}\n${shell.source.teamShare.organizationId}`
        : "",
  );
  const [projectId = "", organizationId = ""] = key.split("\n");
  const project = useTeamProject(threadRef?.environmentId ?? null, projectId as ProjectId);
  return project !== null && TeamWorkspace.isTeamProject(project, organizationId) ? project : null;
}

export function teamThreadTextProblem(text: string): string | null {
  if (text.startsWith("/")) return "Messages cannot start with /.";
  if (text.length > TEAM_AGENT_QUESTION_MAX_LENGTH) return "This message is too long.";
  return null;
}

export function shareTeamProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly organizationId: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}): Promise<ProjectTeamShare> {
  return runOrThrow(serverEnvironment.setTeamProjectShare, {
    environmentId: input.environmentId,
    input: {
      projectId: input.projectId,
      organizationId: input.organizationId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
    },
  });
}

export function stopSharingTeamProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<void> {
  return runOrThrow(serverEnvironment.clearTeamProjectShare, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId },
  });
}

export async function startTeamProjectThread(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly text: string;
}): Promise<ThreadId> {
  const result = await runOrThrow(serverEnvironment.startTeamProjectThread, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId, text: input.text },
  });
  return result.threadId;
}

const isTeamAccessError = Schema.is(TeamAccessError);

export function teamProjectMessage(cause: unknown, fallback: string): string {
  if (isTeamAccessError(cause) && cause.reason === "internal" && cause.message) {
    return cause.message;
  }
  return teamAccessMessage(cause, fallback);
}
