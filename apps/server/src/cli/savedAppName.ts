// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { formatAppBaseName } from "@t3tools/contracts";
import { setAppBaseName } from "@t3tools/shared/appName";
import { parsePersistedOwnerName } from "@t3tools/shared/serverSettings";

export function loadSavedAppBaseName(): void {
  try {
    const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
    const raw = NodeFS.readFileSync(NodePath.join(home, "userdata", "settings.json"), "utf8");
    setAppBaseName(formatAppBaseName(parsePersistedOwnerName(raw)));
  } catch {}
}
