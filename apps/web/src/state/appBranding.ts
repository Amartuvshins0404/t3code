import { useAtomValue } from "@effect/atom-react";
import { formatAppBaseName, resolveAppMonogram } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { APP_BASE_NAME, APP_OWNER_NAME_DEFAULT, APP_STAGE_LABEL } from "../branding";
import { formatAppDisplayName, resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "./server";

const appOwnerNameAtom = Atom.make((get): string | null => {
  const config = get(primaryServerConfigAtom);
  if (config === null) return null;
  return config.settings.ownerName.length > 0 ? config.settings.ownerName : APP_OWNER_NAME_DEFAULT;
}).pipe(Atom.withLabel("web-app-owner-name"));

const appBaseNameAtom = Atom.make((get): string => {
  const ownerName = get(appOwnerNameAtom);
  return ownerName === null ? APP_BASE_NAME : formatAppBaseName(ownerName);
}).pipe(Atom.withLabel("web-app-base-name"));

export const appDisplayNameAtom = Atom.make((get): string =>
  formatAppDisplayName({
    baseName: get(appBaseNameAtom),
    stageLabel: resolveServerBackedAppStageLabel({
      primaryServerVersion: get(primaryServerConfigAtom)?.environment.serverVersion ?? null,
      fallbackStageLabel: APP_STAGE_LABEL,
    }),
  }),
).pipe(Atom.withLabel("web-app-display-name"));

const appMonogramAtom = Atom.make((get): string =>
  resolveAppMonogram(get(appOwnerNameAtom) ?? APP_OWNER_NAME_DEFAULT),
).pipe(Atom.withLabel("web-app-monogram"));

const appOwnerLogoAtom = Atom.make(
  (get): string | null => get(primaryServerConfigAtom)?.settings.ownerLogo ?? null,
).pipe(Atom.withLabel("web-app-owner-logo"));

export function useAppBaseName(): string {
  return useAtomValue(appBaseNameAtom);
}

export function useAppMonogram(): string {
  return useAtomValue(appMonogramAtom);
}

export function useAppOwnerLogo(): string | null {
  return useAtomValue(appOwnerLogoAtom);
}
