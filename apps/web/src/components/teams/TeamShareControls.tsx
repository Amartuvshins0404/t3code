import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, TeamThreadAccess } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import { useActiveWorkspace, useCloudTeamsState } from "~/cloud/cloudTeams";
import {
  useManagedRelayEnvironments,
  useManagedRelayTeamEnvironments,
} from "~/cloud/managedRelayState";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  MyMachineRow,
  machineShareHint,
  useMachineShareState,
} from "../settings/TeamSharedMachines";
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
import { toastManager } from "../ui/toast";
import { machineShareFailureMessage, shareMachineWithTeam } from "./machineSharing";
import { TeamMark, teamAccessMessage } from "./teamPresentation";
import { useCanShareWithTeam, useThreadTeamShare } from "./teamShareAvailability";
import {
  closeTeamDialog,
  openCreateTeamDialog,
  openTeamShareThreadDialog,
  useTeamUiStore,
} from "./teamUiStore";

const TEAM_ACCESS_LABELS: Readonly<Record<TeamThreadAccess, string>> = {
  view: "View",
  steer: "Steer",
};

const ACCESS_OPTIONS: ReadonlyArray<{ readonly value: TeamThreadAccess; readonly detail: string }> =
  [
    { value: "view", detail: "Teammates read along as the agent works." },
    { value: "steer", detail: "Teammates can also send messages and stop the agent." },
  ];

export function TeamShareIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadTeamShare(threadRef);
  const canShare = useCanShareWithTeam(threadRef.environmentId);
  const teamsState = useCloudTeamsState();
  if (share === null || !canShare) return null;
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const team = teams.find((candidate) => candidate.id === share.organizationId) ?? null;
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      aria-label={`Shared with ${team?.name ?? "a team"}, ${TEAM_ACCESS_LABELS[share.access]}. Change sharing`}
      onClick={() => openTeamShareThreadDialog(threadRef)}
    >
      {team ? <TeamMark team={team} /> : <UsersIcon aria-hidden />}
      {TEAM_ACCESS_LABELS[share.access]}
    </Button>
  );
}

function relayMachine(
  machines: ReadonlyArray<RelayClientEnvironmentRecord> | null,
  environmentId: EnvironmentId,
): RelayClientEnvironmentRecord | null | undefined {
  if (machines === null) return undefined;
  return machines.find((machine) => machine.environmentId === environmentId) ?? null;
}

function TeamShareThreadDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const current = useThreadTeamShare(threadRef);
  const teamsState = useCloudTeamsState();
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const workspace = useActiveWorkspace();
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);
  const [pickedAccess, setPickedAccess] = useState<TeamThreadAccess | null>(null);
  const [pending, setPending] = useState<"share" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const teamId =
    pickedTeamId ??
    current?.organizationId ??
    (workspace.kind === "team" ? workspace.team.id : (teams[0]?.id ?? null));
  const team = teams.find((candidate) => candidate.id === teamId) ?? null;
  const access =
    pickedAccess ?? (current && current.organizationId === teamId ? current.access : "view");
  const machine = relayMachine(useManagedRelayEnvironments().data, threadRef.environmentId);
  const teamMachines = useManagedRelayTeamEnvironments(team?.id ?? null);
  const relayShared =
    teamMachines.data?.some(
      (candidate) => candidate.isOwner && candidate.environmentId === threadRef.environmentId,
    ) ?? false;
  const machineState = useMachineShareState(threadRef.environmentId, team?.id ?? "", relayShared);
  const setThreadTeamShare = useAtomCommand(serverEnvironment.setThreadTeamShare, {
    reportFailure: false,
  });
  const clearThreadTeamShare = useAtomCommand(serverEnvironment.clearThreadTeamShare, {
    reportFailure: false,
  });

  const blocker =
    team === null
      ? null
      : machine === null
        ? "Turn on T3 Connect for this machine in Settings → Connections to share it with a team."
        : machineState.kind === "outdated" || machineState.kind === "offline"
          ? machineShareHint(machineState, team.name)
          : null;
  const checking =
    machine === undefined ||
    machineState.kind === "checking" ||
    (teamMachines.data === null && teamMachines.error === null);
  const needsMachineShare = machineState.kind === "ready" && !machineState.shared;
  const unchanged = current?.organizationId === teamId && current.access === access;
  const canSubmit =
    team !== null && blocker === null && !checking && pending === null && !unchanged;

  const share = async () => {
    if (team === null || !machine) return;
    setPending("share");
    setError(null);
    if (needsMachineShare) {
      const machineResult = await shareMachineWithTeam({
        environmentId: threadRef.environmentId,
        organizationId: team.id,
      }).then(
        (result) => result,
        (cause: unknown) => {
          setError(teamAccessMessage(cause, "Could not share the machine."));
          return null;
        },
      );
      if (machineResult === null) {
        setPending(null);
        return;
      }
      if (!machineResult.ok) {
        setPending(null);
        setError(machineShareFailureMessage(machineResult, true));
        return;
      }
    }
    const result = await setThreadTeamShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, organizationId: team.id, access },
    });
    setPending(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Shared with ${team.name}`,
        description: `${TEAM_ACCESS_LABELS[access]} access.`,
      });
      closeTeamDialog();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setError(teamAccessMessage(squashAtomCommandFailure(result), "Could not share the thread."));
  };

  const stop = async () => {
    setPending("stop");
    setError(null);
    const result = await clearThreadTeamShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setPending(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Stopped sharing the thread" });
      closeTeamDialog();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setError(teamAccessMessage(squashAtomCommandFailure(result), "Could not stop sharing."));
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share with team</DialogTitle>
          <DialogDescription>
            Teammates see this thread live. They do not see your other threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a team first, then share threads with it.
            </p>
          ) : (
            <div className="grid gap-4">
              {teams.length > 1 ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="team-share-team">Team</Label>
                  <Select
                    value={teamId}
                    onValueChange={(next) => {
                      if (next !== null) setPickedTeamId(next);
                    }}
                  >
                    <SelectTrigger id="team-share-team" aria-label="Team">
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
              ) : team ? (
                <p className="flex items-center gap-2 text-sm">
                  <TeamMark team={team} />
                  {team.name}
                </p>
              ) : null}
              <RadioGroup
                aria-label="Access"
                value={access}
                disabled={pending !== null}
                onValueChange={(next) => setPickedAccess(next === "steer" ? "steer" : "view")}
              >
                {ACCESS_OPTIONS.map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-start gap-3">
                    <Radio value={option.value} />
                    <span className="grid gap-0.5">
                      <span className="text-sm font-medium">
                        {TEAM_ACCESS_LABELS[option.value]}
                      </span>
                      <span className="text-xs text-muted-foreground">{option.detail}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {blocker ? (
                <p className="text-xs text-muted-foreground">{blocker}</p>
              ) : needsMachineShare && team ? (
                <p className="text-xs text-muted-foreground">
                  This machine is not shared with {team.name} yet. Sharing the thread shares the
                  machine too. Teammates still see only the threads you share, one at a time.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {teams.length === 0 ? (
            <>
              <Button variant="outline" size="sm" onClick={closeTeamDialog}>
                Cancel
              </Button>
              <Button size="sm" onClick={openCreateTeamDialog}>
                Create team
              </Button>
            </>
          ) : (
            <>
              {current !== null ? (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void stop()}
                >
                  {pending === "stop" ? "Stopping…" : "Stop sharing"}
                </Button>
              ) : null}
              {blocker && machine === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    closeTeamDialog();
                    void navigate({ to: "/settings/connections" });
                  }}
                >
                  Open Connections
                </Button>
              ) : null}
              <Button size="sm" disabled={!canSubmit} onClick={() => void share()}>
                {pending === "share" ? "Sharing…" : current !== null ? "Save" : "Share"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TeamShareMachineDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const teamsState = useCloudTeamsState();
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const machine = relayMachine(useManagedRelayEnvironments().data, environmentId);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share this machine</DialogTitle>
          <DialogDescription>
            Teammates see only the threads you share, one at a time.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a team first, then share machines with it.
            </p>
          ) : machine === undefined ? (
            <p className="text-sm text-muted-foreground">Checking…</p>
          ) : machine === null ? (
            <p className="text-sm text-muted-foreground">
              Turn on T3 Connect for this machine in Settings → Connections to share it with a team.
            </p>
          ) : (
            <div className="grid">
              {teams.map((team) => (
                <MachineTeamRow key={team.id} machine={machine} team={team} />
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {teams.length === 0 ? (
            <Button size="sm" onClick={openCreateTeamDialog}>
              Create team
            </Button>
          ) : machine === null ? (
            <Button
              size="sm"
              onClick={() => {
                closeTeamDialog();
                void navigate({ to: "/settings/connections" });
              }}
            >
              Open Connections
            </Button>
          ) : (
            <Button size="sm" onClick={closeTeamDialog}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MachineTeamRow({
  machine,
  team,
}: {
  readonly machine: RelayClientEnvironmentRecord;
  readonly team: CloudTeamSummary;
}) {
  const teamMachines = useManagedRelayTeamEnvironments(team.id);
  return (
    <MyMachineRow
      machine={machine}
      team={team}
      title={team.name}
      relayShared={
        teamMachines.data?.some(
          (candidate) => candidate.isOwner && candidate.environmentId === machine.environmentId,
        ) ?? false
      }
    />
  );
}

export function TeamShareDialogHost() {
  const dialog = useTeamUiStore((state) => state.dialog);
  if (dialog?.kind === "share-thread") {
    return (
      <TeamShareThreadDialog
        key={`${dialog.threadRef.environmentId}:${dialog.threadRef.threadId}`}
        threadRef={dialog.threadRef}
      />
    );
  }
  if (dialog?.kind === "share-machine") {
    return <TeamShareMachineDialog environmentId={dialog.environmentId} />;
  }
  return null;
}
