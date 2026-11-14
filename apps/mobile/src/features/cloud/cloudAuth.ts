import {
  type CloudAuth,
  CloudAuthError,
  type CloudAuthPlatform,
  type CloudAuthSnapshot,
  type CloudAuthState,
  type CloudSessionStore,
  CloudStoredSession,
  createCloudAuth,
  readCallbackError,
  readCloudAuthSnapshot,
  readSessionTokenFromCallback,
} from "@t3tools/client-runtime/cloud-auth";
import { CLOUD_AUTH_APP_LINK_HOST } from "@t3tools/shared/remote";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { resolveCloudPublicConfig } from "./publicConfig";

const SESSION_STORAGE_KEY = "t3code.cloud.auth-session";

const StoredSessionJson = Schema.fromJsonString(CloudStoredSession);
const decodeStoredSession = Schema.decodeUnknownOption(StoredSessionJson);
const encodeStoredSession = Schema.encodeSync(StoredSessionJson);

const secureSessionStore: CloudSessionStore = {
  read: async () => {
    const raw = await SecureStore.getItemAsync(SESSION_STORAGE_KEY);
    return raw ? Option.getOrNull(decodeStoredSession(raw)) : null;
  },
  write: async (session) => {
    if (session) await SecureStore.setItemAsync(SESSION_STORAGE_KEY, encodeStoredSession(session));
    else await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY);
  },
};

async function signInWithGitHub(
  authorizationUrl: (callbackUrl: string) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  const callbackUrl = Linking.createURL(CLOUD_AUTH_APP_LINK_HOST);
  const url = await authorizationUrl(callbackUrl);
  const dismiss = () => {
    if (Platform.OS === "ios") WebBrowser.dismissAuthSession();
  };
  signal.addEventListener("abort", dismiss, { once: true });
  const result = await WebBrowser.openAuthSessionAsync(url, callbackUrl).finally(() =>
    signal.removeEventListener("abort", dismiss),
  );
  if (result.type !== "success") {
    throw new CloudAuthError({ reason: "cancelled", detail: "Sign-in was cancelled." });
  }
  const token = readSessionTokenFromCallback(result.url);
  if (token) return token;
  throw new CloudAuthError({
    reason: readCallbackError(result.url) === "access_denied" ? "denied" : "failed",
    detail: "GitHub sign-in did not complete.",
  });
}

const mobilePlatform: CloudAuthPlatform = {
  store: secureSessionStore,
  signIn: (method, context) =>
    method === "github"
      ? signInWithGitHub(context.socialAuthorizationUrl, context.signal)
      : context
          .signInWithDevice((verification) => {
            void WebBrowser.openBrowserAsync(verification.verificationUriComplete);
          })
          .finally(() => {
            if (Platform.OS === "ios") void WebBrowser.dismissBrowser().catch(() => undefined);
          }),
};

let instance: CloudAuth | null | undefined;

export function getCloudAuth(): CloudAuth | null {
  if (instance !== undefined) return instance;
  const { auth, relay } = resolveCloudPublicConfig();
  instance =
    auth.url && relay.url ? createCloudAuth({ authUrl: auth.url, platform: mobilePlatform }) : null;
  return instance;
}

const SIGNED_OUT: CloudAuthState = { status: "signedOut" };
const noop = () => () => {};

export function useCloudAuth(): CloudAuthSnapshot {
  const auth = getCloudAuth();
  const state = useSyncExternalStore(
    auth?.subscribe ?? noop,
    () => auth?.getState() ?? SIGNED_OUT,
    () => SIGNED_OUT,
  );
  return readCloudAuthSnapshot(state);
}
