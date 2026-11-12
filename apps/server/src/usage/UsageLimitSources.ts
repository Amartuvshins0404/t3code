import {
  CLIPROXY_CLAUDE_INSTANCE_ID,
  CLIPROXY_CODEX_INSTANCE_ID,
  type CliproxyAccount,
  type CliproxyAccountInput,
  type CliproxyAddProvidersInput,
  type CliproxyAddProvidersResult,
  CliproxyLocalError,
  type CliproxyConnectLocalInput,
  type CliproxyLocalStatus,
  CliproxyManageError,
  type CliproxyRouting,
  type CliproxySetAccountEnabledInput,
  type CliproxySetRoutingInput,
  type CliproxySignIn,
  type CliproxySignInInput,
  type CliproxySignInStartInput,
  type CliproxySignInStatus,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { usageLimitSourceIdFromUrl } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { type CliproxyMachine, makeCliproxyLocal } from "./cliproxyLocal.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    readonly localStatus: Effect.Effect<CliproxyLocalStatus>;
    readonly installLocal: Effect.Effect<CliproxyLocalStatus, CliproxyLocalError>;
    readonly connectLocal: (
      input: CliproxyConnectLocalInput,
    ) => Effect.Effect<CliproxyLocalStatus, CliproxyLocalError>;
    readonly setNewLocalKey: Effect.Effect<CliproxyLocalStatus, CliproxyLocalError>;
    readonly addLocalProviders: (
      input: CliproxyAddProvidersInput,
    ) => Effect.Effect<CliproxyAddProvidersResult, CliproxyLocalError>;
    readonly disconnect: Effect.Effect<void, CliproxyLocalError>;
    readonly revealManagementKey: (
      sourceId: UsageLimitSourceId,
    ) => Effect.Effect<string, UsageLimitSourceError>;
    readonly listAccounts: (
      sourceId: UsageLimitSourceId,
    ) => Effect.Effect<ReadonlyArray<CliproxyAccount>, CliproxyManageError>;
    readonly startSignIn: (
      input: CliproxySignInStartInput,
    ) => Effect.Effect<CliproxySignIn, CliproxyManageError>;
    readonly signInStatus: (
      input: CliproxySignInInput,
    ) => Effect.Effect<CliproxySignInStatus, CliproxyManageError>;
    readonly cancelSignIn: (input: CliproxySignInInput) => Effect.Effect<void, CliproxyManageError>;
    readonly removeAccount: (
      input: CliproxyAccountInput,
    ) => Effect.Effect<void, CliproxyManageError>;
    readonly setAccountEnabled: (
      input: CliproxySetAccountEnabledInput,
    ) => Effect.Effect<void, CliproxyManageError>;
    readonly routing: (
      sourceId: UsageLimitSourceId,
    ) => Effect.Effect<CliproxyRouting, CliproxyManageError>;
    readonly setRouting: (
      input: CliproxySetRoutingInput,
    ) => Effect.Effect<void, CliproxyManageError>;
  }
>()("t3/usage/UsageLimitSources") {}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLocalHub(configUrl: string, localUrl: string): boolean {
  try {
    const hub = new URL(configUrl.includes("://") ? configUrl : `http://${configUrl}`);
    return LOCAL_HOSTS.has(hub.hostname) && hub.port === new URL(localUrl).port;
  } catch {
    return false;
  }
}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

const CODEX_CLIENT_KEY_VARIABLE = "CLIPROXY_API_KEY";

const codexProxyLaunchArgs = (url: string) =>
  [
    "model_provider=cliproxy",
    "model_providers.cliproxy.name=CLIProxyAPI",
    `model_providers.cliproxy.base_url=${new URL("v1", `${url}/`).toString()}`,
    `model_providers.cliproxy.env_key=${CODEX_CLIENT_KEY_VARIABLE}`,
  ]
    .map((override) => `-c ${override}`)
    .join(" ");

function proxyInstances(url: string, clientKey: string, input: CliproxyAddProvidersInput) {
  return [
    ...(input.claude
      ? [
          {
            instanceId: CLIPROXY_CLAUDE_INSTANCE_ID,
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude (CLI Proxy)",
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: url, sensitive: false },
              { name: "ANTHROPIC_AUTH_TOKEN", value: clientKey, sensitive: true },
            ],
            config: {},
          },
        ]
      : []),
    ...(input.codex
      ? [
          {
            instanceId: CLIPROXY_CODEX_INSTANCE_ID,
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex (CLI Proxy)",
            environment: [{ name: CODEX_CLIENT_KEY_VARIABLE, value: clientKey, sensitive: true }],
            config: { setupMode: "existing", launchArgs: codexProxyLaunchArgs(url) },
          },
        ]
      : []),
  ];
}

function withProxyRoute(
  existing: ProviderInstanceConfig | undefined,
  route: ReturnType<typeof proxyInstances>[number],
): ProviderInstanceConfig {
  const fresh = {
    driver: route.driver,
    displayName: route.displayName,
    enabled: true,
    environment: route.environment,
    ...(Object.keys(route.config).length > 0 ? { config: route.config } : {}),
  } satisfies ProviderInstanceConfig;
  if (existing?.driver !== route.driver) return fresh;
  const replaced = new Set(route.environment.map((variable) => variable.name));
  const config =
    existing.config !== null &&
    typeof existing.config === "object" &&
    !Array.isArray(existing.config)
      ? existing.config
      : {};
  return {
    ...existing,
    enabled: true,
    environment: [
      ...(existing.environment ?? []).filter((variable) => !replaced.has(variable.name)),
      ...route.environment,
    ],
    config: { ...config, ...route.config },
  };
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readHubKeys = Effect.fn("UsageLimitSources.readHubKeys")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return {
      managementKey: settingsSecretLiteral(resolved.managementKey),
      clientKey: settingsSecretLiteral(resolved.clientKey),
    };
  });
  const readManagementKey = (config: UsageLimitSourceConfig) =>
    readHubKeys(config).pipe(Effect.map((keys) => keys.managementKey));
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const readEnabledSource = Effect.fn("UsageLimitSources.readEnabledSource")(function* (
    sourceId: UsageLimitSourceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    return { config, managementKey };
  });

  const revealManagementKey = Effect.fn("UsageLimitSources.revealManagementKey")(function* (
    sourceId: UsageLimitSourceId,
  ) {
    return (yield* readEnabledSource(sourceId)).managementKey;
  });

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const { config, managementKey } = yield* readEnabledSource(input.sourceId);
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  const local = yield* makeCliproxyLocal;
  const random = yield* SecureRandom.SecureRandom;
  const localLock = yield* Semaphore.make(1);
  const localFailure = (reason: CliproxyLocalError["reason"]) => new CliproxyLocalError({ reason });

  const statusOf = Effect.fn("UsageLimitSources.statusOf")(function* (machine: CliproxyMachine) {
    const running = yield* api.isRunning(machine.url);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const connected = Object.entries(settings?.usageLimitSources ?? {}).find(
      ([, config]) => config.enabled && isLocalHub(config.url, machine.url),
    );
    return {
      url: machine.url,
      autoInstall: machine.brew !== null,
      installed: machine.installed || running,
      running,
      canSetNewKey: machine.brew !== null && machine.configPath !== null,
      ...(connected ? { sourceId: UsageLimitSourceId.make(connected[0]) } : {}),
    } satisfies CliproxyLocalStatus;
  });

  const localStatus = Effect.gen(function* () {
    return yield* statusOf(yield* local.detect());
  }).pipe(Effect.withSpan("UsageLimitSources.localStatus"));

  const newKey = random.randomBytes(32).pipe(Effect.map(Hex.encode), Effect.orDie);

  const waitUntilRunning = Effect.fn("UsageLimitSources.waitUntilRunning")(function* (url: string) {
    yield* api.isRunning(url).pipe(
      Effect.flatMap((running) =>
        running ? Effect.void : Effect.fail(localFailure("serviceDidNotStart")),
      ),
      Effect.retry({ times: 40, schedule: Schedule.spaced("500 millis") }),
    );
  });

  const verifyKey = Effect.fn("UsageLimitSources.verifyKey")(function* (
    url: string,
    managementKey: string,
  ) {
    const verdict = yield* api
      .checkKey({ url, managementKey })
      .pipe(Effect.orElseSucceed(() => "unreachable" as const));
    if (verdict === "accepted") return;
    return yield* localFailure(
      verdict === "unreachable"
        ? "notRunning"
        : verdict === "lockedOut"
          ? "lockedOut"
          : "keyRejected",
    );
  });

  const saveLocal = Effect.fn("UsageLimitSources.saveLocal")(
    function* (url: string, managementKey: string) {
      const settings = yield* settingsService.getSettings;
      const saved = Object.entries(settings.usageLimitSources).find(([, config]) =>
        isLocalHub(config.url, url),
      );
      const id = saved ? UsageLimitSourceId.make(saved[0]) : usageLimitSourceIdFromUrl(url);
      const clientKey = saved?.[1].clientKey;
      yield* settingsService.updateSettings({
        usageLimitSources: {
          [id]: {
            kind: "cliproxy",
            url,
            managementKey,
            enabled: true,
            ...(clientKey === undefined ? {} : { clientKey }),
          },
        },
      });
    },
    Effect.mapError(() => localFailure("saveFailed")),
  );

  const restartWithNewKey = Effect.fn("UsageLimitSources.restartWithNewKey")(function* (
    brew: string,
    configPath: string,
    url: string,
    localOnly: boolean,
  ) {
    const managementKey = yield* newKey;
    yield* local.writeSecretKey(configPath, managementKey, localOnly);
    yield* local.startService(brew);
    yield* waitUntilRunning(url);
    yield* verifyKey(url, managementKey).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.spaced("1 second"),
        while: (error) => error.reason !== "lockedOut",
      }),
    );
    yield* saveLocal(url, managementKey);
  });

  const installLocal = Effect.gen(function* () {
    const found = yield* local.detect();
    if (found.brew === null) return yield* localFailure("noHomebrew");
    const fresh = found.configPath === null;
    if (fresh) yield* local.install(found.brew);
    const machine = fresh ? yield* local.detect() : found;
    if (machine.configPath === null) return yield* localFailure("installFailed");
    if (fresh || !machine.secretKeySet) {
      yield* restartWithNewKey(found.brew, machine.configPath, machine.url, fresh);
    } else if (!(yield* api.isRunning(machine.url))) {
      yield* local.startService(found.brew);
      yield* waitUntilRunning(machine.url);
    }
    return yield* statusOf(machine);
  }).pipe(localLock.withPermits(1), Effect.withSpan("UsageLimitSources.installLocal"));

  const connectLocal = Effect.fn("UsageLimitSources.connectLocal")(function* (
    input: CliproxyConnectLocalInput,
  ) {
    const machine = yield* local.detect();
    if (!(yield* api.isRunning(machine.url))) return yield* localFailure("notRunning");
    yield* verifyKey(machine.url, input.managementKey);
    yield* saveLocal(machine.url, input.managementKey);
    return yield* statusOf(machine);
  }, localLock.withPermits(1));

  const setNewLocalKey = Effect.gen(function* () {
    const machine = yield* local.detect();
    if (machine.brew === null) return yield* localFailure("noHomebrew");
    if (machine.configPath === null) return yield* localFailure("configNotWritable");
    yield* restartWithNewKey(machine.brew, machine.configPath, machine.url, false);
    return yield* statusOf(machine);
  }).pipe(localLock.withPermits(1), Effect.withSpan("UsageLimitSources.setNewLocalKey"));

  const addLocalProviders = Effect.fn("UsageLimitSources.addLocalProviders")(function* (
    input: CliproxyAddProvidersInput,
  ) {
    const machine = yield* local.detect();
    if (!(yield* api.isRunning(machine.url))) return yield* localFailure("notRunning");
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => localFailure("saveFailed")),
    );
    const saved = Object.entries(settings.usageLimitSources).find(
      ([, config]) => config.enabled && isLocalHub(config.url, machine.url),
    );
    if (saved === undefined) return yield* localFailure("notConnected");
    const [id, config] = saved;
    const keys = yield* readHubKeys(config);
    if (keys.managementKey.length === 0) return yield* localFailure("notConnected");
    const clientKey = keys.clientKey || (yield* newKey);
    if (clientKey !== keys.clientKey) {
      yield* settingsService
        .updateSettings({ usageLimitSources: { [id]: { ...config, clientKey } } })
        .pipe(Effect.mapError(() => localFailure("saveFailed")));
    }
    yield* api
      .addClientKey({ url: machine.url, managementKey: keys.managementKey }, clientKey)
      .pipe(Effect.mapError(() => localFailure("clientKeyFailed")));
    const routes = proxyInstances(machine.url, clientKey, input);
    for (const route of routes) {
      yield* settingsService
        .updateProviderInstance({
          operation: "upsert",
          instanceId: route.instanceId,
          instance: withProxyRoute(settings.providerInstances[route.instanceId], route),
        })
        .pipe(Effect.mapError(() => localFailure("saveFailed")));
    }
    return {
      instances: routes.map(({ instanceId, driver }) => ({ instanceId, driver })),
    } satisfies CliproxyAddProvidersResult;
  }, localLock.withPermits(1));

  const disconnect = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    for (const instanceId of [CLIPROXY_CLAUDE_INSTANCE_ID, CLIPROXY_CODEX_INSTANCE_ID]) {
      if (settings.providerInstances[instanceId] === undefined) continue;
      yield* settingsService.updateProviderInstance({ operation: "remove", instanceId });
    }
    yield* settingsService.updateSettings({
      usageLimitSources: Object.fromEntries(
        Object.keys(settings.usageLimitSources).map((id) => [id, null]),
      ),
    });
  }).pipe(
    Effect.mapError(() => localFailure("saveFailed")),
    localLock.withPermits(1),
    Effect.withSpan("UsageLimitSources.disconnect"),
  );

  const layerScope = yield* Effect.scope;
  const refreshLater = refresh.pipe(Effect.forkIn(layerScope), Effect.asVoid);

  const hubFor = Effect.fn("UsageLimitSources.hubFor")(function* (sourceId: UsageLimitSourceId) {
    const { config, managementKey } = yield* readEnabledSource(sourceId).pipe(
      Effect.mapError(() => new CliproxyManageError({ reason: "notConnected" })),
    );
    return { url: config.url, managementKey };
  });

  const listAccounts = Effect.fn("UsageLimitSources.listAccounts")(function* (
    sourceId: UsageLimitSourceId,
  ) {
    return yield* api.listAccounts(yield* hubFor(sourceId));
  });

  const startSignIn = Effect.fn("UsageLimitSources.startSignIn")(function* (
    input: CliproxySignInStartInput,
  ) {
    return yield* api.startSignIn(yield* hubFor(input.sourceId), input.provider);
  });

  const signInStatus = Effect.fn("UsageLimitSources.signInStatus")(function* (
    input: CliproxySignInInput,
  ) {
    const status = yield* api.signInStatus(yield* hubFor(input.sourceId), input.state);
    if (status.status === "done") yield* refreshLater;
    return status;
  });

  const cancelSignIn = Effect.fn("UsageLimitSources.cancelSignIn")(function* (
    input: CliproxySignInInput,
  ) {
    yield* api.cancelSignIn(yield* hubFor(input.sourceId), input.state);
  });

  const removeAccount = Effect.fn("UsageLimitSources.removeAccount")(function* (
    input: CliproxyAccountInput,
  ) {
    yield* api.removeAccount(yield* hubFor(input.sourceId), input.name);
    yield* refreshLater;
  });

  const setAccountEnabled = Effect.fn("UsageLimitSources.setAccountEnabled")(function* (
    input: CliproxySetAccountEnabledInput,
  ) {
    yield* api.setAccountEnabled(yield* hubFor(input.sourceId), input.name, input.enabled);
    yield* refreshLater;
  });

  const routing = Effect.fn("UsageLimitSources.routing")(function* (sourceId: UsageLimitSourceId) {
    return yield* api.routing(yield* hubFor(sourceId));
  });

  const setRouting = Effect.fn("UsageLimitSources.setRouting")(function* (
    input: CliproxySetRoutingInput,
  ) {
    yield* api.setRouting(yield* hubFor(input.sourceId), input.strategy);
  });

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    localStatus,
    installLocal,
    connectLocal,
    setNewLocalKey,
    addLocalProviders,
    disconnect,
    revealManagementKey,
    listAccounts,
    startSignIn,
    signInStatus,
    cancelSignIn,
    removeAccount,
    setAccountEnabled,
    routing,
    setRouting,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide([SecretResolverLayer.layer, ProcessRunner.layer]),
);
