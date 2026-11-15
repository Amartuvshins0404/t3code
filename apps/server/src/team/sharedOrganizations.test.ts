import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readTeamSharingState, writeTeamSharingState } from "./sharedOrganizations.ts";

const amaraaModeSharedOrganizationIds = Schema.fromJsonString(Schema.Array(Schema.String));

const memorySecrets = (initial: Record<string, string> = {}) => {
  const values = new Map<string, Uint8Array>(
    Object.entries(initial).map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  const secrets = {
    get: (name: string) => Effect.succeed(Option.fromNullishOr(values.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void values.set(name, value)),
    remove: (name: string) => Effect.sync(() => void values.delete(name)),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  const raw = (name: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : new TextDecoder().decode(value);
  };
  return { secrets, raw };
};

const setting = {
  enabled: true,
  projectIds: [ProjectId.make("project-a")],
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku" },
};

it.effect(
  "keeps the shared teams readable by the app before agents, and keeps agent settings",
  () =>
    Effect.gen(function* () {
      const { secrets, raw } = memorySecrets();
      yield* writeTeamSharingState(secrets, {
        organizationIds: ["org-a", "org-b"],
        agents: { "org-a": setting, "org-gone": setting },
      });

      const olderApp = yield* Schema.decodeUnknownEffect(amaraaModeSharedOrganizationIds)(
        raw("team-shared-organizations"),
      );
      expect(olderApp).toEqual(["org-a", "org-b"]);
      expect(yield* readTeamSharingState(secrets)).toEqual({
        organizationIds: ["org-a", "org-b"],
        agents: { "org-a": setting },
      });
    }),
);

it.effect("reads shared teams and agent settings a development build stored together", () =>
  Effect.gen(function* () {
    const { secrets, raw } = memorySecrets({
      "team-shared-organizations": JSON.stringify({
        organizationIds: ["org-a"],
        agents: { "org-a": setting },
      }),
    });
    const state = yield* readTeamSharingState(secrets);
    expect(state).toEqual({ organizationIds: ["org-a"], agents: { "org-a": setting } });

    yield* writeTeamSharingState(secrets, state);
    expect(raw("team-shared-organizations")).toBe(JSON.stringify(["org-a"]));
    expect(yield* readTeamSharingState(secrets)).toEqual(state);
  }),
);
