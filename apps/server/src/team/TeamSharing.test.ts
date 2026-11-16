import {
  ProjectId,
  type ProjectTeamShare,
  ProviderInstanceId,
  ThreadId,
  type ThreadTeamShare,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TeamConnectivity from "./TeamConnectivity.ts";
import * as TeamSharing from "./TeamSharing.ts";

const threadId = ThreadId.make("thread-agent");
const agentShare: ThreadTeamShare = {
  organizationId: "org-a",
  access: "steer",
  sharedAt: "2026-11-15T00:00:00.000Z",
  agent: { startedBy: { userId: "user-ana", name: "Ana" } },
};

it.effect("a client can neither move nor clear an agent conversation's share", () =>
  Effect.gen(function* () {
    const dispatched: Array<string> = [];
    const sharing = yield* TeamSharing.TeamSharing.pipe(
      Effect.provide(
        TeamSharing.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: () =>
                  Effect.succeed({ thread: { teamShare: agentShare } } as never),
                dispatch: (command) => {
                  dispatched.push(command.type);
                  return Effect.succeed({} as never);
                },
              }),
              Layer.mock(ServerSecretStore.ServerSecretStore)({}),
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "t3",
                legacyCookieName: undefined,
              }),
              Layer.mock(PairingGrantStore.PairingGrantStore)({}),
              Layer.mock(TeamConnectivity.TeamConnectivity)({}),
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.succeed(
                SecureRandom.SecureRandom,
                SecureRandom.make((size) => new Uint8Array(size).fill(8)),
              ),
            ),
          ),
        ),
      ),
    );

    const moved = yield* sharing
      .setThreadShare({ threadId, organizationId: "org-a", access: "view" })
      .pipe(Effect.flip);
    const cleared = yield* sharing.clearThreadShare({ threadId }).pipe(Effect.flip);

    expect([moved.reason, cleared.reason]).toEqual([
      "not_allowed_for_teammates",
      "not_allowed_for_teammates",
    ]);
    expect(dispatched).toEqual([]);
  }),
);

const teamProject = ProjectId.make("project-team");
const otherProject = ProjectId.make("project-other");
const projectShare: ProjectTeamShare = {
  organizationId: "org-a",
  sharedAt: "2026-11-15T00:00:00.000Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-team" },
  runtimeMode: "full-access",
};
const steer = (organizationId: string): ThreadTeamShare => ({
  organizationId,
  access: "steer",
  sharedAt: "2026-11-15T00:00:00.000Z",
});
const projectThreads = [
  { id: ThreadId.make("t-team"), projectId: teamProject, teamShare: steer("org-a") },
  { id: ThreadId.make("t-agent"), projectId: teamProject, teamShare: agentShare },
  { id: ThreadId.make("t-other-team"), projectId: teamProject, teamShare: steer("org-b") },
  { id: ThreadId.make("t-elsewhere"), projectId: otherProject, teamShare: steer("org-a") },
];

const sharingWithProjects = (record: Array<string>) =>
  TeamSharing.TeamSharing.pipe(
    Effect.provide(
      TeamSharing.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getShellSnapshot: (options) => {
                const threads = projectThreads.filter(
                  (thread) => thread.projectId === options?.projectId,
                );
                return Effect.succeed({ threads, archivedThreads: [] } as never);
              },
              dispatch: (command) => {
                record.push(`${command.type}:${"threadId" in command ? command.threadId : "none"}`);
                return Effect.succeed({} as never);
              },
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: (projectId) =>
                Effect.succeedSome({
                  projectId,
                  archivedAt: null,
                  teamShare: projectShare,
                } as never),
            }),
            Layer.mock(ProjectService.ProjectService)({
              setTeamShare: (input) =>
                Effect.sync(() => {
                  record.push(
                    `project:${input.projectId}:${input.teamShare?.organizationId ?? "none"}`,
                  );
                }),
            }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () =>
                Effect.succeedSome(
                  new TextEncoder().encode(
                    JSON.stringify({ organizationIds: ["org-a", "org-b"], agents: {} }),
                  ),
                ),
            }),
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "t3",
              legacyCookieName: undefined,
            }),
            Layer.mock(PairingGrantStore.PairingGrantStore)({}),
            Layer.mock(TeamConnectivity.TeamConnectivity)({}),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(8)),
            ),
          ),
        ),
      ),
    ),
  );

it.effect(
  "clearing a project share unshares its team's threads and leaves agent conversations and other projects alone",
  () =>
    Effect.gen(function* () {
      const record: Array<string> = [];
      const sharing = yield* sharingWithProjects(record);
      yield* sharing.clearProjectShare(teamProject);
      expect(record).toEqual([`project:${teamProject}:none`, "thread.team-share.clear:t-team"]);
    }),
);

it.effect("a project shared with one team cannot be moved to another", () =>
  Effect.gen(function* () {
    const record: Array<string> = [];
    const sharing = yield* sharingWithProjects(record);
    const refused = yield* sharing
      .setProjectShare(teamProject, { ...projectShare, organizationId: "org-b" })
      .pipe(Effect.flip);
    expect(refused.message).toBe(
      "This project is shared with another team. Stop sharing it there first.",
    );
    expect(record).toEqual([]);
  }),
);
