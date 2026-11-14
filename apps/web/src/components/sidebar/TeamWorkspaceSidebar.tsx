import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import { Link, useNavigate } from "@tanstack/react-router";
import { EyeIcon, MonitorIcon, SquarePenIcon } from "lucide-react";

import { refreshTeamMachines, useTeamMachines } from "~/cloud/teamWorkspace";
import { isElectron } from "~/env";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { PresenceAvatars, usePresencePeople, useSelfUserId } from "../teams/teamPresence";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";

interface TeamThreadGroup {
  readonly projectId: string;
  readonly title: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

function groupSharedThreads(input: {
  readonly scope: TeamWorkspace.WorkspaceScope;
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): ReadonlyArray<TeamThreadGroup> {
  const groups = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId || thread.archivedAt !== null) continue;
    if (
      !TeamWorkspace.workspaceListsThread(input.scope, {
        environmentId: thread.environmentId,
        teamShare: thread.source.teamShare,
      })
    ) {
      continue;
    }
    const list = groups.get(thread.projectId) ?? [];
    list.push(thread);
    groups.set(thread.projectId, list);
  }
  return [...groups.entries()]
    .map(([projectId, threads]) => ({
      projectId,
      title:
        input.projects.find(
          (project) => project.environmentId === input.environmentId && project.id === projectId,
        )?.title ?? "Project",
      threads: threads.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

function machineStatus(
  machine: RelayTeamEnvironmentRecord,
  phase: string | null,
  error: string | null,
): string | null {
  switch (phase) {
    case null:
    case "available":
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "unsupported":
      return machine.isOwner ? "Update this machine to share with a team" : "Needs an update";
    case "error":
      return machine.isOwner ? (error ?? "Can't connect") : "Not available right now";
    default:
      return null;
  }
}

export function TeamWorkspaceSidebar({ team }: { readonly team: CloudTeamSummary }) {
  const state = useTeamMachines();
  const machines = state.status === "personal" ? [] : state.machines;
  const threads = useQuietThreadShells();
  const projects = useProjects();
  const scope: TeamWorkspace.WorkspaceScope = {
    kind: "team",
    teamId: team.id,
    environmentIds: new Set(machines.map((machine) => machine.environmentId)),
  };
  const groupsByMachine = new Map(
    machines.map((machine) => [
      machine.environmentId,
      groupSharedThreads({ scope, environmentId: machine.environmentId, threads, projects }),
    ]),
  );
  const sharedThreadCount = [...groupsByMachine.values()].reduce(
    (count, groups) => count + groups.reduce((sum, group) => sum + group.threads.length, 0),
    0,
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="min-h-full">
        <SidebarGroup>
          <div className="flex flex-col gap-3">
            {state.status !== "personal" && machines.length === 0 ? (
              <TeamMachinesEmpty status={state.status} teamId={team.id} teamName={team.name} />
            ) : (
              machines.map((machine) => (
                <TeamMachineSection
                  key={machine.environmentId}
                  machine={machine}
                  groups={groupsByMachine.get(machine.environmentId) ?? []}
                />
              ))
            )}
            {machines.length > 0 && sharedThreadCount === 0 ? (
              <p className="px-2.5 text-muted-foreground text-xs">
                Nothing shared yet. Open a thread and choose Share with team.
              </p>
            ) : null}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function TeamMachinesEmpty({
  status,
  teamId,
  teamName,
}: {
  readonly status: "loading" | "ready" | "failed";
  readonly teamId: string;
  readonly teamName: string;
}) {
  const navigate = useNavigate();
  if (status === "loading") {
    return <p className="px-2.5 py-2 text-muted-foreground text-xs">Loading team machines…</p>;
  }
  if (status === "failed") {
    return (
      <div className="flex flex-col items-start gap-2 px-2.5 py-2 text-muted-foreground text-xs">
        <span>Could not load the team&apos;s machines.</span>
        <Button size="xs" variant="outline" onClick={() => refreshTeamMachines(teamId)}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-muted-foreground text-xs">
      <MonitorIcon aria-hidden className="size-5" />
      <span>No machine is shared with {teamName} yet.</span>
      <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/settings/team" })}>
        Share a machine with the team
      </Button>
    </div>
  );
}

function TeamMachineSection({
  machine,
  groups,
}: {
  readonly machine: RelayTeamEnvironmentRecord;
  readonly groups: ReadonlyArray<TeamThreadGroup>;
}) {
  const environment = useEnvironment(machine.environmentId);
  const selfUserId = useSelfUserId();
  const status = machineStatus(
    machine,
    environment?.connection.phase ?? null,
    environment?.connection.error ?? null,
  );
  const connected = usePresencePeople(machine.environmentId, {
    threadId: null,
    selfUserId,
    selfIsOwner: machine.isOwner,
    owner: machine.owner,
  });
  return (
    <section aria-label={machine.label} className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        <Avatar
          name={machine.owner.name}
          src={machine.owner.image}
          seed={machine.owner.userId}
          size="sm"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sidebar-foreground text-sm">
            {machine.label}
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {machine.isOwner ? "Your machine" : machine.owner.name}
            {status ? ` · ${status}` : ""}
          </span>
        </div>
        <PresenceAvatars people={connected} />
      </div>
      {groups.length > 0 ? (
        <SidebarMenuSub>
          {groups.map((group) => (
            <TeamProjectGroup
              key={group.projectId}
              group={group}
              machine={machine}
              selfUserId={selfUserId}
            />
          ))}
        </SidebarMenuSub>
      ) : null}
    </section>
  );
}

function TeamProjectGroup({
  group,
  machine,
  selfUserId,
}: {
  readonly group: TeamThreadGroup;
  readonly machine: RelayTeamEnvironmentRecord;
  readonly selfUserId: string | null;
}) {
  return (
    <>
      <li className="truncate px-2 pt-1 text-muted-foreground text-xs">{group.title}</li>
      {group.threads.map((thread) => (
        <TeamThreadRow
          key={thread.id}
          environmentId={thread.environmentId}
          threadId={thread.id}
          title={thread.title}
          access={thread.source.teamShare?.access ?? "view"}
          machine={machine}
          selfUserId={selfUserId}
        />
      ))}
    </>
  );
}

function TeamThreadRow({
  environmentId,
  threadId,
  title,
  access,
  machine,
  selfUserId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly access: "view" | "steer";
  readonly machine: RelayTeamEnvironmentRecord;
  readonly selfUserId: string | null;
}) {
  const route = useThreadRouteTarget();
  const isActive =
    route?.kind === "server" &&
    route.threadRef.environmentId === environmentId &&
    route.threadRef.threadId === threadId;
  const viewers = usePresencePeople(environmentId, {
    threadId,
    selfUserId,
    selfIsOwner: machine.isOwner,
    owner: machine.owner,
  });
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={isActive}
        render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
      >
        {access === "view" ? (
          <EyeIcon aria-label="View only" className="size-3.5 shrink-0" />
        ) : (
          <SquarePenIcon aria-label="Steer" className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <PresenceAvatars people={viewers} />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
