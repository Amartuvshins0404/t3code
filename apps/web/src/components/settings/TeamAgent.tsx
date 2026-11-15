import { useAtomValue } from "@effect/atom-react";
import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type { ModelSelection, ProjectId, TeamAgentStatus } from "@t3tools/contracts";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import { createModelSelection } from "@t3tools/shared/model";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useManagedRelayTeamEnvironments } from "~/cloud/managedRelayState";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { saveTeamAgent, TEAM_AGENT_SECTION_ID, useMachineAgentState } from "../teams/teamAgents";
import { teamAccessMessage } from "../teams/teamPresentation";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const AGENT_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export function TeamAgentSection({ team }: { readonly team: CloudTeamSummary }) {
  const teamMachines = useManagedRelayTeamEnvironments(team.id);
  const mine = (teamMachines.data ?? []).filter((machine) => machine.isOwner);
  return (
    <SettingsSection id={TEAM_AGENT_SECTION_ID} title="My agent">
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Teammates can ask your agent about these projects. It can read the code and the thread
        history there. It cannot change anything.
      </p>
      {teamMachines.data !== null && mine.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Share a machine with {team.name} to turn on your agent.
        </p>
      ) : null}
      {mine.map((machine) => (
        <MyAgentMachine key={machine.environmentId} machine={machine} team={team} />
      ))}
    </SettingsSection>
  );
}

function MyAgentMachine({
  machine,
  team,
}: {
  readonly machine: RelayTeamEnvironmentRecord;
  readonly team: CloudTeamSummary;
}) {
  const state = useMachineAgentState(machine.environmentId, team.id);
  switch (state.kind) {
    case "answered":
      return <MyAgentControls machine={machine} team={team} agent={state.agent} />;
    case "offline":
      return <SettingsRow title={machine.label} description={`${machine.label} is offline.`} />;
    case "outdated":
      return (
        <SettingsRow
          title={machine.label}
          description={`Update ${machine.label} to use your agent.`}
        />
      );
    case "connecting":
    case "checking":
      return <SettingsRow title={machine.label} description={`Checking ${machine.label}…`} />;
  }
}

interface AgentDraft {
  readonly enabled: boolean;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly modelSelection: ModelSelection | null;
}

function MyAgentControls({
  machine,
  team,
  agent,
}: {
  readonly machine: RelayTeamEnvironmentRecord;
  readonly team: CloudTeamSummary;
  readonly agent: TeamAgentStatus | null;
}) {
  const { environmentId } = machine;
  const canWrite = useAtomValue(serverEnvironment.setTeamAgent.permissionAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = deriveProviderInstanceEntries(providers).filter((entry) =>
    AGENT_DRIVERS.has(entry.driverKind),
  );
  const [saved, setSaved] = useState<{
    readonly basis: TeamAgentStatus | null;
    readonly status: TeamAgentStatus;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = saved !== null && saved.basis === agent ? saved.status : agent;
  const fallbackEntry = entries.find(isProviderInstancePickerReady) ?? entries[0];
  const fallbackModel =
    fallbackEntry?.models.find((model) => model.isDefault)?.slug ?? fallbackEntry?.models[0]?.slug;
  const draft: AgentDraft = {
    enabled: current?.enabled ?? false,
    projectIds: current?.projects.map((project) => project.projectId) ?? [],
    modelSelection:
      current?.modelSelection ??
      (fallbackEntry && fallbackModel
        ? createModelSelection(fallbackEntry.instanceId, fallbackModel)
        : null),
  };
  const canTurnOn = draft.projectIds.length > 0 && draft.modelSelection !== null;

  const save = async (next: AgentDraft) => {
    setBusy(true);
    const result = await saveTeamAgent({ environmentId, organizationId: team.id, ...next }).then(
      (status) => ({ ok: true as const, status }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    setBusy(false);
    if (result.ok) {
      setSaved({ basis: agent, status: result.status });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not change your agent",
      description: teamAccessMessage(result.cause, "Try again."),
    });
  };

  const toggleProject = (projectId: ProjectId, checked: boolean) => {
    const projectIds = checked
      ? [...draft.projectIds, projectId]
      : draft.projectIds.filter((candidate) => candidate !== projectId);
    void save({ ...draft, projectIds });
  };

  const pickedTitles = projects
    .filter((project) => draft.projectIds.includes(project.id))
    .map((project) => project.title);
  const description = draft.enabled
    ? current?.claudeOutdated === true
      ? `On, but Claude Code on ${machine.label} needs 2.1.248 or newer before it can answer.`
      : `On. Answers about ${pickedTitles.join(", ") || "your projects"}.`
    : entries.length === 0
      ? `Add a Claude provider on ${machine.label} to turn it on.`
      : draft.projectIds.length === 0
        ? "Off. Pick at least one project to turn it on."
        : "Off.";
  const disabled = busy || !canWrite;

  return (
    <SettingsRow
      title={machine.label}
      description={description}
      control={
        <>
          <Menu>
            <MenuTrigger
              disabled={disabled || projects.length === 0}
              render={<Button size="xs" variant="outline" />}
            >
              {pickedTitles.length === 0
                ? "Pick projects"
                : pickedTitles.length === 1
                  ? pickedTitles[0]
                  : `${pickedTitles.length} projects`}
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {projects.map((project) => {
                const checked = draft.projectIds.includes(project.id);
                return (
                  <MenuCheckboxItem
                    key={project.id}
                    checked={checked}
                    disabled={checked && draft.enabled && draft.projectIds.length === 1}
                    onCheckedChange={(next) => toggleProject(project.id, Boolean(next))}
                  >
                    {project.title}
                  </MenuCheckboxItem>
                );
              })}
            </MenuPopup>
          </Menu>
          {draft.modelSelection !== null ? (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={draft.modelSelection.instanceId}
              model={draft.modelSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={
                new Map(entries.map((entry) => [entry.instanceId, entry.models]))
              }
              disabled={disabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Agent model"
              onInstanceModelChange={(instanceId, model) =>
                void save({ ...draft, modelSelection: createModelSelection(instanceId, model) })
              }
            />
          ) : null}
          <Switch
            checked={draft.enabled}
            disabled={disabled || (!draft.enabled && !canTurnOn)}
            aria-label={`Let ${team.name} ask your agent on ${machine.label}`}
            onCheckedChange={(checked) => void save({ ...draft, enabled: Boolean(checked) })}
          />
        </>
      }
    />
  );
}
