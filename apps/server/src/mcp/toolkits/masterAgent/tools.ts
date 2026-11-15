import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as MasterAgent from "../../../masterAgent/MasterAgent.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MasterAgent.MasterAgent,
];

const MemoryEntry = Schema.Struct({
  key: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
});

const MemoryUsage = {
  usedBytes: Schema.Number,
  limitBytes: Schema.Number,
};

const AgentMemoryReadTool = Tool.make("agent_memory_read", {
  description:
    "Read your saved memory: every key with its content. It is also given to you at session start.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ entries: Schema.Array(MemoryEntry), ...MemoryUsage }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AgentMemoryWriteTool = Tool.make("agent_memory_write", {
  description: `Save a durable rule or fact under a short key, replacing what the key held. Empty content deletes the key. Save without being asked. All keys share ${MasterAgent.MASTER_AGENT_MEMORY_MAX_BYTES} bytes.`,
  parameters: Schema.Struct({
    key: Schema.String.annotate({ description: "Short topic name, such as review-rules." }),
    content: Schema.String.annotate({ description: "Plain text. Empty deletes the key." }),
  }),
  success: Schema.Struct({ key: Schema.String, deleted: Schema.Boolean, ...MemoryUsage }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Write memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Saving is unprompted, so Claude Code must not hide it behind ToolSearch.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const MasterAgentToolkit = Toolkit.make(AgentMemoryReadTool, AgentMemoryWriteTool);
