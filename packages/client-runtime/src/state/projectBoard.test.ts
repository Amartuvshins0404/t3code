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
  buildNeedsYouList,
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

function placed(
  thread: EnvironmentThreadShell,
  where: { readonly environment?: string; readonly project?: string },
): EnvironmentThreadShell {
  return {
    ...thread,
    environmentId: EnvironmentId.make(where.environment ?? "environment-1"),
    projectId: ProjectId.make(where.project ?? "project-v2"),
  };
}

function untimed(thread: EnvironmentThreadShell): EnvironmentThreadShell {
  return {
    ...thread,
    createdAt: "",
    updatedAt: "",
    unsettledAt: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    pendingUserInputAt: null,
    latestRun: null,
  };
}

const rowKey = (item: { readonly thread: EnvironmentThreadShell }) =>
  `${item.thread.environmentId}/${item.thread.id}`;

function expectedGroup(spec: ThreadSpec): number {
  if (spec.pullRequest === "open") return 0;
  if (spec.lastError || spec.run === "failed") return 1;
  return 2;
}

const PlacedThreadSpecSchema = Schema.Struct({
  ...ThreadSpecSchema.fields,
  environment: Schema.Literals(["environment-1", "environment-2"]),
  project: Schema.Literals(["project-a", "project-b"]),
});

describe("buildNeedsYouList", () => {
  it.prop(
    "holds exactly the boards' Needs you cards from every project and environment, with the board's reason and pull request, and its total equals the tile counts",
    [Schema.Array(PlacedThreadSpecSchema)],
    ([specs]) => {
      const threads = specs.map((spec, index) => placed(shell(`thread-${index}`, spec), spec));
      const byProject = new Map<string, EnvironmentThreadShell[]>();
      for (const thread of threads) {
        const key = `${thread.environmentId}/${thread.projectId}`;
        byProject.set(key, [...(byProject.get(key) ?? []), thread]);
      }
      const boardCards = new Map<
        string,
        ReturnType<typeof buildProjectBoard>[number]["cards"][number]
      >();
      let tileTotal = 0;
      for (const projectThreads of byProject.values()) {
        tileTotal += countProjectBoard(projectThreads)["needs-you"];
        const column = buildProjectBoard(projectThreads).find((entry) => entry.id === "needs-you")!;
        for (const card of column.cards) boardCards.set(rowKey(card), card);
      }

      const full = buildNeedsYouList(threads, { limit: Number.POSITIVE_INFINITY });
      assert.equal(full.total, tileTotal);
      assert.deepEqual(full.items.map(rowKey).toSorted(), [...boardCards.keys()].toSorted());
      for (const item of full.items) {
        const card = boardCards.get(rowKey(item))!;
        assert.equal(item.reason, card.reason);
        assert.deepEqual(item.pullRequest, card.pullRequest);
      }

      const shown = buildNeedsYouList(threads);
      assert.equal(shown.total, tileTotal);
      assert.deepEqual(shown.items.map(rowKey), full.items.slice(0, 5).map(rowKey));
    },
    { arbitrary: { seed: 42 } },
  );

  it.prop(
    "ranks open pull requests, then stopped agents, then the rest, longest wait first in each group, in the same order whatever order the threads arrive in",
    [Schema.Array(PlacedThreadSpecSchema)],
    ([specs]) => {
      const threads = specs.map((spec, index) => placed(shell(`thread-${index}`, spec), spec));
      const specByKey = new Map(
        threads.map((thread, index) => [rowKey({ thread }), specs[index]!]),
      );
      const list = buildNeedsYouList(threads, { limit: Number.POSITIVE_INFINITY });
      const ranks = list.items.map((item) => {
        const spec = specByKey.get(rowKey(item))!;
        return [expectedGroup(spec), spec.minute] as const;
      });
      for (let index = 1; index < ranks.length; index += 1) {
        const [previousGroup, previousMinute] = ranks[index - 1]!;
        const [group, minute] = ranks[index]!;
        assert.isTrue(
          previousGroup < group || (previousGroup === group && previousMinute <= minute),
          `row ${index} is out of order`,
        );
      }
      for (const item of list.items) {
        assert.equal(item.waitingSince, at(specByKey.get(rowKey(item))!.minute));
      }
      const reversed = buildNeedsYouList(threads.toReversed(), {
        limit: Number.POSITIVE_INFINITY,
      });
      assert.deepEqual(reversed.items.map(rowKey), list.items.map(rowKey));
    },
    { arbitrary: { seed: 42 } },
  );

  it("puts an open pull request first, then a stopped agent, then the rest, even when the rest waited longer", () => {
    const list = buildNeedsYouList(
      [
        shell("merged-question", { minute: 0, hasPendingUserInput: true, pullRequest: "merged" }),
        shell("question", { minute: 1, hasPendingUserInput: true }),
        shell("failed", { minute: 2, run: "failed" }),
        shell("error", { minute: 3, lastError: true }),
        shell("pr-approval", {
          minute: 4,
          run: "running",
          hasPendingApprovals: true,
          pullRequest: "open",
        }),
        shell("pr-failed", { minute: 5, run: "failed", pullRequest: "open" }),
      ],
      { limit: Number.POSITIVE_INFINITY },
    );
    assert.deepEqual(
      list.items.map((item) => item.thread.id as string),
      ["pr-approval", "pr-failed", "failed", "error", "merged-question", "question"],
    );
  });

  it("starts the wait when the pending question was asked, and at the last activity otherwise", () => {
    const asked = {
      ...shell("asked-early", { minute: 8, hasPendingUserInput: true }),
      pendingUserInputAt: at(2),
    };
    const approval = shell("approval", { minute: 5, hasPendingApprovals: true });
    const list = buildNeedsYouList([approval, asked]);
    assert.deepEqual(
      list.items.map((item) => [item.thread.id as string, item.waitingSince]),
      [
        ["asked-early", at(2)],
        ["approval", at(5)],
      ],
    );
  });

  it("puts a thread with no time last in its group, but still above a lower group", () => {
    const list = buildNeedsYouList([
      untimed(shell("untimed", { hasPendingApprovals: true })),
      shell("timed", { minute: 9, hasPendingApprovals: true }),
      untimed(shell("untimed-pr", { hasPendingApprovals: true, pullRequest: "open" })),
      shell("timed-pr", { minute: 9, hasPendingApprovals: true, pullRequest: "open" }),
    ]);
    assert.deepEqual(
      list.items.map((item) => [item.thread.id as string, item.waitingSince]),
      [
        ["timed-pr", at(9)],
        ["untimed-pr", null],
        ["timed", at(9)],
        ["untimed", null],
      ],
    );
  });

  it("keeps a fixed order for tied threads, including one thread id in two environments", () => {
    const tied = [
      placed(shell("b", { minute: 3, hasPendingApprovals: true }), {
        environment: "environment-2",
      }),
      placed(shell("same", { minute: 3, hasPendingApprovals: true }), {
        environment: "environment-2",
      }),
      placed(shell("same", { minute: 3, hasPendingApprovals: true }), {
        environment: "environment-1",
      }),
      placed(shell("a", { minute: 3, hasPendingApprovals: true }), {
        environment: "environment-1",
      }),
    ];
    const orders = [tied, tied.toReversed(), [...tied.slice(2), ...tied.slice(0, 2)]].map(
      (threads) => buildNeedsYouList(threads).items.map(rowKey),
    );
    assert.equal(orders[0]!.length, 4);
    assert.deepEqual(orders[1], orders[0]);
    assert.deepEqual(orders[2], orders[0]);
  });

  const waiting = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      shell(`waiting-${index}`, { minute: index, hasPendingApprovals: true }),
    );

  it("shows all 5 rows when exactly 5 threads wait", () => {
    const list = buildNeedsYouList(waiting(5));
    assert.equal(list.total, 5);
    assert.deepEqual(
      list.items.map((item) => item.thread.id as string),
      ["waiting-0", "waiting-1", "waiting-2", "waiting-3", "waiting-4"],
    );
  });

  it("shows the 5 longest waiting of 6 with the full count, and all 6 when the rest are asked for", () => {
    const list = buildNeedsYouList(waiting(6));
    assert.equal(list.total, 6);
    assert.deepEqual(
      list.items.map((item) => item.thread.id as string),
      ["waiting-0", "waiting-1", "waiting-2", "waiting-3", "waiting-4"],
    );
    const all = buildNeedsYouList(waiting(6), { limit: Number.POSITIVE_INFINITY });
    assert.equal(all.total, 6);
    assert.equal(all.items.at(-1)!.thread.id, "waiting-5");
  });

  it("leaves out archived, deleted and helper threads, and is empty when nothing waits", () => {
    const helper = shell("helper", { hasPendingApprovals: true });
    const sideChat = shell("side-chat", { hasPendingUserInput: true });
    const threads = [
      shell("archived", { hasPendingApprovals: true, archived: true }),
      shell("deleted", { hasPendingUserInput: true, deleted: true }),
      {
        ...helper,
        lineage: {
          ...helper.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent" as const,
        },
      },
      { ...sideChat, lineage: { ...sideChat.lineage, sideChat: true } },
      shell("running", { run: "running" }),
      shell("checks", { pullRequest: "open" }),
      shell("done", {}),
    ];
    const list = buildNeedsYouList(threads);
    assert.equal(list.total, 0);
    assert.deepEqual(list.items, []);
    assert.equal(
      buildNeedsYouList([...threads, shell("waiting", { hasPendingApprovals: true })]).total,
      1,
    );
  });
});
