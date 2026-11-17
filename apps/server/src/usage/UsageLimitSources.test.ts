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
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
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
            url: "https://hub.test:8317/team-a/management.html",
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

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);
