import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import pg from "pg";
import { expect, it, vi } from "vite-plus/test";

import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./migrate.ts";

const ISSUER = "https://auth.amartuvshin.com";
const BASE_URL = "http://localhost:3000";
const START = Date.parse("2026-01-01T00:00:00Z");

const startAuth = async () => {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
  await server.start();
  const address = server.getServerConn();
  const pool = new pg.Pool({ connectionString: `postgres://postgres@${address}/postgres`, max: 1 });
  await migrate(pool);
  const config = loadConfig({
    BETTER_AUTH_URL: BASE_URL,
    JWT_ISSUER: ISSUER,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    DATABASE_URL: "unused",
  });
  const auth = createAuth(config, pool);
  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", BASE_URL);
    if (init.body) headers.set("content-type", "application/json");
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, { ...init, headers }),
    );
    return { status: response.status, body: await response.json() };
  };
  const signIn = async (email: string, name: string) => {
    const userId = crypto.randomUUID();
    const token = crypto.randomUUID().replaceAll("-", "");
    await pool.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1, $2, $3, true)`,
      [userId, name, email],
    );
    await pool.query(
      `insert into session (id, token, "userId", "expiresAt", "updatedAt") values ($1, $2, $3, now() + interval '1 day', now())`,
      [crypto.randomUUID(), token, userId],
    );
    return { userId, token };
  };
  const verify = async (jwt: string) => {
    const jwks = createLocalJWKSet((await call("/jwks")).body);
    return jwtVerify(jwt, jwks, { issuer: ISSUER, audience: "t3-relay" });
  };
  return {
    call,
    signIn,
    verify,
    [Symbol.asyncDispose]: async () => {
      await pool.end();
      await server.stop();
      await db.close();
    },
  };
};

it("mints a relay JWT that verifies against the JWKS and carries the user's organizations", async () => {
  await using service = await startAuth();
  const { userId, token } = await service.signIn("ada@example.com", "Ada");
  const created = await service.call("/organization/create", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "Analytical", slug: "analytical" }),
  });
  expect(created.status).toBe(200);

  const { body } = await service.call("/token", { token });
  const { payload } = await service.verify(body.token);

  expect(decodeProtectedHeader(body.token).alg).toBe("EdDSA");
  expect(payload).toMatchObject({
    iss: ISSUER,
    aud: "t3-relay",
    sub: userId,
    email: "ada@example.com",
    name: "Ada",
    orgs: [{ id: created.body.id, slug: "analytical", role: "owner" }],
  });
  expect(payload.exp! - payload.iat!).toBe(15 * 60);
});

it("lets the t3-cli device grant end in a bearer token that mints the relay JWT", async () => {
  await using service = await startAuth();
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };

  const rejected = await service.call("/device/code", {
    method: "POST",
    body: JSON.stringify({ client_id: "other" }),
  });
  expect(rejected.body.error).toBe("invalid_client");

  const { body: grant } = await service.call("/device/code", {
    method: "POST",
    body: JSON.stringify({ client_id: "t3-cli" }),
  });
  const poll = () =>
    service.call("/device/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: grant.device_code,
        client_id: "t3-cli",
      }),
    });
  expect((await poll()).body.error).toBe("authorization_pending");

  const { userId, token } = await service.signIn("grace@example.com", "Grace");
  await service.call(`/device?user_code=${grant.user_code}`, { token });
  const approved = await service.call("/device/approve", {
    method: "POST",
    token,
    body: JSON.stringify({ userCode: grant.user_code }),
  });
  expect(approved.status).toBe(200);

  vi.setSystemTime(START + 6_000);
  const issued = await poll();
  expect(issued.body.token_type).toBe("Bearer");
  const { body } = await service.call("/token", { token: issued.body.access_token });
  const { payload } = await service.verify(body.token);
  expect(payload).toMatchObject({ sub: userId, email: "grace@example.com", orgs: [] });
});
