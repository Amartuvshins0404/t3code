import { formatAppBaseName } from "@t3tools/contracts";
import Constants from "expo-constants";

export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}

const buildOwnerName: unknown = Constants.expoConfig?.extra?.ownerName;
export const BUILD_OWNER_NAME = typeof buildOwnerName === "string" ? buildOwnerName.trim() : "";
export const BUILD_APP_BASE_NAME = formatAppBaseName(BUILD_OWNER_NAME);
