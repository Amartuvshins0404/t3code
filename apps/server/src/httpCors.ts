import { ORCHESTRATION_PROTOCOL_HEADER, resolveAppSchemes } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const desktopRendererOrigins = (ownerName: string | undefined) =>
  resolveAppSchemes(ownerName).map((scheme) => `${scheme}://app`);
