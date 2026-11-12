import {
  type CloudAuth,
  CloudAuthError,
  type CloudAuthPlatform,
  type CloudAuthState,
  type CloudSessionStore,
  CloudStoredSession,
  type CloudUser,
  createCloudAuth,
  readCallbackError,
  readSessionTokenFromCallback,
} from "@t3tools/client-runtime/cloud-auth";
import { CLOUD_AUTH_APP_LINK_HOST, isCloudAuthAppLink } from "@t3tools/shared/remote";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { resolveCloudPublicConfig } from "./publicConfig";

const SESSION_STORAGE_KEY = "t3code:cloud-auth-session";
const POPUP_MESSAGE_TYPE = "better-auth:oauth-popup";
const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 640;
const POPUP_CLOSED_POLL_MS = 500;

const StoredSessionJson = Schema.fromJsonString(CloudStoredSession);
const decodeStoredSession = Schema.decodeUnknownOption(StoredSessionJson);
const encodeStoredSession = Schema.encodeSync(StoredSessionJson);

const localSessionStore: CloudSessionStore = {
  read: async () => {
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? Option.getOrNull(decodeStoredSession(raw)) : null;
    } catch {
      return null;
    }
  },
  write: async (session) => {
    try {
      if (session) window.localStorage.setItem(SESSION_STORAGE_KEY, encodeStoredSession(session));
      else window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  },
};

const cancelled = (signal: AbortSignal) =>
  new CloudAuthError({
    reason: "cancelled",
    detail: "Sign-in was cancelled.",
    cause: signal.reason,
  });

function popupFeatures() {
  const left = window.screenX + (window.outerWidth - POPUP_WIDTH) / 2;
  const top = window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2;
  return `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`;
}

function openPopup(url: string) {
  const popup = window.open(url, "t3-connect-sign-in", popupFeatures());
  if (!popup) {
    throw new CloudAuthError({
      reason: "failed",
      detail: "Allow pop-ups for this site to sign in.",
    });
  }
  return popup;
}

function watchPopup<A>(
  popup: Window,
  signal: AbortSignal,
  run: (settle: { resolve: (value: A) => void; reject: (error: unknown) => void }) => () => void,
): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    let cleanUp = () => {};
    const finish = (done: () => void) => {
      cleanUp();
      clearInterval(closedPoll);
      signal.removeEventListener("abort", onAbort);
      if (!popup.closed) popup.close();
      done();
    };
    const onAbort = () => finish(() => reject(cancelled(signal)));
    const closedPoll = setInterval(() => {
      if (popup.closed) finish(() => reject(cancelled(signal)));
    }, POPUP_CLOSED_POLL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanUp = run({
      resolve: (value) => finish(() => resolve(value)),
      reject: (error) => finish(() => reject(error)),
    });
  });
}

function signInWithGitHubPopup(authUrl: string, signal: AbortSignal): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const start = new URL(`${authUrl}/api/auth/oauth-popup/start`);
  start.searchParams.set("provider", "github");
  start.searchParams.set("popupOrigin", window.location.origin);
  start.searchParams.set("popupNonce", nonce);
  const popup = openPopup(start.toString());
  const authOrigin = new URL(authUrl).origin;
  return watchPopup<string>(popup, signal, ({ resolve, reject }) => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== authOrigin) return;
      const data = event.data as {
        readonly type?: unknown;
        readonly nonce?: unknown;
        readonly token?: unknown;
        readonly error?: { readonly code?: string; readonly description?: string };
      } | null;
      if (data?.type !== POPUP_MESSAGE_TYPE || data.nonce !== nonce) return;
      if (data.error) {
        reject(
          new CloudAuthError({
            reason: "failed",
            detail: data.error.description || "GitHub sign-in failed.",
          }),
        );
        return;
      }
      if (typeof data.token === "string" && data.token) resolve(data.token);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
}

const browserPlatform: CloudAuthPlatform = {
  store: localSessionStore,
  signIn: (method, context) => {
    if (method === "github") return signInWithGitHubPopup(context.authUrl, context.signal);
    const popup = openPopup("about:blank");
    const popupClosed = new AbortController();
    const watched = watchPopup<never>(popup, context.signal, () => () => {});
    watched.catch((error: unknown) => popupClosed.abort(error));
    return context
      .signInWithDevice((verification) => {
        popup.location.href = verification.verificationUriComplete;
      }, popupClosed.signal)
      .finally(() => {
        if (!popup.closed) popup.close();
      });
  },
};

function awaitDesktopCallback(signal: AbortSignal): Promise<string> {
  const webLinks = window.desktopBridge?.webLinks;
  if (!webLinks) {
    return Promise.reject(
      new CloudAuthError({ reason: "failed", detail: "Desktop sign-in is unavailable." }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      unsubscribe();
      reject(cancelled(signal));
    };
    const unsubscribe = webLinks.onOpen((url) => {
      if (!isCloudAuthAppLink(url)) return;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      const token = readSessionTokenFromCallback(url);
      if (token) return resolve(token);
      reject(
        new CloudAuthError({
          reason: readCallbackError(url) === "access_denied" ? "denied" : "failed",
          detail: "GitHub sign-in did not complete.",
        }),
      );
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const desktopPlatform: CloudAuthPlatform = {
  store: localSessionStore,
  signIn: async (method, context) => {
    const bridge = window.desktopBridge;
    if (!bridge) throw new CloudAuthError({ reason: "failed", detail: "Desktop bridge missing." });
    if (method === "passkey") {
      return context.signInWithDevice((verification) =>
        bridge.openExternal(verification.verificationUriComplete).then(() => undefined),
      );
    }
    const callbackUrl = `${window.location.protocol}//${CLOUD_AUTH_APP_LINK_HOST}`;
    const callback = awaitDesktopCallback(context.signal);
    const authorizationUrl = await context.socialAuthorizationUrl(callbackUrl);
    await bridge.openExternal(authorizationUrl);
    return callback;
  },
};

let instance: CloudAuth | null | undefined;

export function getCloudAuth(): CloudAuth | null {
  if (instance !== undefined) return instance;
  const { authUrl, relayUrl } = resolveCloudPublicConfig();
  instance =
    typeof window === "undefined" || !authUrl || !relayUrl
      ? null
      : createCloudAuth({
          authUrl,
          platform: window.desktopBridge ? desktopPlatform : browserPlatform,
        });
  return instance;
}

const SIGNED_OUT: CloudAuthState = { status: "signedOut" };
const noop = () => () => {};

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

export function useCloudAuth(): CloudAuthSnapshot {
  const auth = getCloudAuth();
  const state = useSyncExternalStore(
    auth?.subscribe ?? noop,
    () => auth?.getState() ?? SIGNED_OUT,
    () => SIGNED_OUT,
  );
  return readCloudAuthSnapshot(state);
}
