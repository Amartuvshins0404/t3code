import { ThreadId, type ThreadTeamShare } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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
