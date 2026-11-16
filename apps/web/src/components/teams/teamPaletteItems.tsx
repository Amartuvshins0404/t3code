import { canManageTeam } from "@t3tools/client-runtime/cloud-auth";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  BotIcon,
  FolderPlusIcon,
  MessageCircleIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  UserPlusIcon,
} from "lucide-react";

import { getCloudAuth, useCloudAuth } from "../../cloud/cloudAuth";
import {
  PERSONAL_WORKSPACE,
  setActiveWorkspace,
  useActiveWorkspace,
  useCloudTeamsState,
} from "../../cloud/cloudTeams";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { AppLogo } from "../AppLogo";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { TEAM_CONNECTIVITY_SECTION_ID } from "./teamConnectivity";
import { TeamMark, TEAM_ROLE_LABELS } from "./teamPresentation";
import { TEAM_AGENT_SECTION_ID, useTeamAgentStatuses, useTeamPeople } from "./teamAgents";
import {
  openAskAgentDialog,
  openCreateTeamDialog,
  openInviteTeamDialog,
  openTeamProjectDialog,
  openTeamProjectThreadDialog,
} from "./teamUiStore";

export function useTeamPaletteItems(): ReadonlyArray<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const navigate = useNavigate();
  const auth = useCloudAuth();
  const teamsState = useCloudTeamsState();
  const workspace = useActiveWorkspace();
  const teamPeople = useTeamPeople();
  const people = teamPeople.status === "personal" ? [] : teamPeople.people;
  const agentStatuses = useTeamAgentStatuses(
    teamPeople.status === "personal" ? "" : teamPeople.teamId,
    people.map((entry) => entry.person.userId),
    teamPeople.status === "personal" ? [] : teamPeople.machines,
  );
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  if (getCloudAuth() === null || !auth.isSignedIn) return [];
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const activeTeam = workspace.kind === "team" ? workspace.team : null;
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "submenu",
      value: "action:switch-workspace",
      searchTerms: ["switch", "workspace", "team", "personal", "organization"],
      title: "Switch workspace…",
      icon: <ArrowLeftRightIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <ArrowLeftRightIcon className={ADDON_ICON_CLASS} />,
      shortcutCommand: "workspaceSwitcher.open",
      groups: [
        {
          value: "workspaces",
          label: "Workspaces",
          items: [
            {
              kind: "action",
              value: "workspace:personal",
              searchTerms: ["personal"],
              title: "Personal",
              ...(workspace.kind === "personal" ? { description: "Current" } : {}),
              icon: <AppLogo />,
              run: async () => setActiveWorkspace(PERSONAL_WORKSPACE),
            },
            ...teams.map((team): CommandPaletteActionItem => ({
              kind: "action",
              value: `workspace:${team.id}`,
              searchTerms: [team.name, team.slug],
              title: team.name,
              description:
                activeTeam?.id === team.id
                  ? `${TEAM_ROLE_LABELS[team.role]} · Current`
                  : TEAM_ROLE_LABELS[team.role],
              icon: <TeamMark team={team} />,
              run: async () => setActiveWorkspace(team.id),
            })),
          ],
        },
      ],
    },
    {
      kind: "action",
      value: "action:create-team",
      searchTerms: ["create", "new", "team", "workspace", "organization"],
      title: "Create team",
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openCreateTeamDialog(),
    },
  ];
  if (activeTeam && canManageTeam(activeTeam.role)) {
    items.push({
      kind: "action",
      value: "action:invite-people",
      searchTerms: ["invite", "people", "team", "member", "add"],
      title: `Invite people to ${activeTeam.name}`,
      icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openInviteTeamDialog(activeTeam.id),
    });
  }
  if (activeTeam) {
    for (const { person, self } of people) {
      if (agentStatuses.get(person.userId)?.kind !== "ready") continue;
      items.push({
        kind: "action",
        value: `action:ask-agent:${person.userId}`,
        searchTerms: ["ask", "agent", "teammate", "question", person.name],
        title: self ? "Ask your agent" : `Ask ${person.name}'s agent`,
        description: activeTeam.name,
        icon: <MessageCircleIcon className={ITEM_ICON_CLASS} />,
        run: async () => openAskAgentDialog(activeTeam.id, person),
      });
    }
    const machines = teamPeople.status === "personal" ? [] : teamPeople.machines;
    const panel = TeamWorkspace.teamPanel({
      teamId: activeTeam.id,
      machines: machines.map((machine) => ({
        environmentId: machine.environmentId,
        ownerUserId: machine.owner.userId,
      })),
      projects,
      threads: [],
    });
    for (const { project } of panel.projects) {
      const machine = machines.find(
        (candidate) => candidate.environmentId === project.environmentId,
      );
      if (!machine) continue;
      items.push({
        kind: "action",
        value: `action:team-project-thread:${project.environmentId}:${project.id}`,
        searchTerms: ["new thread", "team project", "shared project", project.title],
        title: `New thread in ${project.title}`,
        description: machine.isOwner
          ? activeTeam.name
          : `${machine.owner.name} · ${activeTeam.name}`,
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          if (machine.isOwner) {
            await handleNewThread(scopeProjectRef(project.environmentId, project.id));
            return;
          }
          openTeamProjectThreadDialog(project.environmentId, project.id);
        },
      });
    }
  }
  if (teams.length > 0) {
    items.push({
      kind: "action",
      value: "action:start-team-project",
      searchTerms: ["start", "team project", "shared project", "share project", "team"],
      title: "Start a team project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openTeamProjectDialog({ teamId: activeTeam?.id ?? null }),
    });
    items.push({
      kind: "action",
      value: "action:team-agent",
      searchTerms: ["my agent", "agent", "ask", "teammate", "team", "read only"],
      title: "My agent",
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/team", hash: TEAM_AGENT_SECTION_ID });
      },
    });
    items.push({
      kind: "action",
      value: "action:team-settings",
      searchTerms: ["team", "settings", "members", "roles", "invites", "leave"],
      title: "Team settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/team" });
      },
    });
    items.push({
      kind: "action",
      value: "action:team-connectivity",
      searchTerms: ["team", "connectivity", "connection", "proxy", "cli proxy", "team key"],
      title: "Team connection",
      icon: <PlugIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/team", hash: TEAM_CONNECTIVITY_SECTION_ID });
      },
    });
  }
  return items;
}
