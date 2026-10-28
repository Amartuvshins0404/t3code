import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

export const ACP_USAGE_COMMANDS: Partial<Record<string, string>> = {
  "claude-acp": "/usage",
  "codex-acp": "/status",
};

const LIMIT_LINE = /^\*\*([^*\n]+?)(?:\*\* — \*\*|:\*\* )(\d+(?:\.\d+)?)%(\*\*| left)/gm;

function windowKind(label: string): ServerProviderUsageWindow["kind"] {
  if (/5-hour|5h|session/i.test(label)) return "session";
  if (/week/i.test(label)) return "weekly";
  if (/month|spend/i.test(label)) return "monthly";
  return "other";
}

export function parseAcpUsageLimits(
  text: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = Array.from(
    text.matchAll(LIMIT_LINE),
    ([, label = "", percent, suffix]): ServerProviderUsageWindow => ({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      kind: windowKind(label),
      label,
      usedPercent: suffix === " left" ? 100 - Number(percent) : Number(percent),
    }),
  );
  return windows.length > 0 ? makeUsageLimits({ checkedAt, windows }) : undefined;
}
