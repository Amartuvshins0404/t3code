// @effect-diagnostics globalTimers:off globalDate:off - The port is a Promise API for React and CLI callers, outside an Effect runtime.
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient, jwtClient } from "better-auth/client/plugins";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CloudTeams, createCloudTeams } from "./cloudTeams.ts";

export const DEFAULT_CLOUD_AUTH_URL = "https://auth.amartuvshin.com";
export const DEFAULT_CLOUD_RELAY_URL = "https://relay.amartuvshin.com";
const CLOUD_AUTH_DEVICE_CLIENT_ID = "t3-cli";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_SLOW_DOWN_MS = 5_000;
const IDENTITY_TOKEN_REFRESH_SKEW_MS = 60_000;
const SESSION_COOKIE_PATTERN = /(?:^|[\s,;])(?:__Secure-)?better-auth\.session_token=([^;,\s]+)/u;

export const CloudUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
});
export type CloudUser = typeof CloudUser.Type;

export const CloudOrganization = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  role: Schema.String,
});
export type CloudOrganization = typeof CloudOrganization.Type;

export const CloudStoredSession = Schema.Struct({
  token: Schema.String,
  user: CloudUser,
});
export type CloudStoredSession = typeof CloudStoredSession.Type;

const IdentityClaims = Schema.Struct({
  exp: Schema.Number,
  orgs: Schema.optionalKey(Schema.Array(CloudOrganization)),
});
const decodeIdentityClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdentityClaims));

export type CloudSignInMethod = "github" | "passkey";

export type CloudAuthState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "signedIn"; readonly user: CloudUser };

export class CloudAuthError extends Schema.TaggedError<CloudAuthError>()("CloudAuthError", {
  reason: Schema.Literals(["cancelled", "denied", "expired", "failed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const isCloudAuthError = Schema.is(CloudAuthError);

export interface CloudSessionStore {
  readonly read: () => Promise<CloudStoredSession | null>;
  readonly write: (session: CloudStoredSession | null) => Promise<void>;
}

export interface CloudDeviceVerification {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAtMillis: number;
}

export interface CloudSignInContext {
  readonly authUrl: string;
  readonly signal: AbortSignal;
  readonly signInWithDevice: (
    open: (verification: CloudDeviceVerification) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly socialAuthorizationUrl: (callbackUrl: string) => Promise<string>;
}

export interface CloudAuthPlatform {
  readonly store: CloudSessionStore;
  readonly signIn: (method: CloudSignInMethod, context: CloudSignInContext) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CloudAuth {
  readonly authUrl: string;
  readonly getState: () => CloudAuthState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly signIn: (
    method: CloudSignInMethod,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CloudUser>;
  readonly signOut: () => Promise<void>;
  readonly listOrganizations: () => Promise<ReadonlyArray<CloudOrganization>>;
  readonly getRelayIdentityToken: () => Promise<string | null>;
  readonly teams: CloudTeams;
}

function readServiceErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
}

export function normalizeCloudAuthUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  const isLoopback =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return url.protocol === "https:" || isLoopback ? url.origin : null;
}

export function readSessionTokenFromCallback(callbackUrl: string): string | null {
  if (!URL.canParse(callbackUrl)) return null;
  const cookie = new URL(callbackUrl).searchParams.get("cookie");
  const encoded = cookie?.match(SESSION_COOKIE_PATTERN)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function readCallbackError(callbackUrl: string): string | null {
  if (!URL.canParse(callbackUrl)) return null;
  return new URL(callbackUrl).searchParams.get("error");
}

function decodeClaims(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return Option.none();
  const json = Base64Url.decodeString(payload);
  return json._tag === "Success" ? decodeIdentityClaims(json.success) : Option.none();
}

function abortError(signal: AbortSignal) {
  return new CloudAuthError({
    reason: "cancelled",
    detail: "Sign-in was cancelled.",
    cause: signal.reason,
  });
}

function unreachable(cause: unknown): never {
  throw new CloudAuthError({
    reason: "failed",
    detail: "Could not reach the sign-in service.",
    cause,
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toCloudUser(user: {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly image?: string | null | undefined;
}): CloudUser {
  return { id: user.id, email: user.email, name: user.name, image: user.image ?? null };
}

export function createCloudAuth(input: {
  readonly authUrl: string;
  readonly platform: CloudAuthPlatform;
}): CloudAuth {
  const authUrl = input.authUrl.replace(/\/+$/u, "");
  const { platform } = input;
  const client = createAuthClient({
    baseURL: `${authUrl}/api/auth`,
    plugins: [deviceAuthorizationClient(), jwtClient()],
    fetchOptions: {
      credentials: "omit",
      ...(platform.fetch ? { customFetchImpl: platform.fetch } : {}),
    },
  });
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  let session: CloudStoredSession | null = null;
  let state: CloudAuthState = { status: "loading" };
  let identity: {
    readonly sessionToken: string;
    readonly token: string;
    readonly expiresAtMillis: number;
    readonly orgs: ReadonlyArray<CloudOrganization>;
  } | null = null;
  let pendingIdentity: Promise<string | null> | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: CloudAuthState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const adopt = async (next: CloudStoredSession | null) => {
    session = next;
    identity = null;
    await platform.store.write(next);
    setState(next ? { status: "signedIn", user: next.user } : { status: "signedOut" });
  };

  const fetchUser = async (token: string): Promise<CloudUser | null | undefined> => {
    const result = await client.getSession({ fetchOptions: bearer(token) }).catch(() => undefined);
    if (!result || (result.error && result.error.status !== 401)) return undefined;
    return result.data?.user ? toCloudUser(result.data.user) : null;
  };

  const loaded = platform.store
    .read()
    .catch(() => null)
    .then(async (stored) => {
      session = stored;
      setState(stored ? { status: "signedIn", user: stored.user } : { status: "signedOut" });
      if (!stored) return;
      const user = await fetchUser(stored.token);
      if (session?.token !== stored.token || user === undefined) return;
      await adopt(user ? { token: stored.token, user } : null);
    });

  const signInWithDevice = async (
    open: (verification: CloudDeviceVerification) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<string> => {
    const { data, error } = await client.device
      .code({ client_id: CLOUD_AUTH_DEVICE_CLIENT_ID })
      .catch(unreachable);
    if (error || !data) {
      throw new CloudAuthError({
        reason: "failed",
        detail: "Could not start sign-in.",
        cause: error,
      });
    }
    const expiresAtMillis = Date.now() + data.expires_in * 1_000;
    await open({
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete:
        data.verification_uri_complete ??
        `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`,
      expiresAtMillis,
    });
    let interval = data.interval === undefined ? DEVICE_DEFAULT_INTERVAL_MS : data.interval * 1_000;
    while (true) {
      await sleep(interval, signal);
      if (Date.now() >= expiresAtMillis) {
        throw new CloudAuthError({ reason: "expired", detail: "The sign-in code expired." });
      }
      const result = await client.device
        .token({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: data.device_code,
          client_id: CLOUD_AUTH_DEVICE_CLIENT_ID,
        })
        .catch(() => undefined);
      if (result?.data?.access_token) return result.data.access_token;
      const code = (result?.error as { readonly error?: unknown } | null | undefined)?.error;
      switch (code) {
        case "access_denied":
          throw new CloudAuthError({ reason: "denied", detail: "Sign-in was denied." });
        case "expired_token":
          throw new CloudAuthError({ reason: "expired", detail: "The sign-in code expired." });
        case "slow_down":
          interval += DEVICE_SLOW_DOWN_MS;
          continue;
        case "authorization_pending":
          continue;
        default:
          if (result?.error && result.error.status < 500) {
            throw new CloudAuthError({
              reason: "failed",
              detail: "Sign-in failed.",
              cause: result.error,
            });
          }
          interval += DEVICE_SLOW_DOWN_MS;
      }
    }
  };

  const socialAuthorizationUrl = async (callbackUrl: string) => {
    const { data, error } = await client.signIn
      .social({
        provider: "github",
        callbackURL: callbackUrl,
        errorCallbackURL: callbackUrl,
        disableRedirect: true,
      })
      .catch(unreachable);
    if (error || !data?.url) {
      throw new CloudAuthError({
        reason: "failed",
        detail: "Could not start GitHub sign-in.",
        cause: error,
      });
    }
    const proxy = new URL(`${authUrl}/api/auth/expo-authorization-proxy`);
    proxy.searchParams.set("authorizationURL", data.url);
    return proxy.toString();
  };

  const readIdentity = async (current: CloudStoredSession) => {
    const result = await client.token({ fetchOptions: bearer(current.token) });
    if (result.error?.status === 401) {
      if (session?.token === current.token) await adopt(null);
      return null;
    }
    const token = result.data?.token;
    const claims = token ? decodeClaims(token) : Option.none();
    if (!token || Option.isNone(claims)) {
      throw new CloudAuthError({
        reason: "failed",
        detail: "Could not get a T3 Connect identity token.",
        cause: result.error,
      });
    }
    if (session?.token === current.token) {
      identity = {
        sessionToken: current.token,
        token,
        expiresAtMillis: claims.value.exp * 1_000,
        orgs: claims.value.orgs ?? [],
      };
    }
    return token;
  };

  const getRelayIdentityToken = async (): Promise<string | null> => {
    await loaded;
    const current = session;
    if (!current) return null;
    if (
      identity?.sessionToken === current.token &&
      identity.expiresAtMillis - IDENTITY_TOKEN_REFRESH_SKEW_MS > Date.now()
    ) {
      return identity.token;
    }
    pendingIdentity ??= readIdentity(current).finally(() => {
      pendingIdentity = null;
    });
    return pendingIdentity;
  };

  const teams = createCloudTeams({
    request: async (path, init) => {
      await loaded;
      const current = session;
      if (!current) {
        throw new CloudAuthError({ reason: "denied", detail: "Sign in to use teams." });
      }
      const result = await client
        .$fetch<unknown>(path, {
          method: init.method,
          ...(init.query ? { query: init.query } : {}),
          ...(init.body ? { body: init.body } : {}),
          ...bearer(current.token),
        })
        .catch(unreachable);
      if (result.error) {
        if (result.error.status === 401 && session?.token === current.token) await adopt(null);
        throw new CloudAuthError({
          reason: result.error.status === 401 || result.error.status === 403 ? "denied" : "failed",
          detail: readServiceErrorMessage(result.error) ?? "The sign-in service refused that.",
          cause: result.error,
        });
      }
      return result.data;
    },
    organizations: async (fresh) => {
      if (fresh) identity = null;
      await getRelayIdentityToken();
      return identity?.orgs ?? [];
    },
    membershipChanged: () => {
      identity = null;
    },
  });

  return {
    authUrl,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signIn: (method, options) => {
      const controller = new AbortController();
      const forward = () => controller.abort(options?.signal?.reason);
      if (options?.signal?.aborted) forward();
      options?.signal?.addEventListener("abort", forward, { once: true });
      const { signal } = controller;
      return platform
        .signIn(method, {
          authUrl,
          signal,
          signInWithDevice: (open, extra) =>
            signInWithDevice(open, extra ? AbortSignal.any([signal, extra]) : signal),
          socialAuthorizationUrl,
        })
        .then(async (token) => {
          const user = await fetchUser(token);
          if (!user) {
            throw new CloudAuthError({ reason: "failed", detail: "Sign-in did not complete." });
          }
          await adopt({ token, user });
          return user;
        })
        .finally(() => options?.signal?.removeEventListener("abort", forward));
    },
    signOut: async () => {
      await loaded;
      const current = session;
      if (!current) return;
      await adopt(null);
      await client.signOut({ fetchOptions: bearer(current.token) }).catch(() => undefined);
    },
    listOrganizations: async () => {
      await getRelayIdentityToken();
      return identity?.orgs ?? [];
    },
    getRelayIdentityToken,
    teams,
  };
}

export interface CloudAuthSnapshot {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly userId: string | null;
  readonly user: CloudUser | null;
}

export function readCloudAuthSnapshot(state: CloudAuthState): CloudAuthSnapshot {
  switch (state.status) {
    case "loading":
      return { isLoaded: false, isSignedIn: undefined, userId: null, user: null };
    case "signedOut":
      return { isLoaded: true, isSignedIn: false, userId: null, user: null };
    case "signedIn":
      return { isLoaded: true, isSignedIn: true, userId: state.user.id, user: state.user };
  }
}

export function cloudAuthSource(auth: CloudAuth) {
  return {
    auth,
    addListener: (
      listener: (resources: { readonly user: CloudUser | null | undefined }) => void,
    ) => {
      const emit = () => {
        const state = auth.getState();
        listener({
          user:
            state.status === "loading"
              ? undefined
              : state.status === "signedIn"
                ? state.user
                : null,
        });
      };
      emit();
      return auth.subscribe(emit);
    },
  };
}

export type CloudAuthSource = ReturnType<typeof cloudAuthSource>;
