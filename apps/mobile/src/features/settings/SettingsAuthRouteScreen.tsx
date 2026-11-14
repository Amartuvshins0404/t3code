import {
  type CloudAuth,
  type CloudSignInMethod,
  type CloudUser,
  isCloudAuthError,
} from "@t3tools/client-runtime/cloud-auth";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { getCloudAuth, useCloudAuth } from "../cloud/cloudAuth";
import { useManagedRelayEnvironments } from "../cloud/managedRelayState";
import { RegisteredServersSection } from "../cloud/RegisteredServersSection";

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  const auth = getCloudAuth();
  return auth ? <ConfiguredSettingsAuthRouteScreen auth={auth} /> : null;
}

function ConfiguredSettingsAuthRouteScreen({ auth }: { readonly auth: CloudAuth }) {
  const { isLoaded, user } = useCloudAuth();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environments = useManagedRelayEnvironments();

  return (
    <>
      <SheetHeader
        title="T3 Account"
        accessibilityLabel="Close account"
        onClose={() => navigation.goBack()}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1 bg-sheet"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          user ? (
            <RefreshControl
              refreshing={environments.isPending && environments.data !== null}
              onRefresh={environments.refresh}
            />
          ) : undefined
        }
      >
        {!isLoaded ? null : user ? (
          <AccountSections auth={auth} user={user} />
        ) : (
          <SignInSection auth={auth} />
        )}
      </ScrollView>
    </>
  );
}

function SignInSection({ auth }: { readonly auth: CloudAuth }) {
  const [pending, setPending] = useState<CloudSignInMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);

  const signIn = (method: CloudSignInMethod) => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setPending(method);
    setError(null);
    auth.signIn(method, { signal: controller.signal }).then(
      () => {
        if (attempt.current === controller) attempt.current = null;
      },
      (cause: unknown) => {
        if (attempt.current !== controller) return;
        attempt.current = null;
        setPending(null);
        if (isCloudAuthError(cause) && cause.reason === "cancelled") return;
        setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
      },
    );
  };

  return (
    <>
      <ListSection
        title="Sign in to T3 Connect"
        footer={
          pending
            ? "Finish signing in in the browser."
            : "Use your GitHub account or a passkey to reach your environments from anywhere."
        }
      >
        <ListActionRow
          label="Continue with GitHub"
          loading={pending === "github"}
          disabled={pending !== null}
          onPress={() => signIn("github")}
        />
        <ListActionRow
          label="Use a passkey"
          loading={pending === "passkey"}
          disabled={pending !== null}
          onPress={() => signIn("passkey")}
        />
        {pending ? <ListActionRow label="Cancel" onPress={() => attempt.current?.abort()} /> : null}
      </ListSection>
      {error ? <Notice tone="danger" message={error} /> : null}
    </>
  );
}

function AccountSections({ auth, user }: { readonly auth: CloudAuth; readonly user: CloudUser }) {
  const navigation = useNavigation();

  const signOut = () => {
    navigation.goBack();
    auth.signOut().catch((cause: unknown) => {
      Dialog.alert("Could not sign out", cause instanceof Error ? cause.message : "Try again.");
    });
  };

  return (
    <>
      <ListSection title="Account">
        <ListRowLayout
          icon="person.crop.circle"
          label={user.name || user.email}
          description={user.name ? user.email : undefined}
        />
        <ListActionRow label="Sign out" tone="danger" onPress={signOut} />
      </ListSection>
      <RegisteredServersSection />
    </>
  );
}
