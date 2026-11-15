import { ModelSelection, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SHARED_ORGANIZATIONS_SECRET = "team-shared-organizations";
const TEAM_AGENT_SETTINGS_SECRET = "team-agent-settings";

export const TeamAgentSetting = Schema.Struct({
  enabled: Schema.Boolean,
  projectIds: Schema.Array(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamAgentSetting = typeof TeamAgentSetting.Type;

const TeamAgentSettings = Schema.Record(Schema.String, TeamAgentSetting);

const TeamSharingState = Schema.Struct({
  organizationIds: Schema.Array(Schema.String),
  agents: TeamAgentSettings,
});
export type TeamSharingState = typeof TeamSharingState.Type;

const SharedOrganizationIds = Schema.Array(Schema.String);
const decodeStoredOrganizations = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([SharedOrganizationIds, TeamSharingState])),
);
const decodeStoredAgents = Schema.decodeUnknownOption(Schema.fromJsonString(TeamAgentSettings));
const encodeOrganizationIds = Schema.encodeEffect(Schema.fromJsonString(SharedOrganizationIds));
const encodeAgents = Schema.encodeEffect(Schema.fromJsonString(TeamAgentSettings));

const EMPTY_STATE: TeamSharingState = { organizationIds: [], agents: {} };

const readSecret = Effect.fn("TeamSharing.readSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  name: string,
) {
  const stored = yield* secrets.get(name);
  return Option.map(stored, (bytes) => new TextDecoder().decode(bytes));
});

export const readTeamSharingState = Effect.fn("TeamSharing.readTeamSharingState")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const organizations = Option.flatMap(
    yield* readSecret(secrets, SHARED_ORGANIZATIONS_SECRET),
    decodeStoredOrganizations,
  );
  if (Option.isNone(organizations)) return EMPTY_STATE;
  const stored = organizations.value;
  const storedAgents = Option.flatMap(
    yield* readSecret(secrets, TEAM_AGENT_SETTINGS_SECRET),
    decodeStoredAgents,
  );
  return "organizationIds" in stored
    ? {
        organizationIds: stored.organizationIds,
        agents: Option.getOrElse(storedAgents, () => stored.agents),
      }
    : { organizationIds: stored, agents: Option.getOrElse(storedAgents, () => ({})) };
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
  if (Object.keys(agents).length === 0) {
    yield* secrets.remove(TEAM_AGENT_SETTINGS_SECRET);
  } else {
    const encoded = yield* encodeAgents(agents);
    yield* secrets.set(TEAM_AGENT_SETTINGS_SECRET, new TextEncoder().encode(encoded));
  }
  if (state.organizationIds.length === 0) {
    return yield* secrets.remove(SHARED_ORGANIZATIONS_SECRET);
  }
  const encoded = yield* encodeOrganizationIds(state.organizationIds);
  yield* secrets.set(SHARED_ORGANIZATIONS_SECRET, new TextEncoder().encode(encoded));
});

export const readSharedOrganizationIds = Effect.fn("TeamSharing.readSharedOrganizationIds")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    return (yield* readTeamSharingState(secrets)).organizationIds;
  },
);

export const teamAgentSetting = (state: TeamSharingState, organizationId: string) =>
  state.organizationIds.includes(organizationId) ? state.agents[organizationId] : undefined;
