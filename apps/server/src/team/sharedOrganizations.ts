import { ModelSelection, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SHARED_ORGANIZATIONS_SECRET = "team-shared-organizations";

export const TeamAgentSetting = Schema.Struct({
  enabled: Schema.Boolean,
  projectIds: Schema.Array(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamAgentSetting = typeof TeamAgentSetting.Type;

const TeamSharingState = Schema.Struct({
  organizationIds: Schema.Array(Schema.String),
  agents: Schema.Record(Schema.String, TeamAgentSetting),
});
export type TeamSharingState = typeof TeamSharingState.Type;

const StoredTeamSharingState = Schema.fromJsonString(
  Schema.Union([
    TeamSharingState,
    Schema.Array(Schema.String).pipe(
      Schema.decodeTo(
        Schema.toType(TeamSharingState),
        SchemaTransformation.transform({
          decode: (organizationIds) => ({ organizationIds, agents: {} }),
          encode: (state) => state.organizationIds,
        }),
      ),
    ),
  ]),
);
const decodeState = Schema.decodeUnknownOption(StoredTeamSharingState);
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TeamSharingState));

const EMPTY_STATE: TeamSharingState = { organizationIds: [], agents: {} };

export const readTeamSharingState = Effect.fn("TeamSharing.readTeamSharingState")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const stored = yield* secrets.get(SHARED_ORGANIZATIONS_SECRET);
  if (Option.isNone(stored)) return EMPTY_STATE;
  return Option.getOrElse(decodeState(new TextDecoder().decode(stored.value)), () => EMPTY_STATE);
});

export const writeTeamSharingState = Effect.fn("TeamSharing.writeTeamSharingState")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  state: TeamSharingState,
) {
  const agents = Object.fromEntries(
    Object.entries(state.agents).filter(([organizationId]) =>
      state.organizationIds.includes(organizationId),
    ),
  );
  if (state.organizationIds.length === 0) {
    return yield* secrets.remove(SHARED_ORGANIZATIONS_SECRET);
  }
  const encoded = yield* encodeState({ organizationIds: state.organizationIds, agents });
  yield* secrets.set(SHARED_ORGANIZATIONS_SECRET, new TextEncoder().encode(encoded));
});

export const readSharedOrganizationIds = Effect.fn("TeamSharing.readSharedOrganizationIds")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    return (yield* readTeamSharingState(secrets)).organizationIds;
  },
);

export const teamAgentSetting = (state: TeamSharingState, organizationId: string) =>
  state.organizationIds.includes(organizationId) ? state.agents[organizationId] : undefined;
