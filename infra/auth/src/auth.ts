import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, jwt, oauthPopup, organization } from "better-auth/plugins";
import pg from "pg";

import type { Config } from "./config.ts";

const CLI_CLIENT_ID = "t3-cli";
const JWT_AUDIENCE = "t3-relay";

export const createAuth = (config: Config, pool: pg.Pool) => {
  const organizationsOf = async (userId: string) => {
    const { rows } = await pool.query<{ id: string; slug: string; role: string }>(
      `select o.id, o.slug, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by m."createdAt"`,
      [userId],
    );
    return rows.map(({ id, slug, role }) => ({ id, slug, role }));
  };

  return betterAuth({
    appName: "T3 Code",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: [
      "t3code://",
      "t3code-dev://",
      "amaraa-mode://",
      "amaraa-mode-dev://",
      "http://localhost:*",
      "http://127.0.0.1:*",
      "https://*.amartuvshin.com",
      config.baseUrl,
    ],
    emailAndPassword: { enabled: false },
    socialProviders: config.github ? { github: config.github } : {},
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      organization(),
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
        jwt: {
          issuer: config.issuer,
          audience: JWT_AUDIENCE,
          expirationTime: "15m",
          definePayload: async ({ user }) => ({
            email: user.email,
            name: user.name,
            orgs: await organizationsOf(user.id),
          }),
        },
      }),
      deviceAuthorization({
        verificationUri: "/device",
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      passkey({
        rpID: config.passkeyRpId,
        rpName: "T3 Code",
        origin: config.baseUrl,
      }),
      bearer(),
      oauthPopup(),
      expo(),
    ],
  });
};
