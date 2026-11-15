import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import type { TeamPerson } from "@t3tools/contracts";
import type { RelayTeamEnvironmentRecord } from "@t3tools/contracts/relay";
import { Link, useNavigate } from "@tanstack/react-router";
import { EyeIcon, MessageCircleIcon, SquarePenIcon, UsersIcon } from "lucide-react";

import { refreshTeamMachines } from "~/cloud/teamWorkspace";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import {
  TEAM_AGENT_SECTION_ID,
  type TeamPersonEntry,
  useTeamAgentStatuses,
  useTeamPeople,
} from "../teams/teamAgents";
import { PresenceAvatars, usePresencePeople, useSelfUserId } from "../teams/teamPresence";
import { useTeamProjectMachineState } from "../teams/teamProjects";
import {
  openAskAgentDialog,
  openTeamProjectDialog,
  openTeamProjectThreadDialog,
} from "../teams/teamUiStore";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";

const EMPTY_PEOPLE: ReadonlyArray<TeamPersonEntry> = [];
const EMPTY_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

const STATUS_LABELS: Readonly<Record<TeamWorkspace.PersonAgentStatus["kind"], string | null>> = {
  ready: "Agent ready",
  off: "Agent off",
  offline: "Offline",
  no_machine: "No machine yet",
  needs_update: "Needs an update",
  loading: null,
};

function SectionLabel({ children }: { readonly children: string }) {
  return <h2 className="px-2.5 font-medium text-muted-foreground text-xs">{children}</h2>;
}

export function TeamWorkspaceSidebar({ team }: { readonly team: CloudTeamSummary }) {
  const state = useTeamPeople();
  const machines = state.status === "personal" ? [] : state.machines;
  const people = state.status === "personal" ? EMPTY_PEOPLE : state.people;
  const threads = useQuietThreadShells();
  const projects = useProjects();
  const statuses = useTeamAgentStatuses(
    team.id,
    people.map((entry) => entry.person.userId),
    machines,
  );
  const panel = TeamWorkspace.teamPanel({
    teamId: team.id,
    machines: machines.map((machine) => ({
      environmentId: machine.environmentId,
      ownerUserId: machine.owner.userId,
    })),
    projects,
    threads,
  });
  const machineByEnvironment = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const sharedCount =
    panel.projects.length +
    [...panel.threadsByPerson.values()].reduce((count, list) => count + list.length, 0);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="min-h-full">
        <SidebarGroup>
          <div className="flex flex-col gap-3">
            {state.status === "loading" && people.length === 0 ? (
              <p className="px-2.5 py-2 text-muted-foreground text-xs">Loading the team…</p>
            ) : null}
            {state.status === "ready" && machines.length === 0 ? (
              <TeamNoMachines teamName={team.name} />
            ) : null}
            {machines.length > 0 ? (
              <section aria-label="Projects" className="flex flex-col gap-1">
                <SectionLabel>Projects</SectionLabel>
                {panel.projects.length === 0 ? (
                  <div className="flex items-center justify-between gap-2 px-2.5">
                    <span className="text-muted-foreground text-xs">No team projects yet.</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => openTeamProjectDialog({ teamId: team.id })}
                    >
                      Start a team project
                    </Button>
                  </div>
                ) : (
                  panel.projects.map(({ project, threads: projectThreads }) => {
                    const machine = machineByEnvironment.get(project.environmentId);
                    return machine ? (
                      <TeamProjectSection
                        key={`${project.environmentId}:${project.id}`}
                        project={project}
                        machine={machine}
                        threads={projectThreads}
                      />
                    ) : null;
                  })
                )}
              </section>
            ) : null}
            {people.length > 0 ? (
              <section aria-label="People" className="flex flex-col gap-3">
                {machines.length > 0 ? <SectionLabel>People</SectionLabel> : null}
                {people.map((entry) => (
                  <TeamPersonSection
                    key={entry.person.userId}
                    teamId={team.id}
                    entry={entry}
                    status={statuses.get(entry.person.userId) ?? { kind: "loading" }}
                    threads={panel.threadsByPerson.get(entry.person.userId) ?? EMPTY_THREADS}
                  />
                ))}
              </section>
            ) : null}
            {state.status === "failed" ? (
              <div className="flex flex-col items-start gap-2 px-2.5 py-2 text-muted-foreground text-xs">
                <span>Could not load the team&apos;s machines.</span>
                <Button size="xs" variant="outline" onClick={() => refreshTeamMachines(team.id)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {machines.length > 0 && sharedCount === 0 ? (
              <p className="px-2.5 text-muted-foreground text-xs">
                Nothing shared yet. Ask someone&apos;s agent, or open a thread and choose Share with
                team.
              </p>
            ) : null}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function TeamNoMachines({ teamName }: { readonly teamName: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-muted-foreground text-xs">
      <UsersIcon aria-hidden className="size-5" />
      <span>No one has shared a machine with {teamName} yet.</span>
      <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/settings/team" })}>
        Share a machine with the team
      </Button>
    </div>
  );
}

function TeamProjectSection({
  project,
  machine,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly machine: RelayTeamEnvironmentRecord;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const selfUserId = useSelfUserId();
  const machineState = useTeamProjectMachineState(machine.environmentId);
  const handleNewThread = useNewThreadHandler();
  const { isMobile, setOpenMobile } = useSidebar();
  const host = machine.owner;
  const status =
    machineState === "offline" ? "Offline" : machineState === "outdated" ? "Needs an update" : null;
  const startThread = () => {
    if (isMobile) setOpenMobile(false);
    if (machine.isOwner) {
      void handleNewThread(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    openTeamProjectThreadDialog(project.environmentId, project.id);
  };
  return (
    <section aria-label={project.title} className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        <Avatar
          name={host.name}
          src={host.image ?? null}
          seed={host.userId}
          size="xs"
          aria-label={machine.isOwner ? "Your machine" : `${host.name}'s machine`}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sidebar-foreground text-sm">
            {project.title}
          </span>
          {status ? <span className="truncate text-muted-foreground text-xs">{status}</span> : null}
        </span>
        {machineState === "online" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`New thread in ${project.title}`}
                  onClick={startThread}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>New thread</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {threads.length > 0 ? (
        <SidebarMenuSub>
          {threads.map((thread) => (
            <TeamThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              thread={thread}
              owner={host}
              selfIsOwner={machine.isOwner}
              selfUserId={selfUserId}
            />
          ))}
        </SidebarMenuSub>
      ) : null}
    </section>
  );
}

function TeamPersonSection({
  teamId,
  entry,
  status,
  threads,
}: {
  readonly teamId: string;
  readonly entry: TeamPersonEntry;
  readonly status: TeamWorkspace.PersonAgentStatus;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const navigate = useNavigate();
  const selfUserId = useSelfUserId();
  const { person, self } = entry;
  const ready = status.kind === "ready";
  const name = self ? "You" : person.name;
  const { isMobile, setOpenMobile } = useSidebar();
  const ask = () => {
    if (isMobile) setOpenMobile(false);
    openAskAgentDialog(teamId, person);
  };
  const label = STATUS_LABELS[status.kind];
  const identity = (
    <>
      <Avatar name={person.name} src={person.image ?? null} seed={person.userId} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col text-start">
        <span className="truncate font-medium text-sidebar-foreground text-sm">{name}</span>
        {label ? <span className="truncate text-muted-foreground text-xs">{label}</span> : null}
      </span>
    </>
  );
  return (
    <section aria-label={name} className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        {ready ? (
          <button
            type="button"
            aria-label={self ? "Ask your agent" : `Ask ${person.name}'s agent`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
            onClick={ask}
          >
            {identity}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
        )}
        {ready ? (
          <Button size="xs" variant="ghost" tabIndex={-1} onClick={ask}>
            Ask
          </Button>
        ) : self && status.kind === "off" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/team", hash: TEAM_AGENT_SECTION_ID })}
          >
            Turn on
          </Button>
        ) : null}
      </div>
      {threads.length > 0 ? (
        <SidebarMenuSub>
          {threads.map((thread) => (
            <TeamThreadRow
              key={`${thread.environmentId}:${thread.id}`}
              thread={thread}
              owner={person}
              selfIsOwner={self}
              selfUserId={selfUserId}
            />
          ))}
        </SidebarMenuSub>
      ) : null}
    </section>
  );
}

function TeamThreadRow({
  thread,
  owner,
  selfIsOwner,
  selfUserId,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly owner: TeamPerson;
  readonly selfIsOwner: boolean;
  readonly selfUserId: string | null;
}) {
  const route = useThreadRouteTarget();
  const { environmentId, id: threadId } = thread;
  const share = thread.source.teamShare;
  const isActive =
    route?.kind === "server" &&
    route.threadRef.environmentId === environmentId &&
    route.threadRef.threadId === threadId;
  const viewers = usePresencePeople(environmentId, {
    threadId,
    selfUserId,
    selfIsOwner,
    owner,
  });
  const asker = share?.agent?.startedBy;
  const starter = asker ?? share?.startedBy;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={isActive}
        render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
      >
        {asker ? (
          <MessageCircleIcon aria-label="Agent conversation" className="size-3.5 shrink-0" />
        ) : share?.access === "steer" ? (
          <SquarePenIcon aria-label="Steer" className="size-3.5 shrink-0" />
        ) : (
          <EyeIcon aria-label="View only" className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {starter && starter.userId !== selfUserId && starter.userId !== owner.userId ? (
          <span className="max-w-20 shrink-0 truncate text-muted-foreground text-xs">
            {starter.name}
          </span>
        ) : null}
        <PresenceAvatars people={viewers} />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
