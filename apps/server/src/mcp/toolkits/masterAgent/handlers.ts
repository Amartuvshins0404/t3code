import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MasterAgent from "../../../masterAgent/MasterAgent.ts";
import { masterAgentMemoryEntryBytes } from "../../../persistence/MasterAgentStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MasterAgentToolkit } from "./tools.ts";

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "MasterAgentMemoryFullError" || error._tag === "MasterAgentMemoryKeyError"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

export const isMasterThread = (
  masterAgent: MasterAgent.MasterAgent["Service"],
  threadId?: string,
) =>
  threadId === undefined
    ? Effect.succeed(false)
    : masterAgent.threadId.pipe(
        Effect.map((masterThreadId) => masterThreadId === threadId),
        Effect.orElseSucceed(() => false),
      );

const requireMasterThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const masterAgent = yield* MasterAgent.MasterAgent;
  if (!(yield* isMasterThread(masterAgent, scope.thread?.threadId))) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only the agent thread has memory.",
    });
  }
});

export const layer = McpToolAccess.toLayer(MasterAgentToolkit, {
  agent_memory_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* requireMasterThread;
      const masterAgent = yield* MasterAgent.MasterAgent;
      const entries = yield* masterAgent.listMemory.pipe(Effect.mapError(toFailure));
      return {
        entries,
        usedBytes: entries.reduce((total, entry) => total + masterAgentMemoryEntryBytes(entry), 0),
        limitBytes: MasterAgent.MASTER_AGENT_MEMORY_MAX_BYTES,
      };
    }),
  ),
  agent_memory_write: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireMasterThread;
      const masterAgent = yield* MasterAgent.MasterAgent;
      return yield* masterAgent.writeMemory(input).pipe(Effect.mapError(toFailure));
    }),
  ),
});
