// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { formatAppBaseName, resolveAppIdentity } from "@t3tools/contracts";
import { setAppBaseName } from "@t3tools/shared/appName";
import { parsePersistedOwnerName } from "@t3tools/shared/serverSettings";

export function formatOwnerAppBaseName(savedOwnerName: string | null | undefined): string {
  return formatAppBaseName(savedOwnerName?.trim() || process.env.T3CODE_OWNER_NAME);
}

function readSavedOwnerName(): string | null {
  try {
    const home =
      process.env.T3CODE_HOME?.trim() ||
      NodePath.join(
        NodeOS.homedir(),
        resolveAppIdentity(process.env.T3CODE_OWNER_NAME).homeDirName,
      );
    const raw = NodeFS.readFileSync(NodePath.join(home, "userdata", "settings.json"), "utf8");
    return parsePersistedOwnerName(raw);
  } catch {
    return null;
  }
}

export function loadSavedAppBaseName(): void {
  setAppBaseName(formatOwnerAppBaseName(readSavedOwnerName()));
}
