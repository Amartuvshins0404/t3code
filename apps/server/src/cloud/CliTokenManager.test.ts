// @effect-diagnostics nodeBuiltinImport:off - The CLI signs in against a fake auth service over real loopback HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const SESSION_TOKEN = "session-token.signature";

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const identityJwt = [
  base64Url({ alg: "EdDSA", typ: "JWT" }),
  base64Url({ sub: "user-1", aud: "t3-relay", exp: 4_102_444_800, orgs: [] }),
  "signature",
].join(".");

const startFakeAuth = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly server: NodeHttp.Server;
        readonly url: string;
        readonly log: string[];
      }>((resolve) => {
        const log: string[] = [];
        let polls = 0;
        const server = NodeHttp.createServer((request, response) => {
          const send = (status: number, body: object) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          const bearer = request.headers.authorization === `Bearer ${SESSION_TOKEN}`;
          log.push(`${request.method} ${path}${bearer ? " bearer" : ""}`);
          request.resume();
          request.on("end", () => {
            if (path === "/api/auth/device/code") {
              return send(200, {
                device_code: "device-1",
                user_code: "ABCD1234",
                verification_uri: "http://127.0.0.1/device",
                verification_uri_complete: "http://127.0.0.1/device?user_code=ABCD1234",
                expires_in: 600,
                interval: 0,
              });
            }
            if (path === "/api/auth/device/token") {
              polls += 1;
              return polls === 1
                ? send(400, { error: "authorization_pending" })
                : send(200, { access_token: SESSION_TOKEN, token_type: "Bearer" });
            }
            if (path === "/api/auth/get-session" && bearer) {
              return send(200, {
                session: { id: "session-1", userId: "user-1" },
                user: { id: "user-1", email: "lin@example.com", name: "Lin", image: null },
              });
            }
            if (path === "/api/auth/token" && bearer) return send(200, { token: identityJwt });
            send(401, { message: "Unauthorized" });
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as NodeNet.AddressInfo;
          resolve({ server, url: `http://127.0.0.1:${port}`, log });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

const memorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  const unused = () => Effect.die("unused");
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: unused,
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  return { store, values };
};

it.live(
  "device login stores the session and serves the relay identity JWT as the CLI credential",
  () =>
    Effect.gen(function* () {
      const auth = yield* startFakeAuth;
      const secrets = memorySecrets();
      const opened: string[] = [];
      const prompts: string[] = [];
      const layer = Layer.merge(
        CliTokenManager.layer.pipe(
          Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store)),
          Layer.provide(
            Layer.succeed(ExternalLauncher.ExternalLauncher, {
              resolveAvailableEditors: () => Effect.succeed([]),
              resolveFileManagerRevealKind: () => Effect.undefined,
              launchEditor: () => Effect.void,
              launchBrowser: (target) => Effect.sync(() => void opened.push(target)),
            }),
          ),
        ),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_AUTH_URL: auth.url } })),
      );

      const credential = yield* Effect.gen(function* () {
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const signedIn = yield* tokens.login({
          showPrompt: (prompt) => Effect.sync(() => void prompts.push(prompt.userCode)),
          openBrowser: true,
        });
        assert.isTrue(yield* tokens.hasCredential);
        return { signedIn, existing: yield* tokens.getExisting };
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(credential.signedIn, {
        accessToken: identityJwt,
        identity: "lin@example.com",
      });
      assert.deepStrictEqual(credential.existing, Option.some(credential.signedIn));
      assert.deepStrictEqual(prompts, ["ABCD1234"]);
      assert.deepStrictEqual(opened, ["http://127.0.0.1/device?user_code=ABCD1234"]);
      assert.include(auth.log, "GET /api/auth/token bearer");
      assert.isTrue(secrets.values.has("cloud-cli-session"));
    }).pipe(Effect.scoped),
);
