// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as IpNetwork from "effect/net/IpNetwork";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

import { RelayApi } from "@t3tools/contracts/relay";

import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as CloudMintSigner from "./auth/CloudMintSigner.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as Identity from "./auth/identity.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as RelayConfiguration from "./Config.ts";
import * as RelayDb from "./db.ts";
import * as CloudflareApiPause from "./environments/CloudflareApiPause.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as RelayHttpApi from "./http/Api.ts";
import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import * as MobileTelemetry from "./mobileTelemetry/MobileTelemetry.ts";
import * as CloudflareApi from "./node/CloudflareApi.ts";
import * as Database from "./node/Database.ts";
import * as Observability from "./spanAttributes.ts";
import * as WebCrypto from "./WebCrypto.ts";

const layerPlatform = Layer.mergeAll(
  Digest.layerWebCrypto,
  Mac.layerWebCrypto,
  Signature.layerWebCrypto,
  FetchHttpClient.layer,
  Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const loadSettings = Effect.gen(function* () {
  const relayIssuer = yield* Config.NonEmptyString("RELAY_PUBLIC_URL");
  const signingPrivateKey = yield* Config.Redacted("RELAY_SIGNING_PRIVATE_KEY");
  const legacyTunnelGraceMinutes = Option.getOrUndefined(
    yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
  );
  const managedTunnelLimit = Option.getOrUndefined(
    yield* RelayConfiguration.managedTunnelLimitConfig,
  );
  return RelayConfiguration.RelayConfiguration.of({
    relayIssuer,
    apns: null,
    apnsDeliveryJobSigningSecret: Redacted.make(NodeCrypto.randomBytes(32).toString("hex")),
    identity: yield* RelayConfiguration.identitySettingsConfig,
    cloudMintPrivateKey: signingPrivateKey,
    cloudMintPublicKey: NodeCrypto.createPublicKey(
      Redacted.value(signingPrivateKey).replace(/\\n/gu, "\n"),
    )
      .export({ type: "spki", format: "pem" })
      .toString(),
    managedEndpointBaseDomain: yield* Config.NonEmptyString("RELAY_TUNNEL_ZONE_NAME"),
    managedEndpointNamespace: yield* Config.NonEmptyString("RELAY_TUNNEL_NAMESPACE").pipe(
      Config.withDefault("t3"),
    ),
    managedEndpointCleanupMode: yield* RelayConfiguration.managedEndpointCleanupModeConfig,
    legacyManagedEndpointCleanupMode:
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig,
    ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
    ...(managedTunnelLimit === undefined ? {} : { managedTunnelLimit }),
  });
});

const layerPushDisabled = Layer.mergeAll(
  Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
    send: Effect.fn("ApnsDeliveryQueueSender.send")(function* () {
      yield* Effect.logWarning("Dropped APNs delivery: push is disabled on this relay");
    }),
  }),
  Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
    send: Effect.fn("FcmDeliveryQueueSender.send")(function* () {
      yield* Effect.logWarning("Dropped FCM delivery: push is disabled on this relay");
    }),
  }),
);

const layerHookInboxDisabled = Layer.succeed(HookInbox.HookInbox, {
  hold: Effect.fn("HookInbox.hold")(function* () {
    return yield* Effect.succeed(false);
  }),
  wake: Effect.fn("HookInbox.wake")(function* () {
    return yield* Effect.succeed(false);
  }),
  clear: Effect.fn("HookInbox.clear")(function* () {
    yield* Effect.void;
  }),
});

const fixedWindowLimiter = (limit: number, periodSeconds: number) => {
  const windows = new Map<string, { readonly startedAt: number; count: number }>();
  return (key: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const window = windows.get(key);
      if (!window || now - window.startedAt >= periodSeconds * 1_000) {
        if (windows.size > 10_000) windows.clear();
        windows.set(key, { startedAt: now, count: 1 });
        return true;
      }
      window.count += 1;
      return window.count <= limit;
    });
};

const layerHookRateLimiter = Layer.sync(HookForwarder.HookRateLimiter, () => ({
  allowHook: fixedWindowLimiter(
    HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
    HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
  ),
  allowEndpoint: fixedWindowLimiter(
    HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
    HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
  ),
}));

const layerMobileTelemetryDisabled = Layer.succeed(MobileTelemetry.MobileTelemetry, {
  handle: Effect.fn("MobileTelemetry.handle")(function* () {
    return yield* Effect.succeed(HttpServerResponse.empty({ status: 204 }));
  }),
});

const layerRuntime = Layer.empty.pipe(
  Layer.provideMerge(MobileRegistrations.layer),
  Layer.provideMerge(AgentActivityPublisher.layer),
  Layer.provideMerge(EnvironmentConnector.layer),
  Layer.provideMerge(EnvironmentLinker.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      EnvironmentPublishSignatures.layer,
      ManagedEndpointReaper.layer,
      HeldHooks.layer,
    ),
  ),
  Layer.provideMerge(CloudflareApi.layer),
  Layer.provideMerge(DpopProofs.layer),
  Layer.provideMerge(ApnsDeliveries.layer),
  Layer.provideMerge(
    FcmDeliveries.layer.pipe(
      Layer.provideMerge(FcmClient.layer.pipe(Layer.provide(FcmAssertionSigner.layer))),
    ),
  ),
  Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
  Layer.provideMerge(ApnsDeliveryQueue.layer),
  Layer.provideMerge(layerPushDisabled),
  Layer.provideMerge(
    Layer.mergeAll(AgentActivityRows.layer, Devices.layer, layerHookInboxDisabled),
  ),
  Layer.provideMerge(EnvironmentCredentials.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudflareApiPause.layer,
      EnvironmentLinks.layer,
      ManagedEndpointAllocations.layer,
      ManagedTunnelLimits.layer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(LiveActivities.layer, DeliveryAttempts.layer, Identity.layer)),
  Layer.provideMerge(RelayTokens.layer.pipe(Layer.provideMerge(CloudMintSigner.layer))),
  Layer.provideMerge(RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(Database.layer))),
  Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
  Layer.provideMerge(layerPlatform),
);

const logFailure = (message: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(message, { cause }),
  );

const layerMaintenance = Layer.effectDiscard(
  Effect.all(
    [
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.andThen(
          DeliveryAttempts.DeliveryAttempts.pipe(
            Effect.flatMap((attempts) => attempts.pruneExpired),
          ),
        ),
        logFailure("Failed to prune expired relay state"),
      ),
      ManagedEndpointReaper.ManagedEndpointReaper.pipe(
        Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
        Effect.tap((result) =>
          result.scanned > 0
            ? Effect.logInfo("Finished managed tunnel cleanup", result)
            : Effect.void,
        ),
        logFailure("Failed to clean up inactive managed tunnels"),
      ),
      AgentActivityPublisher.AgentActivityPublisher.pipe(
        Effect.flatMap((publisher) => publisher.endIdleLiveActivities),
        logFailure("Failed to end idle Live Activities"),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(
    Effect.withSpan("relay.cron.prune_expired_state"),
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.forkScoped,
  ),
);

const layerApp = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
  HookForwarder.layerApi.pipe(
    Layer.provide(HookForwarder.layer),
    Layer.provide(layerHookRateLimiter),
  ),
  MobileTelemetry.layerApi.pipe(Layer.provide(layerMobileTelemetryDisabled)),
).pipe(
  Layer.provideMerge(RelayHttpApi.layerClientAuth),
  Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
  Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
);

const PRIVATE_NETWORKS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
].map(IpNetwork.fromStringUnsafe);

const layerHttp = Layer.unwrap(
  Effect.gen(function* () {
    const httpEffect = yield* Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(layerApp),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        RelayHttpApi.layerDocsRedirectRoute,
      ).pipe(Layer.provide(RelayHttpApi.layerCors)),
      RelayHttpApi.layerNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
      withoutCapturedParentSpan,
    );
    return HttpServer.serve(
      traceRelayHttpRequestWith(httpEffect, Layer.empty).pipe(
        Observability.withSchemaErrorSpanAttributes,
        HttpMiddleware.xForwardedHeaders({ trustedProxies: PRIVATE_NETWORKS }),
      ),
    );
  }),
);

const layerServer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787));
    const host = yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0"));
    return NodeHttpServer.layer(NodeHttp.createServer, { host, port });
  }),
);

Layer.mergeAll(layerHttp, layerMaintenance).pipe(
  Layer.provide(layerRuntime),
  Layer.provide(layerServer),
  Layer.launch,
  NodeRuntime.runMain,
);
