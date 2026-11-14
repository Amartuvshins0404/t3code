import { canManageTeam } from "@t3tools/client-runtime/cloud-auth";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, PlusIcon, SettingsIcon, UserPlusIcon } from "lucide-react";

import { getCloudAuth, useCloudAuth } from "../../cloud/cloudAuth";
import {
  PERSONAL_WORKSPACE,
  setActiveWorkspace,
  useActiveWorkspace,
  useCloudTeamsState,
} from "../../cloud/cloudTeams";
import { AppLogo } from "../AppLogo";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { TeamMark, TEAM_ROLE_LABELS } from "./teamPresentation";
import { openCreateTeamDialog, openInviteTeamDialog } from "./teamUiStore";

export function useTeamPaletteItems(): ReadonlyArray<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const navigate = useNavigate();
  const auth = useCloudAuth();
  const teamsState = useCloudTeamsState();
  const workspace = useActiveWorkspace();
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
  if (teams.length > 0) {
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
  }
  return items;
}
