import { AuthStandardClientScopes, AuthTeamMemberScopes, EnvironmentId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import { RELAY_MINT_REQUEST_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as EnvironmentKeys from "./environmentKeys.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const encode = (value: string) => new TextEncoder().encode(value);

const withService = <A, E>(
  options: {
    readonly failHoldWrite?: boolean;
    readonly failActivityWrite?: boolean;
    readonly relayFails?: boolean;
    readonly failActivityRead?: boolean;
    readonly failHoldRead?: boolean;
    readonly holdFirstRelayCall?: {
      readonly started: () => void;
      readonly released: Promise<void>;
    };
  },
  body: (input: {
    readonly preferences: { readonly update: CloudLink.CloudLink["Service"]["updatePreferences"] };
    readonly stored: Map<string, Uint8Array>;
    readonly relayCalls: Array<boolean>;
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, encode("https://relay.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential")],
      [HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, encode("false")],
      [PUBLISH_AGENT_ACTIVITY_SECRET, encode("false")],
    ]);
    const relayCalls: Array<boolean> = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { holdWebhooksWhileOffline: boolean };
        relayCalls.push(payload.holdWebhooksWhileOffline);
        if (relayCalls.length === 1 && options.holdFirstRelayCall) {
          options.holdFirstRelayCall.started();
          return options.holdFirstRelayCall.released.then(() => Response.json(payload));
        }
        return options.relayFails
          ? Promise.resolve(new Response("unavailable", { status: 503 }))
          : Promise.resolve(Response.json(payload));
      },
      { preconnect: () => {} },
    );
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          (options.failActivityRead && name === PUBLISH_AGENT_ACTIVITY_SECRET) ||
          (options.failHoldRead && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: name,
                  cause: new Error("busy"),
                }),
              )
            : Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) =>
          (options.failHoldWrite && name === HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET) ||
          (options.failActivityWrite && name === PUBLISH_AGENT_ACTIVITY_SECRET)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: new Error("read-only"),
                }),
              )
            : Effect.sync(() => void stored.set(name, value)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ requestCatchUp: () => Effect.void }),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      ManagedPolicy.layerTest(),
      Layer.mock(ConnectReachability.ConnectReachability)({
        latest: Effect.succeedNone,
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
      PlatformNodeCrypto.layer,
    );
    return yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      return yield* body({ preferences: { update: link.updatePreferences }, stored, relayCalls });
    }).pipe(
      Effect.provide(
        CloudLink.layer.pipe(
          // These tests never sign proofs; the mocked secret store cannot create a key pair.
          Layer.provide(Layer.mock(EnvironmentKeys.EnvironmentSigningKey)({ publicKey: "" })),
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

it.effect("tells the relay before saving the hold setting locally", () =>
  withService({}, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      yield* preferences.update({ publishAgentActivity: true, holdWebhooksWhileOffline: true });
      assert.deepEqual(relayCalls, [true]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  ),
);

it.effect("puts the relay back when the local save fails", () =>
  withService({ failHoldWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, [true, false]);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("leaves the relay untouched when the activity setting can't be saved", () =>
  withService({ failActivityWrite: true }, ({ preferences, stored, relayCalls }) =>
    Effect.gen(function* () {
      const error = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "CloudLinkInternalError",
        operation: "persist-preferences",
      });
      assert.deepEqual(relayCalls, []);
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("keeps both settings unchanged when the relay refuses the hold change", () =>
  withService({ relayFails: true }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  ),
);

it.effect("two overlapping updates are applied one after the other", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstAtRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const first = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstAtRelay);
      const second = yield* preferences
        .update({ publishAgentActivity: false, holdWebhooksWhileOffline: false })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "false");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "false",
      );
    }),
  );
});

it.effect("an update the client walks away from still finishes", () => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRelay = new Promise<void>((resolve) => {
    started = resolve;
  });
  return withService({ holdFirstRelayCall: { started, released } }, ({ preferences, stored }) =>
    Effect.gen(function* () {
      const update = yield* preferences
        .update({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => atRelay);
      const interrupted = yield* Fiber.interrupt(update).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      release();
      yield* Fiber.join(interrupted);
      assert.equal(new TextDecoder().decode(stored.get(PUBLISH_AGENT_ACTIVITY_SECRET)), "true");
      assert.equal(
        new TextDecoder().decode(stored.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET)),
        "true",
      );
    }),
  );
});

it.effect("unlinks on startup and refuses to link when the policy turns Connect off", () =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [CLOUD_LINKED_USER_ID, encode("user-1")],
      [RELAY_URL_SECRET, encode("https://relay.test")],
    ]);
    const appliedConfigs: Array<unknown> = [];
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
        withLinkStateLock: (effect) => effect,
        applyConfig: (config) =>
          Effect.sync(() => {
            appliedConfigs.push(config);
            return { status: "disabled" as const };
          }),
      }),
      ManagedPolicy.layerTest({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { connect: false },
      }),
      Layer.mock(ConnectReachability.ConnectReachability)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
      PlatformNodeCrypto.layer,
    );
    yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      assert.isFalse(stored.has(CLOUD_LINKED_USER_ID));
      assert.deepEqual(appliedConfigs, [null]);

      const applyError = yield* link.applyRelayConfig({} as never).pipe(Effect.flip);
      const mintError = yield* link.mintCredential({} as never).pipe(Effect.flip);
      assert.equal(applyError.message, "Example Corp's policy does not allow T3 Connect.");
      assert.equal(mintError._tag, "ManagedPolicyRefusedError");
    }).pipe(
      Effect.provide(
        CloudLink.layer.pipe(
          // These tests never sign proofs; the mocked secret store cannot create a key pair.
          Layer.provide(Layer.mock(EnvironmentKeys.EnvironmentSigningKey)({ publicKey: "" })),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  }),
);

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const mintEnvironmentId = EnvironmentId.make("environment-1");
const relayIssuer = "https://relay.test";
const teamMember = {
  userId: "teammate-1",
  name: "Ada",
  organizationId: "org-shared",
  organizationSlug: "analytical",
  role: "member" as const,
};

const mintWith = (proof: {
  readonly sub: string;
  readonly nonce: string;
  readonly member?: typeof teamMember;
}) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>([
      [CLOUD_LINKED_USER_ID, encode("owner-1")],
      [CLOUD_MINT_PUBLIC_KEY, encode(mintKeys.publicKey)],
      [RELAY_ISSUER_SECRET, encode(relayIssuer)],
      ["team-shared-organizations", encode(JSON.stringify(["org-shared"]))],
    ]);
    const issued: Array<
      Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0]
    > = [];
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const token = yield* signRelayJwt({
      privateKey: mintKeys.privateKey,
      typ: RELAY_MINT_REQUEST_TYP,
      payload: {
        iss: relayIssuer,
        aud: `t3-env:${mintEnvironmentId}`,
        sub: proof.sub,
        jti: `jti-${proof.nonce}`,
        iat: now,
        exp: now + 60,
        environmentId: mintEnvironmentId,
        clientProofKeyThumbprint: "thumbprint",
        cnf: { jkt: "thumbprint" },
        nonce: proof.nonce,
        scope: ["environment:connect"],
        ...(proof.member === undefined ? {} : { member: proof.member }),
      },
    }).pipe(Effect.provide(PlatformNodeCrypto.layerSignature));
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(mintEnvironmentId),
      }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      ManagedPolicy.layerTest(),
      Layer.mock(ConnectReachability.ConnectReachability)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        createPairingLink: (input) =>
          Effect.sync(() => {
            issued.push(input);
            return {
              id: "link-1",
              credential: "credential-1",
              scopes: input?.scopes ?? [],
              subject: input?.subject ?? "one-time-token",
              createdAt: DateTime.makeUnsafe(0),
              expiresAt: DateTime.makeUnsafe(120_000),
            };
          }),
      }),
      Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServerConfig.ServerConfig)({} as ServerConfig.ServerConfig["Service"]),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
      NodeServices.layer,
      PlatformNodeCrypto.layer,
    );
    const outcome = yield* Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      return yield* link.mintCredential({ proof: token }).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        CloudLink.layer.pipe(
          Layer.provide(
            Layer.mock(EnvironmentKeys.EnvironmentSigningKey)({
              publicKey: "",
              sign: () => Effect.succeed("response-proof"),
            }),
          ),
          Layer.provide(layerDependencies),
        ),
      ),
    );
    return { outcome, issued };
  });

it.effect("still mints the owner's full session through the relay", () =>
  Effect.gen(function* () {
    const { outcome, issued } = yield* mintWith({ sub: "owner-1", nonce: "owner" });
    assert.isTrue(Result.isSuccess(outcome));
    assert.deepInclude(issued[0], { subject: "cloud-connect", scopes: AuthStandardClientScopes });
    assert.isUndefined(issued[0]?.member);
  }),
);

it.effect("mints a small teammate session only for a team this machine is shared with", () =>
  Effect.gen(function* () {
    const shared = yield* mintWith({ sub: "teammate-1", nonce: "shared", member: teamMember });
    assert.isTrue(Result.isSuccess(shared.outcome));
    assert.deepInclude(shared.issued[0], {
      subject: "team-member",
      scopes: AuthTeamMemberScopes,
      member: teamMember,
    });

    const otherTeam = yield* mintWith({
      sub: "teammate-1",
      nonce: "other-team",
      member: { ...teamMember, organizationId: "org-not-shared" },
    });
    assert.isTrue(Result.isFailure(otherTeam.outcome));
    assert.deepEqual(otherTeam.issued, []);

    const someoneElse = yield* mintWith({ sub: "stranger-1", nonce: "spoof", member: teamMember });
    assert.isTrue(Result.isFailure(someoneElse.outcome));
    assert.deepEqual(someoneElse.issued, []);

    const noMember = yield* mintWith({ sub: "teammate-1", nonce: "no-member" });
    assert.isTrue(Result.isFailure(noMember.outcome));
    assert.deepEqual(noMember.issued, []);
  }),
);
