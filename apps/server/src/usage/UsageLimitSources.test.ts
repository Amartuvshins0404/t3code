import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CLIPROXY_CLAUDE_INSTANCE_ID,
  CLIPROXY_CODEX_INSTANCE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.mock(ProcessRunner.ProcessRunner)({}),
    ]),
    Effect.scoped,
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.mock(ProcessRunner.ProcessRunner)({}),
    ]),
    Effect.scoped,
  );
});

it.effect("a connected proxy gets providers for the accounts it pools until it disconnects", () => {
  const clientKeys: Array<unknown> = [];
  return Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const connected = yield* settingsService.getSettings;
    expect(Object.keys(connected.providerInstances).toSorted()).toEqual([
      CLIPROXY_CLAUDE_INSTANCE_ID,
      "claudeAgent_work",
      CLIPROXY_CODEX_INSTANCE_ID,
    ]);
    const clientKey = connected.usageLimitSources[UsageLimitSourceId.make("hub")]?.clientKey;
    expect(clientKeys).toEqual([{ old: clientKey, new: clientKey }]);
    const route = { url: "https://hub.test:8317", clientKey, managesProxy: false };
    expect(yield* sources.revealRoute).toEqual(route);
    expect(connected.providerInstances[CLIPROXY_CLAUDE_INSTANCE_ID]).toMatchObject({
      enabled: true,
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://hub.test:8317" },
        { name: "ANTHROPIC_AUTH_TOKEN", value: clientKey },
      ],
    });

    yield* settingsService.updateProviderInstance({
      operation: "upsert",
      instanceId: CLIPROXY_CLAUDE_INSTANCE_ID,
      instance: { ...connected.providerInstances[CLIPROXY_CLAUDE_INSTANCE_ID]!, enabled: false },
    });
    yield* sources.refresh;
    const turnedOff = yield* settingsService.getSettings;
    expect(turnedOff.providerInstances[CLIPROXY_CLAUDE_INSTANCE_ID]?.enabled).toBe(false);
    expect(clientKeys).toHaveLength(1);

    yield* settingsService.updateProviderInstance({
      operation: "remove",
      instanceId: CLIPROXY_CLAUDE_INSTANCE_ID,
    });
    expect(yield* sources.revealRoute).toEqual(route);

    yield* sources.disconnect;
    const settings = yield* settingsService.getSettings;
    expect(settings.usageLimitSources).toEqual({});
    expect(Object.keys(settings.providerInstances)).toEqual(["claudeAgent_work"]);
    expect(yield* sources.revealRoute).toBeNull();
  }).pipe(
    Effect.provide(connectedHub({ url: "https://hub.test:8317", clientKeys })),
    Effect.scoped,
  );
});

it.effect.each([
  {
    hub: "refuses new keys",
    url: "https://hub.test:8317",
    refusesNewKeys: true,
    expected: { url: "https://hub.test:8317", clientKey: "management-key", managesProxy: true },
  },
  {
    hub: "only answers on this machine",
    url: "http://127.0.0.1:8317",
    refusesNewKeys: false,
    expected: null,
  },
  {
    hub: "keeps its management key where it cannot be read",
    url: "https://hub.test:8317",
    refusesNewKeys: false,
    managementKeyUnreadable: true,
    expected: null,
  },
])("reveals the route of a proxy that $hub", ({ expected, ...hub }) =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    expect(yield* sources.revealRoute).toEqual(expected);
  }).pipe(Effect.provide(connectedHub(hub)), Effect.scoped),
);

function connectedHub(hub: {
  readonly url: string;
  readonly clientKeys?: Array<unknown>;
  readonly refusesNewKeys?: boolean;
  readonly managementKeyUnreadable?: boolean;
}) {
  return Layer.mergeAll(
    ServerSettings.layerTest({
      usageLimitSources: {
        [UsageLimitSourceId.make("hub")]: {
          kind: "cliproxy",
          url: hub.url,
          managementKey: hub.managementKeyUnreadable
            ? { provider: SecretProviderId.make("homelab"), reference: "locked#key" }
            : "management-key",
          enabled: true,
        },
      },
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent_work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
        },
        ...(hub.managementKeyUnreadable
          ? {
              [CLIPROXY_CLAUDE_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [
                  { name: "ANTHROPIC_BASE_URL", value: hub.url, sensitive: false },
                  { name: "ANTHROPIC_AUTH_TOKEN", value: "provider-key", sensitive: true },
                ],
              },
            }
          : {}),
      },
    }),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) => Effect.succeed(references.map(() => undefined)),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/auth-files")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                files: [
                  { id: "claude-a.json", auth_index: "1", provider: "claude", email: "a@x.test" },
                  { id: "codex-b.json", auth_index: "2", provider: "codex", email: "b@x.test" },
                ],
              }),
            );
          }
          if (path.endsWith("/api-keys") && request.body._tag === "Uint8Array") {
            if (hub.refusesNewKeys) {
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }));
            }
            hub.clientKeys?.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          }
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }),
      ),
    ),
    NodeCrypto.layer,
    NodeServices.layer,
    Layer.mock(ProcessRunner.ProcessRunner)({}),
  );
}
