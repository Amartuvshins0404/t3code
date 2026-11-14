import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SHARED_ORGANIZATIONS_SECRET = "team-shared-organizations";

const SharedOrganizationIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeSharedOrganizationIds = Schema.decodeUnknownOption(SharedOrganizationIds);
const encodeSharedOrganizationIds = Schema.encodeEffect(SharedOrganizationIds);

export const readSharedOrganizationIds = Effect.fn("TeamSharing.readSharedOrganizationIds")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    const stored = yield* secrets.get(SHARED_ORGANIZATIONS_SECRET);
    if (Option.isNone(stored)) return [];
    return Option.getOrElse(
      decodeSharedOrganizationIds(new TextDecoder().decode(stored.value)),
      () => [],
    );
  },
);

export const writeSharedOrganizationIds = Effect.fn("TeamSharing.writeSharedOrganizationIds")(
  function* (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    organizationIds: ReadonlyArray<string>,
  ) {
    if (organizationIds.length === 0) {
      return yield* secrets.remove(SHARED_ORGANIZATIONS_SECRET);
    }
    const encoded = yield* encodeSharedOrganizationIds(organizationIds);
    yield* secrets.set(SHARED_ORGANIZATIONS_SECRET, new TextEncoder().encode(encoded));
  },
);
