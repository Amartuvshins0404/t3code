import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread, teamAgentReadsOutsideProject } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.each([
  ["another project's thread", "project-other", true],
  ["a thread in its own project", "project-own", false],
  ["a thread that does not exist", undefined, true],
])("decides whether an agent conversation reads %s", (_label, projectId, refused) => {
  const caller = {
    projectId: ProjectId.make("project-own"),
    teamShare: {
      organizationId: "org-a",
      access: "steer" as const,
      sharedAt: "2026-11-15T00:00:00.000Z",
      agent: { startedBy: { userId: "user-ana", name: "Ana" } },
    },
  };
  const target = projectId === undefined ? undefined : ProjectId.make(projectId);
  expect(teamAgentReadsOutsideProject(caller, target)).toBe(refused);
  expect(teamAgentReadsOutsideProject({ ...caller, teamShare: null }, target)).toBe(false);
});
