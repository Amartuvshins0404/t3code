import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import { formatModelSlugName } from "@t3tools/shared/model";

import { useManagedRelayTeamEnvironments } from "~/cloud/managedRelayState";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import {
  TEAM_PROJECTS_SECTION_ID,
  useCanShareTeamProject,
  useMachineProjects,
  useTeamProjectMachineState,
} from "../teams/teamProjects";
import { openStopTeamProjectDialog, openTeamProjectDialog } from "../teams/teamUiStore";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function TeamProjectsSection({ team }: { readonly team: CloudTeamSummary }) {
  const teamMachines = useManagedRelayTeamEnvironments(team.id);
  const mine = (teamMachines.data ?? []).filter((machine) => machine.isOwner);
  return (
    <SettingsSection
      id={TEAM_PROJECTS_SECTION_ID}
      title="Team projects"
      headerAction={
        mine.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => openTeamProjectDialog({ teamId: team.id })}
          >
            Start a team project
          </Button>
        ) : null
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Everyone in {team.name} sees new threads in these projects and can start their own. They run
        on your machine with the model and access you pick.
      </p>
      {teamMachines.data !== null && mine.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Share a machine with {team.name} to start a team project.
        </p>
      ) : null}
      {mine.map((machine) => (
        <MachineTeamProjects key={machine.environmentId} machine={machine} team={team} />
      ))}
    </SettingsSection>
  );
}

function MachineTeamProjects({
  machine,
  team,
}: {
  readonly machine: RelayTeamEnvironmentRecord;
  readonly team: CloudTeamSummary;
}) {
  const state = useTeamProjectMachineState(machine.environmentId);
  const canWrite = useCanShareTeamProject(machine.environmentId);
  const shared = useMachineProjects(machine.environmentId).filter((project) =>
    TeamWorkspace.isTeamProject(project, team.id),
  );
  if (state === "outdated") {
    return (
      <SettingsRow
        title={machine.label}
        description={`Update ${machine.label} to share projects.`}
      />
    );
  }
  if (shared.length === 0) {
    return (
      <SettingsRow
        title={machine.label}
        description={state === "offline" ? `${machine.label} is offline.` : "No shared projects."}
      />
    );
  }
  return shared.map((project) => {
    const share = project.teamShare;
    if (!share) return null;
    return (
      <SettingsRow
        key={project.id}
        title={project.title}
        description={`${machine.label} · ${formatModelSlugName(share.modelSelection.model)} · ${runtimeModeConfig[share.runtimeMode].label}`}
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || state !== "online"}
              onClick={() =>
                openTeamProjectDialog({
                  teamId: team.id,
                  environmentId: machine.environmentId,
                  projectId: project.id,
                })
              }
            >
              Change
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canWrite || state !== "online"}
              onClick={() => openStopTeamProjectDialog(machine.environmentId, project.id)}
            >
              Stop sharing
            </Button>
          </>
        }
      />
    );
  });
}
