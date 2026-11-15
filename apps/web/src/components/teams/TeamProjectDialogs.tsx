import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ModelSelection, ProjectId, RuntimeMode } from "@t3tools/contracts";
import { createModelSelection, formatModelSlugName } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useActiveWorkspace, useCloudTeamsState } from "~/cloud/cloudTeams";
import {
  useManagedRelayEnvironments,
  useManagedRelayTeamEnvironments,
} from "~/cloud/managedRelayState";
import { useTeamMachine } from "~/cloud/teamWorkspace";
import { openCommandPalette } from "~/commandPaletteBus";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
} from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  shareTeamProject,
  startTeamProjectThread,
  stopSharingTeamProject,
  TEAM_PROJECT_RUNTIME_MODES,
  teamProjectAccessDetail,
  teamProjectMessage,
  teamThreadTextProblem,
  useCanShareTeamProject,
  useMachineProjects,
  useTeamProject,
  useTeamProjectMachineState,
} from "./teamProjects";
import {
  awaitNewTeamProject,
  closeTeamDialog,
  openStopTeamProjectDialog,
  useTeamUiStore,
} from "./teamUiStore";

const ADD_PROJECT_VALUE = "add-project";

function useAwaitedProject(): {
  readonly teamId: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
} | null {
  const awaited = useTeamUiStore((state) => state.awaitedProject);
  const projects = useProjects();
  if (awaited === null) return null;
  const known = new Set<string>(awaited.knownProjectIds);
  const added = projects.find(
    (project) =>
      project.environmentId === awaited.environmentId &&
      !known.has(project.id) &&
      project.isScratch !== true &&
      (project.archivedAt ?? null) === null,
  );
  return added
    ? { teamId: awaited.teamId, environmentId: awaited.environmentId, projectId: added.id }
    : null;
}

export function TeamProjectDialogHost() {
  const dialog = useTeamUiStore((state) => state.dialog);
  const awaited = useAwaitedProject();
  if (dialog?.kind === "team-project") {
    return (
      <TeamProjectDialog
        key={`${dialog.teamId}:${dialog.environmentId}:${dialog.projectId}`}
        initialTeamId={dialog.teamId}
        initialEnvironmentId={dialog.environmentId}
        initialProjectId={dialog.projectId}
        projectFixed={dialog.projectId !== null}
      />
    );
  }
  if (dialog?.kind === "team-project-thread") {
    return (
      <TeamProjectThreadDialog
        key={`${dialog.environmentId}:${dialog.projectId}`}
        environmentId={dialog.environmentId}
        projectId={dialog.projectId}
      />
    );
  }
  if (dialog?.kind === "stop-team-project") {
    return (
      <StopTeamProjectDialog
        key={`${dialog.environmentId}:${dialog.projectId}`}
        environmentId={dialog.environmentId}
        projectId={dialog.projectId}
      />
    );
  }
  if (dialog === null && awaited !== null) {
    return (
      <TeamProjectDialog
        key={`added:${awaited.environmentId}:${awaited.projectId}`}
        initialTeamId={awaited.teamId}
        initialEnvironmentId={awaited.environmentId}
        initialProjectId={awaited.projectId}
        projectFixed={false}
      />
    );
  }
  return null;
}

function defaultModelSelection(
  project: EnvironmentProject | null,
  entries: ReturnType<typeof deriveProviderInstanceEntries>,
): ModelSelection | null {
  const projectDefault = project?.defaultModelSelection ?? null;
  if (
    projectDefault !== null &&
    entries.some((entry) => entry.instanceId === projectDefault.instanceId)
  ) {
    return projectDefault;
  }
  const entry = entries.find(isProviderInstancePickerReady) ?? entries[0];
  const model =
    entry?.models.find((candidate) => candidate.isDefault)?.slug ?? entry?.models[0]?.slug;
  return entry && model ? createModelSelection(entry.instanceId, model) : null;
}

function TeamProjectDialog({
  initialTeamId,
  initialEnvironmentId,
  initialProjectId,
  projectFixed,
}: {
  readonly initialTeamId: string | null;
  readonly initialEnvironmentId: EnvironmentId | null;
  readonly initialProjectId: ProjectId | null;
  readonly projectFixed: boolean;
}) {
  const navigate = useNavigate();
  const teamsState = useCloudTeamsState();
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const workspace = useActiveWorkspace();
  const fixedProject = useTeamProject(initialEnvironmentId, initialProjectId);
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);
  const teamId =
    pickedTeamId ??
    initialTeamId ??
    fixedProject?.teamShare?.organizationId ??
    (workspace.kind === "team" ? workspace.team.id : (teams[0]?.id ?? null));
  const team = teams.find((candidate) => candidate.id === teamId) ?? null;
  const teamMachines = useManagedRelayTeamEnvironments(team?.id ?? null);
  const mine = (teamMachines.data ?? []).filter((machine) => machine.isOwner);
  const myMachines = useManagedRelayEnvironments().data;
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    pickedEnvironmentId ?? initialEnvironmentId ?? mine[0]?.environmentId ?? null;
  const sharedMachine = mine.find((machine) => machine.environmentId === environmentId) ?? null;
  const machineLabel =
    sharedMachine?.label ??
    myMachines?.find((machine) => machine.environmentId === environmentId)?.label ??
    "this machine";
  const machineState = useTeamProjectMachineState(environmentId);
  const canWrite = useCanShareTeamProject(environmentId);
  const allProjects = useProjects();
  const projects = useMachineProjects(environmentId);
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const projectId =
    pickedProjectId ?? (environmentId === initialEnvironmentId ? initialProjectId : null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const current =
    project?.teamShare && project.teamShare.organizationId === teamId ? project.teamShare : null;
  const sharedElsewhere =
    project?.teamShare && current === null
      ? (teams.find((candidate) => candidate.id === project.teamShare?.organizationId)?.name ??
        "another team")
      : null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = deriveProviderInstanceEntries(providers).filter(isProviderInstancePickerVisible);
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const modelSelection =
    pickedModel ?? current?.modelSelection ?? defaultModelSelection(project, entries);
  const [pickedMode, setPickedMode] = useState<RuntimeMode | null>(null);
  const runtimeMode =
    pickedMode ??
    (current && TEAM_PROJECT_RUNTIME_MODES.includes(current.runtimeMode)
      ? current.runtimeMode
      : (TEAM_PROJECT_RUNTIME_MODES[0] ?? "full-access"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checking = team !== null && teamMachines.data === null && teamMachines.error === null;
  const noMachine = team !== null && !checking && sharedMachine === null;
  const blocker =
    team === null || checking || noMachine
      ? null
      : machineState === "offline"
        ? `${machineLabel} is offline.`
        : machineState === "outdated"
          ? `Update ${machineLabel} to share projects.`
          : machineState === "connecting"
            ? `Checking ${machineLabel}…`
            : !canWrite
              ? "This connection cannot change sharing on this machine."
              : sharedElsewhere !== null
                ? `${project?.title} is shared with ${sharedElsewhere}. Stop sharing it there first.`
                : entries.length === 0
                  ? `Add a provider on ${machineLabel} first.`
                  : null;
  const unchanged =
    current !== null &&
    modelSelection !== null &&
    current.runtimeMode === runtimeMode &&
    current.modelSelection.instanceId === modelSelection.instanceId &&
    current.modelSelection.model === modelSelection.model;
  const canSubmit =
    team !== null &&
    sharedMachine !== null &&
    blocker === null &&
    project !== null &&
    modelSelection !== null &&
    !pending &&
    !unchanged;

  const addProject = () => {
    if (team === null || environmentId === null) return;
    awaitNewTeamProject({
      teamId: team.id,
      environmentId,
      knownProjectIds: allProjects
        .filter((candidate) => candidate.environmentId === environmentId)
        .map((candidate) => candidate.id),
    });
    openCommandPalette({ open: "add-project" });
  };

  const share = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    const result = await shareTeamProject({
      environmentId: sharedMachine.environmentId,
      projectId: project.id,
      organizationId: team.id,
      modelSelection,
      runtimeMode,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    setPending(false);
    if (result !== null) {
      setError(teamProjectMessage(result, "Could not share the project. Try again."));
      return;
    }
    toastManager.add({
      type: "success",
      title: current ? "Saved" : `Shared ${project.title} with ${team.name}`,
    });
    closeTeamDialog();
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{current ? "Team sharing" : "Start a team project"}</DialogTitle>
          <DialogDescription>
            {team && project
              ? `Everyone in ${team.name} can see new threads here and start their own. They run on ${machineLabel} with this model and access.`
              : "Everyone in the team can see new threads in the project and start their own."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">Create a team first.</p>
          ) : (
            <form
              id="team-project-form"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void share();
              }}
            >
              {teams.length > 1 && current === null && initialTeamId === null ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="team-project-team">Team</Label>
                  <Select
                    value={teamId}
                    onValueChange={(next: string | null) => {
                      if (next === null) return;
                      setPickedTeamId(next);
                      setError(null);
                    }}
                  >
                    <SelectTrigger id="team-project-team">
                      <SelectValue>
                        {(value: string) =>
                          teams.find((candidate) => candidate.id === value)?.name ?? "Pick a team"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {teams.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              {checking ? <p className="text-sm text-muted-foreground">Checking…</p> : null}
              {noMachine && team ? (
                <NoSharedMachine
                  team={team}
                  fixed={initialEnvironmentId !== null}
                  machineLabel={machineLabel}
                  onOpen={() => {
                    closeTeamDialog();
                    void navigate({ to: "/settings/team", hash: "team-machines" });
                  }}
                />
              ) : null}
              {sharedMachine && mine.length > 1 && initialEnvironmentId === null ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="team-project-machine">Machine</Label>
                  <Select
                    value={environmentId}
                    onValueChange={(next: EnvironmentId | null) => {
                      if (next === null) return;
                      setPickedEnvironmentId(next);
                      setPickedProjectId(null);
                      setPickedModel(null);
                      setError(null);
                    }}
                  >
                    <SelectTrigger id="team-project-machine">
                      <SelectValue>
                        {(value: EnvironmentId) =>
                          mine.find((machine) => machine.environmentId === value)?.label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {mine.map((machine) => (
                        <SelectItem key={machine.environmentId} value={machine.environmentId}>
                          {machine.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              {sharedMachine ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="team-project-project">Project</Label>
                  {projectFixed && project ? (
                    <p className="text-sm">{project.title}</p>
                  ) : (
                    <Select
                      value={project?.id ?? null}
                      onValueChange={(next: string | null) => {
                        if (next === null) return;
                        if (next === ADD_PROJECT_VALUE) {
                          addProject();
                          return;
                        }
                        setPickedProjectId(next as ProjectId);
                        setPickedModel(null);
                        setError(null);
                      }}
                    >
                      <SelectTrigger id="team-project-project">
                        <SelectValue>
                          {(value: ProjectId | null) =>
                            projects.find((candidate) => candidate.id === value)?.title ??
                            "Pick a project"
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {projects.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.title}
                          </SelectItem>
                        ))}
                        <SelectItem value={ADD_PROJECT_VALUE}>Add a project…</SelectItem>
                      </SelectPopup>
                    </Select>
                  )}
                </div>
              ) : null}
              {sharedMachine && project && modelSelection !== null ? (
                <div className="grid gap-1.5">
                  <Label>Model</Label>
                  <ProviderModelPicker
                    environmentId={sharedMachine.environmentId}
                    activeInstanceId={modelSelection.instanceId}
                    model={modelSelection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={
                      new Map(entries.map((entry) => [entry.instanceId, entry.models]))
                    }
                    disabled={pending}
                    popupAlign="start"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Model for teammates' threads"
                    onInstanceModelChange={(instanceId, model) =>
                      setPickedModel(createModelSelection(instanceId, model))
                    }
                  />
                </div>
              ) : null}
              {sharedMachine && project ? (
                <div className="grid gap-1.5">
                  <Label>Access</Label>
                  {TEAM_PROJECT_RUNTIME_MODES.length > 1 ? (
                    <RadioGroup
                      aria-label="Access"
                      value={runtimeMode}
                      disabled={pending}
                      onValueChange={(next) => setPickedMode(next as RuntimeMode)}
                    >
                      {TEAM_PROJECT_RUNTIME_MODES.map((mode) => (
                        <label key={mode} className="flex cursor-pointer items-start gap-3">
                          <Radio value={mode} />
                          <span className="grid gap-0.5">
                            <span className="text-sm font-medium">
                              {runtimeModeConfig[mode].label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {teamProjectAccessDetail(mode, machineLabel)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  ) : (
                    <p className="grid gap-0.5">
                      <span className="text-sm">{runtimeModeConfig[runtimeMode].label}</span>
                      <span className="text-xs text-muted-foreground">
                        {teamProjectAccessDetail(runtimeMode, machineLabel)}
                      </span>
                    </p>
                  )}
                </div>
              ) : null}
              {blocker ? <p className="text-xs text-muted-foreground">{blocker}</p> : null}
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </form>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={closeTeamDialog}>
            Cancel
          </Button>
          {current !== null && project !== null && environmentId !== null ? (
            <Button
              variant="destructive-outline"
              disabled={pending || !canWrite}
              onClick={() => openStopTeamProjectDialog(environmentId, project.id)}
            >
              Stop sharing
            </Button>
          ) : null}
          {teams.length > 0 ? (
            <Button type="submit" form="team-project-form" disabled={!canSubmit}>
              {pending ? "Sharing…" : current ? "Save" : `Share with ${team?.name ?? "team"}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function NoSharedMachine({
  team,
  fixed,
  machineLabel,
  onOpen,
}: {
  readonly team: CloudTeamSummary;
  readonly fixed: boolean;
  readonly machineLabel: string;
  readonly onOpen: () => void;
}) {
  return (
    <div className="grid justify-items-start gap-2">
      <p className="text-sm text-muted-foreground">
        {fixed
          ? `${machineLabel} is not shared with ${team.name} yet. Share it first.`
          : `None of your machines is shared with ${team.name} yet. Share one first.`}
      </p>
      <Button size="xs" variant="outline" onClick={onOpen}>
        Shared machines
      </Button>
    </div>
  );
}

function TeamProjectThreadDialog({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigate = useNavigate();
  const project = useTeamProject(environmentId, projectId);
  const machine = useTeamMachine(environmentId);
  const machineState = useTeamProjectMachineState(environmentId);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = project?.teamShare ?? null;
  const trimmed = text.trim();
  const problem = trimmed === "" ? null : teamThreadTextProblem(trimmed);
  const offline = machineState === "offline";
  const canSend = share !== null && trimmed !== "" && problem === null && !pending && !offline;
  const hostLine = machine
    ? machine.isOwner
      ? "Runs on your machine"
      : `Runs on ${machine.owner.name}'s machine`
    : "Runs on the host's machine";

  const send = async () => {
    if (!canSend) return;
    setPending(true);
    setError(null);
    const result = await startTeamProjectThread({ environmentId, projectId, text: trimmed }).then(
      (threadId) => ({ ok: true as const, threadId }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    setPending(false);
    if (!result.ok) {
      setError(teamProjectMessage(result.cause, "Could not start the thread. Try again."));
      return;
    }
    closeTeamDialog();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.threadId },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New thread in {project?.title ?? "this project"}</DialogTitle>
          <DialogDescription>
            {share === null
              ? "This project is no longer shared with the team."
              : offline
                ? `${machine?.label ?? "The host machine"} is offline.`
                : `${hostLine} · ${formatModelSlugName(share.modelSelection.model)}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="team-project-thread-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="team-project-thread-text">Message</Label>
              <Textarea
                id="team-project-thread-text"
                autoFocus
                value={text}
                readOnly={pending}
                placeholder="What should the agent do?"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) {
                    return;
                  }
                  event.preventDefault();
                  void send();
                }}
              />
            </div>
            {(problem ?? error) ? (
              <p role="alert" className="text-xs text-destructive">
                {problem ?? error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeTeamDialog} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="team-project-thread-form" disabled={!canSend}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function StopTeamProjectDialog({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const project = useTeamProject(environmentId, projectId);
  const teamsState = useCloudTeamsState();
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const teamName =
    teams.find((candidate) => candidate.id === project?.teamShare?.organizationId)?.name ??
    "The team";
  const [pending, setPending] = useState(false);

  const stop = async () => {
    setPending(true);
    const result = await stopSharingTeamProject({ environmentId, projectId }).then(
      () => null,
      (cause: unknown) => cause,
    );
    setPending(false);
    if (result !== null) {
      toastManager.add({
        type: "error",
        title: "Could not stop sharing",
        description: teamProjectMessage(result, "Try again."),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `Stopped sharing ${project?.title ?? "the project"}`,
    });
    closeTeamDialog();
  };

  return (
    <AlertDialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop sharing {project?.title ?? "this project"}?</AlertDialogTitle>
          <AlertDialogDescription>
            {teamName} loses this project and the threads in it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void stop()}>
            {pending ? "Stopping…" : "Stop sharing"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
