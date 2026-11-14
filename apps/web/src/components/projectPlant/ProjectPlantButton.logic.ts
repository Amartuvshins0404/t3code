import {
  type ProjectPlantStatus,
  type ThreadId,
  projectPlantUnavailableMessage,
} from "@t3tools/contracts";

export type PlantButtonState =
  | { readonly kind: "plant" | "unplant" }
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | { readonly kind: "disabled"; readonly reason: string };

export function plantButtonState(input: {
  readonly status: ProjectPlantStatus | null;
  readonly error: string | null;
  readonly permitted: boolean;
  readonly openThreadKnown: boolean;
}): PlantButtonState {
  if (!input.permitted)
    return { kind: "disabled", reason: "This connection cannot start agent threads here." };
  if (input.error !== null) return { kind: "disabled", reason: input.error };
  const status = input.status;
  if (status === null) return { kind: "disabled", reason: "Reading the default branch…" };
  switch (status._tag) {
    case "planted":
    case "not_planted":
      if (
        status.openThread !== null &&
        (input.openThreadKnown || status.openThread.archived === true)
      )
        return { kind: "open", threadId: status.openThread.threadId };
      return { kind: status._tag === "planted" ? "unplant" : "plant" };
    case "blocked":
      return {
        kind: "disabled",
        reason: `${status.file} on the default branch is not agent-trust's, so Plant would stop.`,
      };
    case "unavailable":
      return { kind: "disabled", reason: projectPlantUnavailableMessage(status.reason) };
  }
}

export function plantOpenThreadId(status: ProjectPlantStatus | null): ThreadId | null {
  return status !== null && (status._tag === "planted" || status._tag === "not_planted")
    ? (status.openThread?.threadId ?? null)
    : null;
}
