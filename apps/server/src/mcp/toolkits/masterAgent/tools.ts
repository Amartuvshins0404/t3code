import {
  MasterAgentWatchState,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as MasterAgent from "../../../masterAgent/MasterAgent.ts";
import * as MasterAgentWatch from "../../../masterAgent/MasterAgentWatch.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
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

const ProjectBoardTool = Tool.make("t3_project_board", {
  description:
    "How work stands in every project, as the Projects page shows it: thread counts for Working, Needs you, In checks and Done, and each thread that needs the user, longest waiting first.",
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        title: Schema.String,
        working: NonNegativeInt,
        needsYou: NonNegativeInt,
        inChecks: NonNegativeInt,
        done: NonNegativeInt,
        needsYouThreads: Schema.Array(
          Schema.Struct({
            threadId: ThreadId,
            title: Schema.String,
            link: Schema.String,
            reason: Schema.String,
            waitingSince: Schema.NullOr(Schema.String),
            pullRequestUrl: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Read the projects board")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const watchDependencies = [...dependencies, MasterAgentWatch.MasterAgentWatch];

const AgentThreadsTool = Tool.make("agent_threads", {
  description:
    "The threads you started or sent work to that T3 Code is watching for you, with their state: working, waiting_on_tasks (a helper or a program it left running), in_checks (waiting on a pull request), or done (your notice is on its way).",
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        link: Schema.String,
        state: MasterAgentWatchState,
        watchedSince: Schema.String,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: watchDependencies,
})
  .annotate(Tool.Title, "List watched threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AgentThreadUnwatchTool = Tool.make("agent_thread_unwatch", {
  description:
    "Stop watching a thread: no notice will come when it settles. Its work keeps running; stop that with `t3_thread_interrupt`.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ threadId: ThreadId }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: watchDependencies,
})
  .annotate(Tool.Title, "Stop watching a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MasterAgentToolkit = Toolkit.make(
  AgentMemoryReadTool,
  AgentMemoryWriteTool,
  ProjectBoardTool,
  AgentThreadsTool,
  AgentThreadUnwatchTool,
);
