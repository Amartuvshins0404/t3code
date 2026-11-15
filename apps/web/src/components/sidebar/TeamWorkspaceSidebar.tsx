import type { CloudTeamSummary } from "@t3tools/client-runtime/cloud-auth";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { TeamWorkspace } from "@t3tools/client-runtime/relay";
import type { TeamPerson } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { EyeIcon, MessageCircleIcon, SquarePenIcon, UsersIcon } from "lucide-react";

import { refreshTeamMachines } from "~/cloud/teamWorkspace";
import { isElectron } from "~/env";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { useQuietThreadShells } from "~/state/entities";
import {
  TEAM_AGENT_SECTION_ID,
  type TeamPersonEntry,
  useTeamAgentStatuses,
  useTeamPeople,
} from "../teams/teamAgents";
import { PresenceAvatars, usePresencePeople, useSelfUserId } from "../teams/teamPresence";
import { openAskAgentDialog } from "../teams/teamUiStore";
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

const EMPTY_PEOPLE: ReadonlyArray<TeamPersonEntry> = [];

function personThreads(
  scope: TeamWorkspace.WorkspaceScope,
  entry: TeamPersonEntry,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const environmentIds = new Set<string>(entry.machines.map((machine) => machine.environmentId));
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        environmentIds.has(thread.environmentId) &&
        TeamWorkspace.workspaceListsThread(scope, {
          environmentId: thread.environmentId,
          teamShare: thread.source.teamShare,
        }),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const STATUS_LABELS: Readonly<Record<TeamWorkspace.PersonAgentStatus["kind"], string | null>> = {
  ready: "Agent ready",
  off: "Agent off",
  offline: "Offline",
  no_machine: "No machine yet",
  needs_update: "Needs an update",
  loading: null,
};

export function TeamWorkspaceSidebar({ team }: { readonly team: CloudTeamSummary }) {
  const state = useTeamPeople();
  const machines = state.status === "personal" ? [] : state.machines;
  const people = state.status === "personal" ? EMPTY_PEOPLE : state.people;
  const threads = useQuietThreadShells();
  const statuses = useTeamAgentStatuses(
    team.id,
    people.map((entry) => entry.person.userId),
    machines,
  );
  const scope: TeamWorkspace.WorkspaceScope = {
    kind: "team",
    teamId: team.id,
    environmentIds: new Set(machines.map((machine) => machine.environmentId)),
  };
  const threadsByPerson = new Map(
    people.map((entry) => [entry.person.userId, personThreads(scope, entry, threads)]),
  );
  const sharedThreadCount = [...threadsByPerson.values()].reduce(
    (count, list) => count + list.length,
    0,
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="min-h-full">
        <SidebarGroup>
          <div className="flex flex-col gap-3">
            {state.status === "loading" && people.length === 0 ? (
              <p className="px-2.5 py-2 text-muted-foreground text-xs">Loading the team…</p>
            ) : null}
            {people.map((entry) => (
              <TeamPersonSection
                key={entry.person.userId}
                teamId={team.id}
                entry={entry}
                status={statuses.get(entry.person.userId) ?? { kind: "loading" }}
                threads={threadsByPerson.get(entry.person.userId) ?? []}
              />
            ))}
            {state.status === "failed" ? (
              <div className="flex flex-col items-start gap-2 px-2.5 py-2 text-muted-foreground text-xs">
                <span>Could not load the team&apos;s machines.</span>
                <Button size="xs" variant="outline" onClick={() => refreshTeamMachines(team.id)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {state.status === "ready" && machines.length === 0 ? (
              <TeamNoMachines teamName={team.name} />
            ) : null}
            {machines.length > 0 && sharedThreadCount === 0 ? (
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
  const ask = () => openAskAgentDialog(teamId, person);
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
        {asker && asker.userId !== selfUserId ? (
          <span className="max-w-20 shrink-0 truncate text-muted-foreground text-xs">
            {asker.name}
          </span>
        ) : null}
        <PresenceAvatars people={viewers} />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
