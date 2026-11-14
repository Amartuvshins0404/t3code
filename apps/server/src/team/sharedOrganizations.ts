import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SHARED_ORGANIZATIONS_SECRET = "team-shared-organizations";

const SharedOrganizationIds = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeSharedOrganizationIds = Schema.decodeUnknownOption(SharedOrganizationIds);

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
