import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  buildProjectBoard,
  countProjectBoard,
  PROJECT_BOARD_COLUMNS,
  type ProjectBoardColumnId,
} from "./projectBoard.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-v2");
const providerInstanceId = ProviderInstanceId.make("codex");

type RunState = "running" | "completed" | "failed";
type PullRequestState = "open" | "merged" | "closed";

interface ThreadSpec {
  readonly minute?: number;
  readonly run?: RunState;
  readonly pullRequest?: PullRequestState | null;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null;
  readonly pendingGuestMessageCount?: number;
  readonly planMode?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly lastError?: boolean;
}

const at = (minute: number) => `2026-06-20T00:${String(minute).padStart(2, "0")}:00.000Z`;

function pullRequestLink(state: PullRequestState, time: string): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: 12,
    url: "https://github.com/pingdotgg/t3code/pull/12",
    source: "agent",
    linkedAt: time,
    snapshot: {
      state,
      title: "Change",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: time,
      syncedAt: time,
    },
    stack: null,
  };
}

function shell(id: string, spec: ThreadSpec = {}): EnvironmentThreadShell {
  const time = at(spec.minute ?? 0);
  const run = spec.run ?? "completed";
  const runId = RunId.make(`run-${id}`);
  const base = presentThreadShell(environmentId, v2ThreadShell);
  return {
    ...base,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    interactionMode: spec.planMode ? "plan" : "default",
    createdAt: time,
    updatedAt: time,
    unsettledAt: time,
    latestUserMessageAt: time,
    latestUserAuthoredMessageAt: time,
    pendingUserInputAt: spec.hasPendingUserInput ? time : null,
    archivedAt: spec.archived ? time : null,
    deletedAt: spec.deleted ? time : null,
    hasPendingApprovals: spec.hasPendingApprovals ?? false,
    hasPendingUserInput: spec.hasPendingUserInput ?? false,
    pendingSubagentRequest: spec.pendingSubagentRequest ?? null,
    pendingGuestMessageCount: spec.pendingGuestMessageCount ?? 0,
    hasActionableProposedPlan: spec.hasActionableProposedPlan ?? false,
    latestRun: {
      runId,
      status: run,
      requestedAt: time,
      startedAt: time,
      completedAt: run === "running" ? null : time,
      assistantMessageId: null,
    },
    runtime: {
      status: run,
      activeRunId: run === "running" ? runId : null,
      providerInstanceId,
      providerName: null,
      lastError: spec.lastError ? "Provider crashed" : null,
      updatedAt: time,
    },
    pullRequests: spec.pullRequest ? [pullRequestLink(spec.pullRequest, time)] : [],
    linkedPullRequest: spec.pullRequest
      ? {
          projectId,
          repository: "pingdotgg/t3code",
          number: 12,
          url: "https://github.com/pingdotgg/t3code/pull/12",
        }
      : null,
  };
}

function columnOf(
  board: ReturnType<typeof buildProjectBoard>,
  thread: EnvironmentThreadShell,
): ReadonlyArray<ProjectBoardColumnId> {
  return board
    .filter((column) => column.cards.some((card) => card.thread.id === thread.id))
    .map((column) => column.id);
}

function cardIds(board: ReturnType<typeof buildProjectBoard>, id: ProjectBoardColumnId) {
  return board.find((column) => column.id === id)!.cards.map((card) => card.thread.id as string);
}

function expectedColumn(spec: ThreadSpec): ProjectBoardColumnId {
  const needsYou =
    spec.hasPendingApprovals ||
    spec.hasPendingUserInput ||
    spec.pendingSubagentRequest != null ||
    (spec.pendingGuestMessageCount ?? 0) > 0 ||
    (spec.planMode && spec.hasActionableProposedPlan) ||
    spec.lastError ||
    spec.run === "failed";
  if (needsYou) return "needs-you";
  if (spec.run === "running") return "working";
  if (spec.pullRequest === "open") return "in-checks";
  return "done";
}

const ThreadSpecSchema = Schema.Struct({
  minute: Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  run: Schema.Literals(["running", "completed", "failed"]),
  pullRequest: Schema.NullOr(Schema.Literals(["open", "merged", "closed"])),
  archived: Schema.Boolean,
  deleted: Schema.Boolean,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  pendingSubagentRequest: Schema.NullOr(Schema.Literals(["approval", "user_input"])),
  pendingGuestMessageCount: Schema.Literals([0, 1, 2]),
  planMode: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  lastError: Schema.Boolean,
});

describe("buildProjectBoard", () => {
  it("lists the four columns in board order, even for a project with no threads", () => {
    assert.deepEqual(PROJECT_BOARD_COLUMNS, ["working", "needs-you", "in-checks", "done"]);
    assert.deepEqual(
      buildProjectBoard([]).map((column) => column.id),
      ["working", "needs-you", "in-checks", "done"],
    );
  });

  const cases: ReadonlyArray<readonly [string, ThreadSpec, ProjectBoardColumnId]> = [
    [
      "a pending approval while running",
      { run: "running", hasPendingApprovals: true },
      "needs-you",
    ],
    ["a pending question", { hasPendingUserInput: true }, "needs-you"],
    ["a pending subagent request", { pendingSubagentRequest: "approval" }, "needs-you"],
    ["a guest message waiting", { pendingGuestMessageCount: 1 }, "needs-you"],
    [
      "a proposed plan waiting in plan mode",
      { planMode: true, hasActionableProposedPlan: true },
      "needs-you",
    ],
    ["a proposed plan outside plan mode", { hasActionableProposedPlan: true }, "done"],
    ["a runtime error", { lastError: true }, "needs-you"],
    [
      "a failed latest run with an open pull request",
      { run: "failed", pullRequest: "open" },
      "needs-you",
    ],
    ["a running agent", { run: "running" }, "working"],
    [
      "a running agent with an open pull request",
      { run: "running", pullRequest: "open" },
      "working",
    ],
    ["an open linked pull request", { pullRequest: "open" }, "in-checks"],
    ["a merged pull request", { pullRequest: "merged" }, "done"],
    ["a closed pull request", { pullRequest: "closed" }, "done"],
    ["a finished thread with no pull request", {}, "done"],
  ];

  it.each(cases)("puts %s in the right column", (_name, spec, expected) => {
    const thread = shell("t", spec);
    assert.deepEqual(columnOf(buildProjectBoard([thread]), thread), [expected]);
  });

  it("leaves archived and deleted threads off the board and out of the counts", () => {
    const live = shell("live", { run: "running" });
    const archived = shell("archived", { run: "running", archived: true });
    const deleted = shell("deleted", { hasPendingUserInput: true, deleted: true });
    const board = buildProjectBoard([live, archived, deleted]);
    assert.deepEqual(columnOf(board, archived), []);
    assert.deepEqual(columnOf(board, deleted), []);
    assert.deepEqual(countProjectBoard([live, archived, deleted]), {
      working: 1,
      "needs-you": 0,
      "in-checks": 0,
      done: 0,
    });
  });

  it("puts the longest waiting card first in Needs you", () => {
    const board = buildProjectBoard([
      shell("middle", { minute: 5, hasPendingUserInput: true }),
      shell("newest", { minute: 9, hasPendingApprovals: true }),
      shell("oldest", { minute: 1, run: "failed" }),
    ]);
    assert.deepEqual(cardIds(board, "needs-you"), ["oldest", "middle", "newest"]);
  });

  it("puts the most recently active card first in Working, In checks and Done", () => {
    const board = buildProjectBoard([
      shell("working-old", { minute: 1, run: "running" }),
      shell("working-new", { minute: 8, run: "running" }),
      shell("checks-old", { minute: 2, pullRequest: "open" }),
      shell("checks-new", { minute: 7, pullRequest: "open" }),
      shell("done-old", { minute: 3 }),
      shell("done-mid", { minute: 5, pullRequest: "merged" }),
      shell("done-new", { minute: 6 }),
    ]);
    assert.deepEqual(cardIds(board, "working"), ["working-new", "working-old"]);
    assert.deepEqual(cardIds(board, "in-checks"), ["checks-new", "checks-old"]);
    assert.deepEqual(cardIds(board, "done"), ["done-new", "done-mid", "done-old"]);
  });

  const doneThreads = (count: number) =>
    Array.from({ length: count }, (_, index) => shell(`done-${index}`, { minute: index }));

  it("shows all 30 Done cards when exactly 30 are done", () => {
    const done = buildProjectBoard(doneThreads(30)).find((column) => column.id === "done")!;
    assert.equal(done.cards.length, 30);
    assert.equal(done.total, 30);
  });

  it("shows the 30 most recent of 31 Done cards until more are asked for", () => {
    const threads = doneThreads(31);
    const done = buildProjectBoard(threads).find((column) => column.id === "done")!;
    assert.equal(done.cards.length, 30);
    assert.equal(done.total, 31);
    assert.isFalse(done.cards.some((card) => card.thread.id === "done-0"));
    const more = buildProjectBoard(threads, { doneLimit: 60 }).find(
      (column) => column.id === "done",
    )!;
    assert.equal(more.cards.length, 31);
    assert.equal(more.cards.at(-1)!.thread.id, "done-0");
  });

  it.prop(
    "puts every live thread in exactly one column by the first matching rule, and the counts match the board",
    [Schema.Array(ThreadSpecSchema)],
    ([specs]) => {
      const threads = specs.map((spec, index) => shell(`thread-${index}`, spec));
      const fullBoard = buildProjectBoard(threads, { doneLimit: Number.POSITIVE_INFINITY });
      specs.forEach((spec, index) => {
        const columns = columnOf(fullBoard, threads[index]!);
        if (spec.archived || spec.deleted) assert.deepEqual(columns, []);
        else assert.deepEqual(columns, [expectedColumn(spec)]);
      });

      const board = buildProjectBoard(threads);
      const counts = countProjectBoard(threads);
      for (const column of board) assert.equal(counts[column.id], column.total);
      assert.equal(
        board.reduce((sum, column) => sum + column.total, 0),
        specs.filter((spec) => !spec.archived && !spec.deleted).length,
      );
    },
    { arbitrary: { seed: 42 } },
  );
});
