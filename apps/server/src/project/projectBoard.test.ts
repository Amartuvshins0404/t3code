import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { summarizeProjectBoard } from "./projectBoard.ts";

const projectId = ProjectId.make("project:board");
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`);

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    ...liveThreadShell(threadId),
    projectId,
    latestRunId: RunId.make(`run:${id}`),
    activeRunId: null,
    status: "completed",
    updatedAt: at(1),
    ...overrides,
  };
}

const approval = (minute: number) => ({
  id: RuntimeRequestId.make(`request:${minute}`),
  kind: "command" as const,
  createdAt: at(minute),
});

it("counts each thread in the Projects page column its state puts it in", () => {
  const running = RunId.make("run:running");
  const agent = shell("agent", { status: "running", activeRunId: RunId.make("run:agent") });
  const [board, ...rest] = summarizeProjectBoard({
    projects: [
      { id: projectId, title: "App", archivedAt: null },
      {
        id: ProjectId.make("project:archived"),
        title: "Old",
        archivedAt: "2026-11-15T10:00:00.000Z",
      },
    ],
    threads: [
      shell("done"),
      shell("working", { latestRunId: running, activeRunId: running, status: "running" }),
      shell("asks", { pendingRuntimeRequest: approval(5) }),
      shell("failed", { status: "failed", updatedAt: at(2) }),
      shell("parent", { status: "running", activeRunId: RunId.make("run:parent") }),
      shell("child", {
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
        status: "running",
        activityRunStatus: "running",
        pendingRuntimeRequest: approval(3),
      }),
      agent,
    ],
    hiddenThreadId: agent.id,
  });

  assert.deepEqual(rest, []);
  assert.deepEqual(board?.counts, { working: 1, "needs-you": 3, "in-checks": 0, done: 1 });
  assert.deepEqual(
    board?.needsYou.map((item) => [item.threadId, item.reason]),
    [
      ["failed", "failed-run"],
      ["asks", "approval"],
      ["parent", "subagent-request"],
    ],
  );
});
