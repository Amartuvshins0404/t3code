import { useAtomValue } from "@effect/atom-react";
import { setAppBaseName } from "@t3tools/client-runtime/app-name";
import { formatAppBaseName, resolveAppMonogram } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { BUILD_OWNER_NAME } from "../lib/mobileBranding";
import type { Preferences } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentServerConfigsAtom } from "./server";

type OwnerBranding = NonNullable<Preferences["ownerBranding"]>;

const liveOwnerBrandingAtom = Atom.make((get): OwnerBranding | null => {
  const configs = get(environmentServerConfigsAtom);
  for (const environmentId of get(connectedEnvironmentIdsAtom)) {
    const config = configs.get(environmentId);
    if (config?.environment.capabilities.ownerBranding !== true) continue;
    return { name: config.settings.ownerName, logo: config.settings.ownerLogo };
  }
  return null;
}).pipe(Atom.withLabel("mobile-app-live-owner-branding"));

const storedOwnerBrandingAtom = Atom.make((get): OwnerBranding | null => {
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? (preferences.value.ownerBranding ?? null) : null;
}).pipe(Atom.withLabel("mobile-app-stored-owner-branding"));

const ownerBrandingAtom = Atom.make((get): OwnerBranding => {
  const branding = get(liveOwnerBrandingAtom) ?? get(storedOwnerBrandingAtom);
  if (branding === null) return { name: BUILD_OWNER_NAME, logo: null };
  return branding.name.length > 0 ? branding : { ...branding, name: BUILD_OWNER_NAME };
}).pipe(Atom.withLabel("mobile-app-owner-branding"));

const appBaseNameAtom = Atom.make((get): string =>
  formatAppBaseName(get(ownerBrandingAtom).name),
).pipe(Atom.withLabel("mobile-app-base-name"));

interface AppBranding {
  readonly baseName: string;
  readonly monogram: string;
  readonly logo: string | null;
}

const appBrandingAtom = Atom.make((get): AppBranding => {
  const branding = get(ownerBrandingAtom);
  return {
    baseName: get(appBaseNameAtom),
    monogram: resolveAppMonogram(branding.name),
    logo: branding.logo,
  };
}).pipe(Atom.withLabel("mobile-app-branding"));

export function useAppBranding(): AppBranding {
  return useAtomValue(appBrandingAtom);
}

function persistLiveOwnerBranding(live: OwnerBranding | null): void {
  if (live === null) return;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return;
  const stored = preferences.value.ownerBranding;
  if (stored?.name === live.name && stored.logo === live.logo) return;
  appAtomRegistry.set(updateMobilePreferencesAtom, { ownerBranding: live });
}

export function installAppBranding(): () => void {
  const unsubscribeName = appAtomRegistry.subscribe(appBaseNameAtom, setAppBaseName, {
    immediate: true,
  });
  const unsubscribeLive = appAtomRegistry.subscribe(
    liveOwnerBrandingAtom,
    persistLiveOwnerBranding,
    { immediate: true },
  );
  const unsubscribePreferences = appAtomRegistry.subscribe(mobilePreferencesAtom, () =>
    persistLiveOwnerBranding(appAtomRegistry.get(liveOwnerBrandingAtom)),
  );
  return () => {
    unsubscribeName();
    unsubscribeLive();
    unsubscribePreferences();
  };
}
