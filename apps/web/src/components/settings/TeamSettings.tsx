import {
  assignableTeamRoles,
  canEditTeamMember,
  canLeaveTeam,
  canManageTeam,
  type CloudTeamMember,
  type CloudTeamSummary,
} from "@t3tools/client-runtime/cloud-auth";
import type { TeamRole } from "@t3tools/contracts";
import { LogInIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useCloudAuth } from "../../cloud/cloudAuth";
import { openCloudSignInDialog } from "../../cloud/cloudSignInPrompt";
import {
  PERSONAL_WORKSPACE,
  getCloudTeams,
  setActiveWorkspace,
  useActiveWorkspace,
  useTeamDetail,
  useCloudTeamsState,
} from "../../cloud/cloudTeams";
import { useUiStateStore } from "../../uiStateStore";
import { TeamMark, TEAM_ROLE_LABELS, teamErrorMessage } from "../teams/teamPresentation";
import {
  endTeamMemberAccessOnMachines,
  machinesNotToldMessage,
  withdrawTeamFromMachines,
} from "../teams/machineSharing";
import { openCreateTeamDialog, openInviteTeamDialog } from "../teams/teamUiStore";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { TeamSharedMachinesSection } from "./TeamSharedMachines";

export function TeamSettingsPanel() {
  const auth = useCloudAuth();
  const teamsState = useCloudTeamsState();
  const workspace = useActiveWorkspace();
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);
  const teams = teamsState.status === "signedOut" ? [] : teamsState.teams;
  const team =
    teams.find((candidate) => candidate.id === pickedTeamId) ??
    (workspace.kind === "team" ? workspace.team : null) ??
    teams[0] ??
    null;

  if (!auth.isSignedIn) {
    return (
      <SettingsPageContainer>
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>Sign in to use teams</EmptyTitle>
            <EmptyDescription>
              Teams share machines and threads with the people you invite.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openCloudSignInDialog} disabled={!auth.isLoaded}>
              <LogInIcon />
              Sign in
            </Button>
          </EmptyContent>
        </Empty>
      </SettingsPageContainer>
    );
  }

  if (team === null) {
    const loading = teamsState.status === "loading" && !teamsState.fresh;
    return (
      <SettingsPageContainer>
        {loading ? (
          <TeamPageSkeleton />
        ) : (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No team yet</EmptyTitle>
              <EmptyDescription>
                Create a team, then invite people by email. Invites wait in their switcher.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openCreateTeamDialog}>Create team</Button>
            </EmptyContent>
          </Empty>
        )}
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {teams.length > 1 ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
          <span className="shrink-0">Showing</span>
          <Select
            value={team.id}
            onValueChange={(next) => {
              if (next !== null) setPickedTeamId(next);
            }}
          >
            <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="Team">
              <SelectValue>
                {(value: string) => teams.find((candidate) => candidate.id === value)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {teams.map((candidate) => (
                <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <TeamMark team={candidate} />
                    <span className="min-w-0 truncate">{candidate.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      <TeamDetail key={team.id} team={team} myUserId={auth.userId} />
    </SettingsPageContainer>
  );
}

function TeamPageSkeleton() {
  return (
    <div aria-label="Loading team" className="flex flex-col gap-3 px-3 sm:px-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-12 w-full" shape="card" />
      <Skeleton className="h-12 w-full" shape="card" />
    </div>
  );
}

type Confirm =
  | { readonly kind: "remove"; readonly member: CloudTeamMember }
  | { readonly kind: "leave" }
  | { readonly kind: "delete" }
  | null;

function TeamDetail({
  team,
  myUserId,
}: {
  readonly team: CloudTeamSummary;
  readonly myUserId: string | null;
}) {
  const state = useTeamDetail(team.id);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const activeWorkspace = useUiStateStore((store) => store.activeWorkspace);

  const run = async (label: string, action: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    const cause = await action().then(
      () => null,
      (error: unknown) => error,
    );
    setBusy(false);
    setConfirm(null);
    if (cause !== null) {
      toastManager.add({
        type: "error",
        title: label,
        description: teamErrorMessage(cause, "Try again in a moment."),
      });
      return;
    }
    done?.();
  };

  const warnIfNotTold = (pending: Promise<ReadonlyArray<string>>) => {
    void pending.then((labels) => {
      if (labels.length === 0) return;
      toastManager.add({
        type: "warning",
        title: "Some machines were not told",
        description: machinesNotToldMessage(labels),
      });
    });
  };

  const teams = getCloudTeams();
  const myRole = team.role;
  const manage = canManageTeam(myRole);
  const detail = state.status === "ready" ? state.detail : null;
  const leaveAllowed = detail ? canLeaveTeam({ myRole, members: detail.members }) : false;

  const leaveWorkspace = () => {
    if (activeWorkspace === team.id) setActiveWorkspace(PERSONAL_WORKSPACE);
  };

  return (
    <>
      <SettingsSection id="team" title="Team">
        <SettingsRow
          title="Name"
          control={
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <TeamMark team={team} size="md" />
              <span className="min-w-0 truncate font-medium">{team.name}</span>
            </span>
          }
        />
        <SettingsRow
          title="Short name"
          control={<span className="text-sm text-muted-foreground">{team.slug}</span>}
        />
        <SettingsRow
          title="Your role"
          control={
            <span className="text-sm text-muted-foreground">{TEAM_ROLE_LABELS[myRole]}</span>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="team-members"
        title="Members"
        headerAction={
          manage ? (
            <Button size="xs" variant="outline" onClick={() => openInviteTeamDialog(team.id)}>
              Invite people
            </Button>
          ) : null
        }
      >
        {state.status === "loading" ? (
          <div className="px-3 py-3 sm:px-4">
            <Skeleton className="h-8 w-full" />
          </div>
        ) : state.status === "failed" ? (
          <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
            {teamErrorMessage(state.cause, "Could not load the team.")}
          </p>
        ) : (
          state.detail.members.map((member) => {
            const editable = canEditTeamMember({ myRole, myUserId, member });
            return (
              <SettingsRow
                key={member.memberId}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar
                      name={member.name || member.email}
                      src={member.image}
                      seed={member.userId}
                      size="sm"
                    />
                    <span className="min-w-0 truncate">
                      {member.name || member.email}
                      {member.userId === myUserId ? " (you)" : ""}
                    </span>
                  </span>
                }
                description={member.email}
                control={
                  editable && teams ? (
                    <>
                      <Select
                        value={member.role}
                        onValueChange={(next: TeamRole | null) => {
                          if (next === null || next === member.role) return;
                          void run(
                            "Could not change the role",
                            () =>
                              teams.setRole({
                                teamId: team.id,
                                memberId: member.memberId,
                                role: next,
                              }),
                            () =>
                              warnIfNotTold(
                                endTeamMemberAccessOnMachines({
                                  organizationId: team.id,
                                  userId: member.userId,
                                }),
                              ),
                          );
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={`Role for ${member.name || member.email}`}
                          disabled={busy}
                        >
                          <SelectValue>{(value: TeamRole) => TEAM_ROLE_LABELS[value]}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {assignableTeamRoles(myRole).map((role) => (
                            <SelectItem key={role} value={role}>
                              {TEAM_ROLE_LABELS[role]}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${member.name || member.email}`}
                        disabled={busy}
                        onClick={() => setConfirm({ kind: "remove", member })}
                      >
                        <XIcon />
                      </Button>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {TEAM_ROLE_LABELS[member.role]}
                    </span>
                  )
                }
              />
            );
          })
        )}
      </SettingsSection>

      {manage ? (
        <SettingsSection id="team-invites" title="Invites">
          <SettingsRow
            title="Pending invites"
            description="No email is sent. People see their invite in the workspace switcher after they sign in with the invited email address."
          />
          {detail?.invites.map((invite) => (
            <SettingsRow
              key={invite.id}
              title={invite.email}
              description={TEAM_ROLE_LABELS[invite.role]}
              control={
                teams ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run("Could not cancel the invite", () => teams.cancelInvite(invite.id))
                    }
                  >
                    Cancel invite
                  </Button>
                ) : null
              }
            />
          ))}
          {detail && detail.invites.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">No pending invites.</p>
          ) : null}
        </SettingsSection>
      ) : null}

      <TeamSharedMachinesSection team={team} />

      <SettingsSection id="team-leave" title="Leave or delete">
        <SettingsRow
          title="Leave team"
          description={
            detail && !leaveAllowed
              ? "You are the only owner. Make someone else an owner first, or delete the team."
              : "You lose access to the team's shared machines and threads."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!leaveAllowed || busy}
              onClick={() => setConfirm({ kind: "leave" })}
            >
              Leave team
            </Button>
          }
        />
        {myRole === "owner" ? (
          <SettingsRow
            title="Delete team"
            description="Removes the team, its members and its invites for everyone."
            control={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => setConfirm({ kind: "delete" })}
              >
                Delete team
              </Button>
            }
          />
        ) : null}
      </SettingsSection>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "remove"
                ? `Remove ${confirm.member.name || confirm.member.email}?`
                : confirm?.kind === "delete"
                  ? `Delete ${team.name}?`
                  : `Leave ${team.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "remove"
                ? "They lose access on your machines that this device can reach right away, and on the rest within 10 minutes. You can invite them again later."
                : confirm?.kind === "delete"
                  ? "This cannot be undone. Everyone loses access to the team."
                  : "You need a new invite to come back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || !teams}
              onClick={() => {
                if (!teams || confirm === null) return;
                if (confirm.kind === "remove") {
                  const { member } = confirm;
                  void run(
                    "Could not remove the member",
                    () => teams.remove({ teamId: team.id, memberId: member.memberId }),
                    () =>
                      warnIfNotTold(
                        endTeamMemberAccessOnMachines({
                          organizationId: team.id,
                          userId: member.userId,
                        }),
                      ),
                  );
                } else if (confirm.kind === "leave") {
                  void run(
                    "Could not leave the team",
                    () => teams.leave(team.id),
                    () => {
                      leaveWorkspace();
                      toastManager.add({ type: "success", title: `Left ${team.name}` });
                    },
                  );
                } else {
                  void run(
                    "Could not delete the team",
                    () => teams.delete(team.id),
                    () => {
                      leaveWorkspace();
                      warnIfNotTold(withdrawTeamFromMachines(team.id));
                      toastManager.add({ type: "success", title: `Deleted ${team.name}` });
                    },
                  );
                }
              }}
            >
              {confirm?.kind === "remove"
                ? "Remove"
                : confirm?.kind === "delete"
                  ? "Delete team"
                  : "Leave team"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
