import { resolveAppIdentity } from "@t3tools/contracts/appName";

declare const __T3CODE_BUILD_OWNER_NAME__: string | undefined;

export const BUILD_OWNER_NAME = (
  typeof __T3CODE_BUILD_OWNER_NAME__ === "undefined" ? "" : __T3CODE_BUILD_OWNER_NAME__
).trim();

export const BUILD_APP_IDENTITY = resolveAppIdentity(BUILD_OWNER_NAME);
