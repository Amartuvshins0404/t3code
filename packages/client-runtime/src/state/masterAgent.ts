import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type MasterAgentThreadIdLookup = (
  environmentId: EnvironmentId,
) => ThreadId | null | undefined;

export function isMasterAgentThread(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  masterAgentThreadIdFor: MasterAgentThreadIdLookup,
): boolean {
  return masterAgentThreadIdFor(thread.environmentId) === thread.id;
}

export function withoutMasterAgentThreads<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(threads: ReadonlyArray<T>, masterAgentThreadIdFor: MasterAgentThreadIdLookup): ReadonlyArray<T> {
  return threads.filter((thread) => !isMasterAgentThread(thread, masterAgentThreadIdFor));
}
