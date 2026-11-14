import { useAtomValue } from "@effect/atom-react";
import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type { EnvironmentId, TeamSharedOrganizations } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayTeamEnvironmentRecord,
} from "@t3tools/contracts/relay";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import {
  useManagedRelayEnvironments,
  useManagedRelayTeamEnvironments,
} from "~/cloud/managedRelayState";
import { readEnvironment, useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import {
  machineShareFailureMessage,
  shareMachineWithTeam,
  stopSharingMachineWithTeam,
} from "../teams/machineSharing";
import { Avatar } from "../ui/avatar";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NOT_LOADED_ATOM = Atom.make(AsyncResult.initial<TeamSharedOrganizations>()).pipe(
  Atom.withLabel("team-shared-organizations:not-loaded"),
);

export type MachineShareState =
  | { readonly kind: "unlinked" }
  | { readonly kind: "offline"; readonly shared: boolean }
  | { readonly kind: "checking"; readonly shared: boolean }
  | { readonly kind: "outdated"; readonly shared: boolean }
  | { readonly kind: "ready"; readonly shared: boolean };

export function useMachineShareState(
  environmentId: EnvironmentId,
  teamId: string,
  relayShared: boolean,
): MachineShareState {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const consent = useAtomValue(
    connected
      ? serverEnvironment.teamSharedOrganizations({ environmentId, input: {} })
      : NOT_LOADED_ATOM,
  );
  if (environment === null) return { kind: "unlinked" };
  if (!connected) return { kind: "offline", shared: relayShared };
  if (consent._tag === "Failure") return { kind: "outdated", shared: relayShared };
  if (consent._tag === "Initial") return { kind: "checking", shared: relayShared };
  return {
    kind: "ready",
    shared: relayShared && consent.value.organizationIds.includes(teamId),
  };
}

export function machineShareHint(state: MachineShareState, teamName: string): string {
  switch (state.kind) {
    case "unlinked":
      return "Connect to this machine in this app to share it.";
    case "offline":
      return state.shared
        ? `Shared with ${teamName}. Offline right now.`
        : "Offline. Share it when it is back.";
    case "outdated":
      return "Update this machine to share with a team.";
    case "checking":
      return "Checking…";
    case "ready":
      return state.shared ? `Shared with ${teamName}.` : "Not shared.";
  }
}

async function setMachineShared(input: {
  readonly environmentId: EnvironmentId;
  readonly team: Pick<CloudTeamSummary, "id" | "name">;
  readonly label: string;
  readonly shared: boolean;
}): Promise<boolean> {
  const target = { environmentId: input.environmentId, organizationId: input.team.id };
  const reachable = readEnvironment(input.environmentId)?.connection.phase === "connected";
  const result = input.shared
    ? await shareMachineWithTeam(target)
    : await stopSharingMachineWithTeam(target);
  if (result.ok) {
    toastManager.add({
      type: "success",
      title: input.shared
        ? `${input.label} is shared with ${input.team.name}`
        : `${input.label} is no longer shared`,
      ...(input.shared || reachable
        ? {}
        : {
            description:
              "This device cannot reach the machine, so teammates already connected keep access for up to 10 minutes.",
          }),
    });
    return true;
  }
  toastManager.add({
    type: "error",
    title: input.shared ? "Could not share the machine" : "Could not stop sharing",
    description: machineShareFailureMessage(result, input.shared),
  });
  return false;
}

export function TeamSharedMachinesSection({ team }: { readonly team: CloudTeamSummary }) {
  const mine = useManagedRelayEnvironments();
  const teamMachines = useManagedRelayTeamEnvironments(team.id);
  const shared = teamMachines.data ?? [];
  const teammates = shared.filter((machine) => !machine.isOwner);
  return (
    <SettingsSection id="team-machines" title="Shared machines">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Teammates see only the threads you share, one at a time.
      </p>
      {(mine.data ?? []).map((machine) => (
        <MyMachineRow
          key={machine.environmentId}
          machine={machine}
          team={team}
          relayShared={shared.some(
            (candidate) => candidate.isOwner && candidate.environmentId === machine.environmentId,
          )}
        />
      ))}
      {mine.data !== null && mine.data.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          None of your machines use T3 Connect yet. Turn it on in Settings → Connections.
        </p>
      ) : null}
      {teamMachines.error ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">{teamMachines.error}</p>
      ) : null}
      {teammates.map((machine) => (
        <TeammateMachineRow key={machine.environmentId} machine={machine} />
      ))}
    </SettingsSection>
  );
}

export function MyMachineRow({
  machine,
  team,
  relayShared,
  title,
}: {
  readonly machine: RelayClientEnvironmentRecord;
  readonly team: CloudTeamSummary;
  readonly relayShared: boolean;
  readonly title?: string;
}) {
  const state = useMachineShareState(machine.environmentId, team.id, relayShared);
  const [busy, setBusy] = useState(false);
  const shared = state.kind === "unlinked" ? relayShared : state.shared;
  const canToggle =
    !busy &&
    (state.kind === "ready" || (shared && (state.kind === "offline" || state.kind === "unlinked")));
  return (
    <SettingsRow
      title={title ?? machine.label}
      description={machineShareHint(state, team.name)}
      control={
        <Switch
          checked={shared}
          disabled={!canToggle}
          aria-label={`Share ${machine.label} with ${team.name}`}
          onCheckedChange={async (checked) => {
            setBusy(true);
            await setMachineShared({
              environmentId: machine.environmentId,
              team,
              label: machine.label,
              shared: Boolean(checked),
            });
            setBusy(false);
          }}
        />
      }
    />
  );
}

function TeammateMachineRow({ machine }: { readonly machine: RelayTeamEnvironmentRecord }) {
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <Avatar
            name={machine.owner.name}
            src={machine.owner.image}
            seed={machine.owner.userId}
            size="sm"
          />
          {machine.label}
        </span>
      }
      description={`Shared by ${machine.owner.name}`}
    />
  );
}
