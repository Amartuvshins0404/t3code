const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const loadConfig = (env = process.env) => {
  const baseUrl = env.BETTER_AUTH_URL ?? "https://auth.amartuvshin.com";
  const githubClientId = env.GH_OAUTH_CLIENT_ID;
  const githubClientSecret = env.GH_OAUTH_CLIENT_SECRET;
  return {
    baseUrl,
    issuer: env.JWT_ISSUER ?? baseUrl,
    secret: required(env, "BETTER_AUTH_SECRET"),
    databaseUrl: required(env, "DATABASE_URL"),
    passkeyRpId: env.PASSKEY_RP_ID ?? "amartuvshin.com",
    port: Number(env.PORT ?? 3000),
    github:
      githubClientId && githubClientSecret
        ? { clientId: githubClientId, clientSecret: githubClientSecret }
        : undefined,
  };
};

export type Config = ReturnType<typeof loadConfig>;
