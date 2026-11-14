import {
  CommandId,
  TeamAccessError,
  type TeamMemberAccessRevokeInput,
  type TeamSharedOrganizations,
  type TeamThreadShareClearInput,
  type TeamThreadShareSetInput,
  type ThreadTeamShare,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { readSharedOrganizationIds, writeSharedOrganizationIds } from "./sharedOrganizations.ts";

export class TeamSharing extends Context.Service<
  TeamSharing,
  {
    readonly listSharedOrganizations: Effect.Effect<TeamSharedOrganizations, TeamAccessError>;
    readonly addSharedOrganization: (
      organizationId: string,
    ) => Effect.Effect<TeamSharedOrganizations, TeamAccessError>;
    readonly removeSharedOrganization: (
      organizationId: string,
    ) => Effect.Effect<TeamSharedOrganizations, TeamAccessError>;
    readonly revokeMemberAccess: (
      input: TeamMemberAccessRevokeInput,
    ) => Effect.Effect<void, TeamAccessError>;
    readonly setThreadShare: (
      input: TeamThreadShareSetInput,
    ) => Effect.Effect<ThreadTeamShare, TeamAccessError>;
    readonly clearThreadShare: (
      input: TeamThreadShareClearInput,
    ) => Effect.Effect<void, TeamAccessError>;
  }
>()("t3/team/TeamSharing") {}

const internal = (message: string) => new TeamAccessError({ reason: "internal", message });
const threadUnavailable = () =>
  new TeamAccessError({ reason: "thread_unavailable", message: "This thread is not available." });

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const writes = yield* Semaphore.make(1);

  const read = readSharedOrganizationIds(secrets).pipe(
    Effect.mapError(() => internal("Could not read the shared teams.")),
  );
  const write = (organizationIds: ReadonlyArray<string>) =>
    writeSharedOrganizationIds(secrets, organizationIds).pipe(
      Effect.mapError(() => internal("Could not save the shared teams.")),
    );

  const commandId = (label: string) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => CommandId.make(`server:team-share:${label}:${uuid}`)),
      Effect.orDie,
    );

  const listSharedOrganizations = read.pipe(
    Effect.map((organizationIds) => ({ organizationIds })),
    Effect.withSpan("TeamSharing.listSharedOrganizations"),
  );

  const addSharedOrganization = Effect.fn("TeamSharing.addSharedOrganization")(function* (
    organizationId: string,
  ) {
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* read;
        if (current.includes(organizationId)) return { organizationIds: current };
        const organizationIds = [...current, organizationId];
        yield* write(organizationIds);
        return { organizationIds };
      }),
    );
  });

  const removeSharedOrganization = Effect.fn("TeamSharing.removeSharedOrganization")(function* (
    organizationId: string,
  ) {
    const organizationIds = yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* read;
        const next = current.filter((candidate) => candidate !== organizationId);
        if (next.length !== current.length) yield* write(next);
        return next;
      }),
    );
    yield* pairingLinks
      .revokeForOrganization(organizationId)
      .pipe(Effect.mapError(() => internal("Could not end the team's pairing links.")));
    yield* sessions
      .revokeForOrganization(organizationId)
      .pipe(Effect.mapError(() => internal("Could not end the team's sessions.")));
    return { organizationIds };
  });

  const revokeMemberAccess = Effect.fn("TeamSharing.revokeMemberAccess")(function* (
    input: TeamMemberAccessRevokeInput,
  ) {
    yield* pairingLinks
      .revokeForOrganization(input.organizationId, input.userId)
      .pipe(Effect.mapError(() => internal("Could not end the teammate's pairing links.")));
    yield* sessions
      .revokeForOrganization(input.organizationId, input.userId)
      .pipe(Effect.mapError(() => internal("Could not end the teammate's sessions.")));
  });

  const setThreadShare = Effect.fn("TeamSharing.setThreadShare")(function* (
    input: TeamThreadShareSetInput,
  ) {
    if (!(yield* read).includes(input.organizationId)) {
      return yield* new TeamAccessError({
        reason: "organization_not_shared",
        message: "Share this machine with the team before sharing a thread with it.",
      });
    }
    yield* orchestrator
      .dispatch({
        type: "thread.team-share.set",
        commandId: yield* commandId("set"),
        threadId: input.threadId,
        organizationId: input.organizationId,
        access: input.access,
      })
      .pipe(Effect.mapError(threadUnavailable));
    const { thread } = yield* orchestrator
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(threadUnavailable));
    if (!thread.teamShare || thread.teamShare.organizationId !== input.organizationId) {
      return yield* internal("The thread's share changed while it was being set.");
    }
    return thread.teamShare;
  });

  const clearThreadShare = Effect.fn("TeamSharing.clearThreadShare")(function* (
    input: TeamThreadShareClearInput,
  ) {
    yield* orchestrator
      .dispatch({
        type: "thread.team-share.clear",
        commandId: yield* commandId("clear"),
        threadId: input.threadId,
      })
      .pipe(Effect.mapError(threadUnavailable));
  });

  return TeamSharing.of({
    listSharedOrganizations,
    addSharedOrganization,
    removeSharedOrganization,
    revokeMemberAccess,
    setThreadShare,
    clearThreadShare,
  });
});

export const layer = Layer.effect(TeamSharing, make);
