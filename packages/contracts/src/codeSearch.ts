import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodeSearchProviderId = Schema.Literals([
  "typesafe",
  "openrouter",
  "vercel",
  "opencode",
]);
export type CodeSearchProviderId = typeof CodeSearchProviderId.Type;

export const CODE_SEARCH_PROVIDER_LABELS = {
  typesafe: "TypeSafe",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  opencode: "OpenCode Zen",
} as const satisfies Record<CodeSearchProviderId, string>;

export const CODE_SEARCH_INSTALL_COMMAND = "npm install -g @dzhng/jevgrep";

export const CodeSearchStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optional(Schema.String),
  provider: Schema.optional(CodeSearchProviderId),
});
export type CodeSearchStatus = typeof CodeSearchStatus.Type;

export const CodeSearchConnectInput = Schema.Struct({
  provider: CodeSearchProviderId,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type CodeSearchConnectInput = typeof CodeSearchConnectInput.Type;

export const CodeSearchStep = Schema.Literals(["install", "auth", "test", "skill"]);
export type CodeSearchStep = typeof CodeSearchStep.Type;

export const CodeSearchConnectResult = Schema.Struct({
  status: CodeSearchStatus,
  passed: Schema.Array(CodeSearchStep),
});
export type CodeSearchConnectResult = typeof CodeSearchConnectResult.Type;

export const CodeSearchFailureReason = Schema.Literals([
  "npm_missing",
  "node_too_old",
  "permission_denied",
  "not_found_after_install",
  "rejected",
  "network",
  "timed_out",
  "failed",
]);
export type CodeSearchFailureReason = typeof CodeSearchFailureReason.Type;

export class CodeSearchSetupError extends Schema.TaggedError<CodeSearchSetupError>()(
  "CodeSearchSetupError",
  {
    step: CodeSearchStep,
    reason: CodeSearchFailureReason,
  },
) {
  override get message(): string {
    return `Code search setup failed at the ${this.step} step (${this.reason}).`;
  }
}
