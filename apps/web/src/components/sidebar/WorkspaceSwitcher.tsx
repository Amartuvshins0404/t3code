import { canManageTeam, type CloudTeamInvite } from "@t3tools/client-runtime/cloud-auth";
import {
  ChevronsUpDownIcon,
  HouseIcon,
  LogInIcon,
  PlusIcon,
  SettingsIcon,
  UserPlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCloudAuth, getCloudAuth } from "../../cloud/cloudAuth";
import { openCloudSignInDialog } from "../../cloud/cloudSignInPrompt";
import {
  PERSONAL_WORKSPACE,
  getCloudTeams,
  pendingInvites,
  refreshCloudTeams,
  resolveActiveWorkspace,
  setActiveWorkspace,
  useActiveWorkspace,
  useCloudTeamsState,
} from "../../cloud/cloudTeams";
import { cn } from "../../lib/utils";
import { useAppBaseName } from "../../state/appBranding";
import { useUiStateStore } from "../../uiStateStore";
import { AppLogo } from "../AppLogo";
import { TeamMark, TEAM_ROLE_LABELS, teamErrorMessage } from "../teams/teamPresentation";
import { openCreateTeamDialog, openInviteTeamDialog, useTeamUiStore } from "../teams/teamUiStore";
import { Avatar } from "../ui/avatar";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

export function WorkspaceBrandMark({ withChevron }: { readonly withChevron: boolean }) {
  const appBaseName = useAppBaseName();
  const workspace = useActiveWorkspace();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium tracking-tight">
      {workspace.kind === "team" ? <TeamMark team={workspace.team} /> : <AppLogo />}
      <span className="max-w-40 truncate">
        {workspace.kind === "team" ? workspace.team.name : appBaseName}
      </span>
      {withChevron ? (
        <ChevronsUpDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      ) : null}
    </span>
  );
}

export function WorkspaceSwitcher({
  className,
  fallback,
}: {
  readonly className: string;
  readonly fallback: React.ReactNode;
}) {
  if (getCloudAuth() === null) return fallback;
  return <WorkspaceSwitcherMenu className={className} />;
}

function WorkspaceSwitcherMenu({ className }: { readonly className: string }) {
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const auth = useCloudAuth();
  const teamsState = useCloudTeamsState();
  const saved = useUiStateStore((store) => store.activeWorkspace);
  const { workspace, lostTeamId } = resolveActiveWorkspace(saved, teamsState);
  const invites = pendingInvites(teamsState);
  const [open, setOpen] = useState(false);
  const { isMobile, setOpen: setSidebarOpen, setOpenMobile } = sidebar;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A saved team can vanish on the sign-in service; the persisted choice must move back to Personal once a fresh list proves it.
  useEffect(() => {
    if (lostTeamId === null) return;
    setActiveWorkspace(PERSONAL_WORKSPACE);
    toastManager.add({
      id: `team-lost-${lostTeamId}`,
      type: "info",
      title: "You are no longer in that team",
      description: "Showing Personal.",
    });
  }, [lostTeamId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The open-switcher keybinding fires outside React and must also expand the sidebar store when it is collapsed.
  useEffect(
    () =>
      useTeamUiStore.subscribe((state, previous) => {
        if (state.switcherRequest === previous.switcherRequest) return;
        if (isMobile) setOpenMobile(true);
        else setSidebarOpen(true);
        setOpen(true);
      }),
    [isMobile, setOpenMobile, setSidebarOpen],
  );

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) refreshCloudTeams();
  };

  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const loading =
    teamsState.status === "loading" && !teamsState.fresh && teamsState.teams.length === 0;
  const activeTeam = workspace.kind === "team" ? workspace.team : null;

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Switch workspace, current: ${activeTeam?.name ?? "Personal"}`}
            className={className}
          />
        }
      >
        <WorkspaceBrandMark withChevron />
        {invites.length > 0 ? (
          <span
            aria-hidden="true"
            data-testid="workspace-invite-dot"
            className="absolute top-0.5 left-3 size-1.5 rounded-full bg-info ring-2 ring-sidebar"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        {auth.isSignedIn && auth.user ? (
          <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
            <Avatar
              name={auth.user.name || auth.user.email}
              src={auth.user.image}
              seed={auth.user.id}
              size="md"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{auth.user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {auth.user.email}
              </span>
            </span>
          </div>
        ) : auth.isLoaded ? (
          <MenuItem onClick={openCloudSignInDialog}>
            <LogInIcon />
            Sign in to use teams
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuRadioGroup
          value={activeTeam?.id ?? PERSONAL_WORKSPACE}
          onValueChange={(value: string) => setActiveWorkspace(value)}
        >
          <MenuRadioItem value={PERSONAL_WORKSPACE} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <AppLogo />
              <span className="min-w-0 flex-1 truncate">Personal</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {teams.map((team) => (
            <MenuRadioItem key={team.id} value={team.id} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <TeamMark team={team} />
                <span className="min-w-0 flex-1 truncate">{team.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {TEAM_ROLE_LABELS[team.role]}
                </span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {loading ? (
          <div aria-label="Loading teams" className="flex flex-col gap-2 px-2 py-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        ) : null}
        {teamsState.status === "failed" ? (
          <MenuItem closeOnClick={false} onClick={refreshCloudTeams}>
            Could not load teams. Retry
          </MenuItem>
        ) : null}
        {teamsState.status === "ready" && teams.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Create a team to work with teammates on shared threads.
          </p>
        ) : null}
        {invites.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Invites</MenuGroupLabel>
              {invites.map((invite) => (
                <InviteRow key={invite.id} invite={invite} />
              ))}
            </MenuGroup>
          </>
        ) : null}
        {auth.isSignedIn ? (
          <>
            <MenuSeparator />
            {activeTeam && canManageTeam(activeTeam.role) ? (
              <MenuItem onClick={() => openInviteTeamDialog(activeTeam.id)}>
                <UserPlusIcon />
                Invite people…
              </MenuItem>
            ) : null}
            {activeTeam ? (
              <MenuItem
                onClick={() => {
                  closeMobileSidebar();
                  void navigate({ to: "/settings/team" });
                }}
              >
                <SettingsIcon />
                Team settings
              </MenuItem>
            ) : null}
            <MenuItem onClick={openCreateTeamDialog}>
              <PlusIcon />
              Create team…
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            closeMobileSidebar();
            void navigate({ to: "/" });
          }}
        >
          <HouseIcon />
          Home
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function InviteRow({ invite }: { readonly invite: CloudTeamInvite }) {
  const teamName = invite.teamName ?? "a team";
  const answer = async (accept: boolean) => {
    const teams = getCloudTeams();
    if (!teams) return;
    const result = await (accept ? teams.accept(invite.id) : teams.reject(invite.id)).then(
      () => null,
      (cause: unknown) => cause,
    );
    if (result !== null) {
      toastManager.add({
        type: "error",
        title: accept ? `Could not join ${teamName}` : "Could not ignore the invite",
        description: teamErrorMessage(result, "Try again in a moment."),
      });
      return;
    }
    if (accept) {
      setActiveWorkspace(invite.teamId);
      toastManager.add({ type: "success", title: `Joined ${teamName}` });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-1">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <TeamMark team={{ id: invite.teamId, name: teamName, logo: null }} />
        <span className="min-w-0 flex-1 truncate">{teamName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {TEAM_ROLE_LABELS[invite.role]}
        </span>
      </span>
      <span className="flex gap-1">
        <MenuItem variant="ghost" onClick={() => void answer(true)}>
          Accept
        </MenuItem>
        <MenuItem variant="ghost" onClick={() => void answer(false)}>
          Ignore
        </MenuItem>
      </span>
    </div>
  );
}

export function workspaceTriggerClassName(onBackdrop: boolean): string {
  return cn(
    "relative z-10 ml-[var(--workspace-titlebar-content-left)] flex h-7 w-fit min-w-0 shrink-0 cursor-pointer items-center overflow-hidden rounded-md outline-hidden ring-ring [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-inset",
    onBackdrop ? "text-white" : "text-foreground",
  );
}
