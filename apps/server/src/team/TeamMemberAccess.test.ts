import {
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type TeamMemberIdentity,
  ThreadId,
  type ThreadTeamShare,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decideTeamMemberCommand,
  makeTeamShellFilter,
  withoutClientMemberAttribution,
} from "./TeamMemberAccess.ts";

const member: TeamMemberIdentity = {
  userId: "user-ana",
  name: "Ana",
  organizationId: "org-a",
  organizationSlug: "team-a",
  role: "member",
};
const threadId = ThreadId.make("thread-1");
const share = (organizationId: string, access: ThreadTeamShare["access"]): ThreadTeamShare => ({
  organizationId,
  access,
  sharedAt: "2026-11-14T00:00:00.000Z",
});

const message: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
  type: "message.dispatch",
  commandId: CommandId.make("command-1"),
  threadId,
  messageId: MessageId.make("message-1"),
  text: "Please run the tests",
  attachments: [],
  context: {
    version: 1,
    records: [],
    member: { userId: "user-boss", name: "The Boss" },
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-max" },
  freshContext: true,
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "mcp",
};

describe("decideTeamMemberCommand", () => {
  it("sends a teammate's message on a steer thread with the thread's own settings and their name", () => {
    const decision = decideTeamMemberCommand({
      command: message,
      teamShare: share("org-a", "steer"),
      member,
    });
    expect(Result.isSuccess(decision)).toBe(true);
    const sent = Result.getOrThrow(decision);
    expect(sent).toEqual({
      type: "message.dispatch",
      commandId: message.commandId,
      threadId,
      messageId: MessageId.make("message-1"),
      text: "Please run the tests",
      attachments: [],
      context: { version: 1, records: [], member: { userId: "user-ana", name: "Ana" } },
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

  it.each([
    ["an unshared thread", null],
    ["another team's thread", share("org-b", "steer")],
    ["a view-only thread", share("org-a", "view")],
  ])("refuses a message on %s", (_label, teamShare) => {
    expect(Result.isFailure(decideTeamMemberCommand({ command: message, teamShare, member }))).toBe(
      true,
    );
  });

  it.each(["auto", "steer"] as const)(
    "keeps a teammate's %s delivery so the message can reach the running turn",
    (deliveryIntent) => {
      const decision = decideTeamMemberCommand({
        command: { ...message, deliveryIntent },
        teamShare: share("org-a", "steer"),
        member,
      });
      expect(Result.getOrThrow(decision)).toMatchObject({ deliveryIntent });
    },
  );

  it.each<Partial<Extract<OrchestrationV2Command, { type: "message.dispatch" }>>>([
    { dispatchMode: { type: "restart_active", targetRunId: RunId.make("run-1") } },
    { deliveryIntent: "restart" },
  ])("refuses a restart, which would throw away the owner's running turn", (restart) => {
    expect(
      Result.isFailure(
        decideTeamMemberCommand({
          command: { ...message, ...restart },
          teamShare: share("org-a", "steer"),
          member,
        }),
      ),
    ).toBe(true);
  });

  it.each<OrchestrationV2Command>([
    {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("command-2"),
      threadId,
      runtimeMode: "full-access",
    },
    { type: "thread.delete", commandId: CommandId.make("command-3"), threadId },
    { type: "thread.archive", commandId: CommandId.make("command-4"), threadId },
  ])("refuses $type even on a steer thread", (command) => {
    const decision = decideTeamMemberCommand({
      command,
      teamShare: share("org-a", "steer"),
      member,
    });
    expect(Result.isFailure(decision)).toBe(true);
  });

  it("lets a teammate stop a turn on a steer thread without holding the owner's queue", () => {
    const decision = decideTeamMemberCommand({
      command: {
        type: "run.interrupt",
        commandId: CommandId.make("command-5"),
        threadId,
        runId: RunId.make("run-1"),
        holdQueue: true,
      },
      teamShare: share("org-a", "steer"),
      member,
    });
    expect(Result.getOrThrow(decision)).toEqual({
      type: "run.interrupt",
      commandId: CommandId.make("command-5"),
      threadId,
      runId: RunId.make("run-1"),
    });
  });
});

it("strips a member that any client sends on its own message", () => {
  const stripped = withoutClientMemberAttribution(message);
  expect(stripped.type === "message.dispatch" && stripped.context).toEqual({
    version: 1,
    records: [],
  });
});

describe("makeTeamShellFilter", () => {
  const project = (id: string) =>
    ({
      id: ProjectId.make(id),
      title: id,
      workspaceRoot: `/owner/${id}`,
    }) as unknown as OrchestrationProjectShell;
  const thread = (id: string, projectId: string, teamShare: ThreadTeamShare | null) =>
    ({
      id: ThreadId.make(id),
      projectId: ProjectId.make(projectId),
      teamShare,
    }) as unknown as OrchestrationV2ThreadShell;

  it("shows only shared threads and their projects, and removes a thread once it is unshared", () => {
    const filter = makeTeamShellFilter("org-a");
    const [snapshot] = filter({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 10,
        projects: [project("p-shared"), project("p-private")],
        threads: [
          thread("t-shared", "p-shared", share("org-a", "view")),
          thread("t-other-team", "p-private", share("org-b", "steer")),
          thread("t-private", "p-private", null),
        ],
        archivedThreads: [thread("t-archived", "p-private", null)],
      },
    });
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: {
        projects: [{ id: "p-shared" }],
        threads: [{ id: "t-shared" }],
        archivedThreads: [],
      },
    });

    expect(
      filter({
        kind: "thread.updated",
        sequence: 11,
        location: "active",
        thread: thread("t-private", "p-private", null),
      }),
    ).toEqual([]);
    expect(
      filter({ kind: "project.updated", sequence: 12, project: project("p-private") }),
    ).toEqual([]);
    expect(
      filter({
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: 12,
          projects: [project("p-shared"), project("p-private")],
          threads: [],
          archivedThreads: [],
        },
        resolvedRepositoryIdentityRoots: ["/owner/p-shared", "/owner/p-private"],
      }),
    ).toEqual([
      {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: 12,
          projects: [project("p-shared")],
          threads: [],
          archivedThreads: [],
        },
        resolvedRepositoryIdentityRoots: ["/owner/p-shared"],
      },
    ]);
    expect(
      filter({
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: 12,
          projects: [project("p-private")],
          threads: [],
          archivedThreads: [],
        },
        resolvedRepositoryIdentityRoots: ["/owner/p-private"],
      }),
    ).toEqual([]);

    expect(
      filter({
        kind: "thread.updated",
        sequence: 13,
        location: "active",
        thread: thread("t-shared", "p-shared", null),
      }),
    ).toEqual([
      { kind: "thread.removed", sequence: 13, location: "active", threadId: "t-shared" },
      { kind: "project.removed", sequence: 13, projectId: "p-shared" },
    ]);
  });

  it("brings in a thread's project when the thread becomes shared", () => {
    const filter = makeTeamShellFilter("org-a");
    filter({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [project("p-1")],
        threads: [thread("t-1", "p-1", null)],
        archivedThreads: [],
      },
    });
    const shared = thread("t-1", "p-1", share("org-a", "steer"));
    expect(
      filter({ kind: "thread.updated", sequence: 2, location: "active", thread: shared }),
    ).toEqual([
      { kind: "project.updated", sequence: 2, project: project("p-1") },
      { kind: "thread.updated", sequence: 2, location: "active", thread: shared },
    ]);
  });
});
