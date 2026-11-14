import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  AuthTeamMemberScopes,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type TeamMemberIdentity,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { HttpServerRequest } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

class TeamSurfaceTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.pullRequests)
  .add(
    HttpApiGroup.make("voice").add(
      HttpApiEndpoint.get("status", "/api/voice/status").middleware(EnvironmentAuthenticatedAuth),
    ),
  ) {}

const reached = () => Effect.die("handler reached");
const layerTeamSurfaceStubs = Layer.mergeAll(
  HttpApiBuilder.group(TeamSurfaceTestApi, "orchestration", (handlers) =>
    handlers
      .handle("shellSnapshot", reached)
      .handle("threadSnapshot", reached)
      .handle("threadTranscript", reached)
      .handle("threadBoundedSnapshot", reached)
      .handle("threadHistoryPage", reached),
  ),
  HttpApiBuilder.group(TeamSurfaceTestApi, "projects", (handlers) =>
    handlers.handle("snapshot", reached).handle("mutate", reached),
  ),
  HttpApiBuilder.group(TeamSurfaceTestApi, "pullRequests", (handlers) =>
    handlers.handle("diff", reached),
  ),
  HttpApiBuilder.group(TeamSurfaceTestApi, "voice", (handlers) =>
    handlers.handle("status", reached),
  ),
);

it.effect("keeps a teammate session to the rpc socket and the shared-thread reads", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(layerEnvironmentAuth);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const routes = HttpApiBuilder.layer(TeamSurfaceTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(layerTeamSurfaceStubs),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(layerConfig),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
    const requestContext = Context.make(
      SecureRandom.SecureRandom,
      yield* SecureRandom.SecureRandom,
    ).pipe(
      Context.add(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeedNone,
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.die("Not used by these routes."),
          remove: () => Effect.void,
        }),
      ),
    );
    const handler = (request: Request) => web.handler(request, requestContext);

    const accessToken = Effect.fn(function* (member?: TeamMemberIdentity) {
      const link = yield* auth
        .createPairingLink({
          scopes: AuthTeamMemberScopes,
          subject: member === undefined ? "owner-client" : EnvironmentAuth.TEAM_MEMBER_SUBJECT,
          ...(member === undefined ? {} : { member }),
        })
        .pipe(TestClock.withLive);
      const response = yield* Effect.promise(() =>
        handler(
          new Request("http://127.0.0.1/oauth/token", {
            method: "POST",
            body: new URLSearchParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: link.credential,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
            }),
          }),
        ),
      );
      expect(response.status).toBe(200);
      return ((yield* Effect.promise(() => response.json())) as { access_token: string })
        .access_token;
    });
    const teammate = yield* accessToken({
      userId: "user-ana",
      name: "Ana",
      organizationId: "org-a",
      organizationSlug: "team-a",
      role: "member",
    });
    const owner = yield* accessToken();

    const send = (token: string, method: "GET" | "POST", path: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://127.0.0.1${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: encodeJson(body) }),
          }),
        ).then((response) => response.status),
      );
    const threadPath = "/api/orchestration/threads/thread-1";
    const routesToTry = [
      ["GET", "/api/projects"],
      ["POST", "/api/pull-requests/diff", { cwd: "/repo", number: 1 }],
      ["GET", "/api/voice/status"],
      ["GET", `${threadPath}/transcript`],
      ["POST", "/api/auth/websocket-ticket/media"],
      ["POST", "/api/auth/pairing-token", { scopes: ["orchestration:read"] }],
    ] as const;
    for (const [method, path, body] of routesToTry) {
      expect([path, yield* send(teammate, method, path, body)]).toEqual([path, 401]);
      expect([path, yield* send(owner, method, path, body)]).not.toEqual([path, 401]);
    }
    for (const path of [
      "/api/orchestration/shell",
      threadPath,
      `${threadPath}/bounded`,
      `${threadPath}/history?cursor=x`,
    ]) {
      expect([path, yield* send(teammate, "GET", path)]).toEqual([path, 500]);
    }
    expect(yield* send(teammate, "POST", "/api/auth/websocket-ticket/rpc")).toBe(200);

    const upgrade = (token: string, use: "rpc" | "media") =>
      auth
        .authenticateWebSocketUpgrade(
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/ws", { headers: { authorization: `Bearer ${token}` } }),
          ),
          use,
        )
        .pipe(
          Effect.as("open"),
          Effect.orElseSucceed(() => "refused"),
        );
    expect(yield* upgrade(teammate, "media")).toBe("refused");
    expect(yield* upgrade(teammate, "rpc")).toBe("open");
    expect(yield* upgrade(owner, "media")).toBe("open");
    expect(
      yield* auth
        .authenticateHttpRequest(
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/api/observability/v1/traces", {
              headers: { authorization: `Bearer ${teammate}` },
            }),
          ),
        )
        .pipe(
          Effect.as("open"),
          Effect.orElseSucceed(() => "refused"),
        ),
    ).toBe("refused");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
