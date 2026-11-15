import { getConnectName } from "@t3tools/client-runtime/app-name";
import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay";
import * as Schema from "effect/Schema";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a T3 Connect request failed. */
export function relayFailureReason(cause: unknown): string | null {
  const connectName = getConnectName();
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current)) return `${connectName} timed out. Try again.`;
    if (isRequestFailed(current)) {
      if (current.transportFailed) return `Could not reach ${connectName}. Check your network.`;
      if (current.relayError) {
        return current.relayError._tag === "RelayInternalError"
          ? `${connectName} is unavailable. Try again.`
          : relayRequestFailureDetail(current);
      }
      if (current.status === 504) return `${connectName} timed out. Try again.`;
      if ((current.status ?? 0) >= 500) return `${connectName} is unavailable. Try again.`;
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}
