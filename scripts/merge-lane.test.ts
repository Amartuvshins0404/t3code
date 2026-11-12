import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { judge, type TestResult } from "../.github/scripts/blind-checks.cjs";
import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  classify,
  judgeChecks,
  judgeRepairs,
  parseGitDiff,
  parseRepairs,
  pullRequestForRun,
  readLock,
  renderBotComment,
  renderChanges,
  renderLockComment,
  type ApiFile,
  type ChangedFile,
  type ChecksLock,
  type CommitInfo,
  type Lane,
  type ResolvedRepair,
} from "../.github/scripts/merge-lane.cjs";

const packageDirs = readWorkspace().map((pkg) => pkg.dir);

const modified = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const added = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${path}\n${body}`;
const deleted = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${path}\n+++ /dev/null\n${body}`;

const webFixSource = modified(
  "apps/web/src/components/files/LargeTextViewer.tsx",
  `@@ -10,0 +11,4 @@ const FIRST_SCREEN_BYTES = 16 * 1024;
+function countLabel(count: number, noun: string) {
+  return \`\${count.toLocaleString()} \${noun}\${count === 1 ? "" : "s"}\`;
+}
+`,
);
const webFixTest = modified(
  "apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx",
  `@@ -1299,0 +1300,3 @@ it("copies every indexed line rather than the mounted preview rows", async () =>
+it.each([["one.csv", "1 row"]] as const)("labels the counts of %s in the status line", async (name, label) => {
+  expect(name).toContain(label);
+});`,
);

const cases: ReadonlyArray<{
  readonly name: string;
  readonly diff: string;
  readonly lane: "green" | "amber" | "red";
  readonly rules: ReadonlyArray<string>;
}> = [
  {
    name: "98837f1a5e docs-only user guide edit",
    diff: modified(
      "docs/user/providers-claude.md",
      "@@ -40,0 +41,2 @@\n+Start Claude with `--chrome`.\n+",
    ),
    lane: "green",
    rules: ["docs"],
  },
  {
    name: "a package README is documentation, not app code",
    diff: modified("apps/mobile/README.md", "@@ -1,1 +1,1 @@\n-Old\n+New"),
    lane: "green",
    rules: ["docs"],
  },
  {
    name: "ee90bdc940 plain web fix with a new browser test",
    diff: `${webFixSource}\n${webFixTest}`,
    lane: "amber",
    rules: ["app-code"],
  },
  {
    name: "AGENTS.md is text models read, never docs-only",
    diff: modified("AGENTS.md", "@@ -10,1 +10,1 @@\n-Old rule\n+New rule"),
    lane: "red",
    rules: ["model-text"],
  },
  {
    name: "a25654c396 new server migration",
    diff: added(
      "apps/server/src/persistence/Migrations/065_ThreadIndexes.ts",
      '@@ -0,0 +1,2 @@\n+import * as SqlClient from "effect/unstable/sql/SqlClient";\n+export default SqlClient.SqlClient;',
    ),
    lane: "red",
    rules: ["migrations"],
  },
  {
    name: "dc032d7c8f contracts settings change",
    diff: modified(
      "packages/contracts/src/settings.ts",
      "@@ -80,0 +81,1 @@\n+  sourceControlHosts: Schema.Array(Schema.String),",
    ),
    lane: "red",
    rules: ["contracts"],
  },
  {
    name: "3fd7b75e25 CI workflow change",
    diff: modified(
      ".github/workflows/ci.yml",
      "@@ -20,1 +20,1 @@\n-    timeout-minutes: 10\n+    timeout-minutes: 20",
    ),
    lane: "red",
    rules: ["ci-release"],
  },
  {
    name: "an infra/auth change, the service fork PR #1 added",
    diff: modified(
      "infra/auth/src/auth.ts",
      "@@ -1,1 +1,1 @@\n-const ttl = 60;\n+const ttl = 600;",
    ),
    lane: "red",
    rules: ["deploy", "auth"],
  },
  {
    name: "c72de5249a deletes a test file",
    diff: `${deleted(
      "apps/mobile/src/state/use-selected-thread-worktree.test.ts",
      '@@ -1,3 +0,0 @@\n-it("keeps the selected worktree", () => {\n-  expect(true).toBe(true);\n-});',
    )}\n${modified("apps/mobile/src/state/use-selected-thread-worktree.ts", "@@ -5,1 +5,0 @@\n-export const unused = 1;")}`,
    lane: "red",
    rules: ["deleted-test", "fewer-tests"],
  },
  {
    name: "b68aedfdb7 adds a skipIf to a test",
    diff: modified(
      "packages/provider-opencode/src/server/v2/OpenCode2Service.test.ts",
      `@@ -26,0 +27,3 @@
+  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
+    "replaces only this install's 2.x service, keeping its configured env",
+    () =>`,
    ),
    lane: "red",
    rules: ["test-skip"],
  },
  {
    name: "b3fdf2b10f adds a lint suppression",
    diff: modified(
      "apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx",
      `@@ -140,0 +141,3 @@
+  useEffect(() => {
+    // oxlint-disable-next-line react/set-state-in-effect -- URL navigation selects the PR section and makes its target visible
+    followLink();`,
    ),
    lane: "red",
    rules: ["suppression"],
  },
  {
    name: "the reasoned effect comment AGENTS.md asks for",
    diff: modified(
      "apps/web/src/speech/useDictationShortcut.ts",
      `@@ -67,0 +68,2 @@
+  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the window keyboard listeners
+  useEffect(() => subscribe(), []);`,
    ),
    lane: "amber",
    rules: ["app-code"],
  },
  {
    name: "the same effect comment without a reason",
    diff: modified(
      "apps/web/src/speech/useDictationShortcut.ts",
      `@@ -67,0 +68,2 @@
+  // oxlint-disable-next-line t3code/no-unreasoned-state-sync
+  useEffect(() => subscribe(), []);`,
    ),
    lane: "red",
    rules: ["suppression"],
  },
  {
    name: "the Node import switch in a test file",
    diff: modified(
      "apps/web/src/lib/paths.test.ts",
      `@@ -0,0 +1,2 @@
+// @effect-diagnostics nodeBuiltinImport:off
+import * as NodePath from "node:path";`,
    ),
    lane: "amber",
    rules: ["app-code"],
  },
  {
    name: "the Node import switch in app source",
    diff: modified(
      "apps/web/src/lib/paths.ts",
      `@@ -0,0 +1,2 @@
+// @effect-diagnostics nodeBuiltinImport:off
+import * as NodePath from "node:path";`,
    ),
    lane: "red",
    rules: ["suppression"],
  },
  {
    name: "the Node import switch with a second check switched off",
    diff: modified(
      "apps/web/src/lib/paths.test.ts",
      `@@ -0,0 +1,2 @@
+// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
+import * as NodePath from "node:path";`,
    ),
    lane: "red",
    rules: ["suppression"],
  },
  {
    name: "a removed test case with no replacement",
    diff: modified(
      "apps/server/src/git/GitWorkflowService.test.ts",
      '@@ -10,3 +10,0 @@\n-  it.effect("refuses a dirty tree", () =>\n-    Effect.void,\n-  );',
    ),
    lane: "red",
    rules: ["fewer-tests"],
  },
  {
    name: "a renamed test case keeps the count",
    diff: modified(
      "apps/server/src/git/GitWorkflowService.test.ts",
      '@@ -10,1 +10,1 @@\n-  it.effect("refuses a dirty tree", () =>\n+  it.effect("refuses a tree with uncommitted changes", () =>',
    ),
    lane: "amber",
    rules: ["app-code"],
  },
  {
    name: "a path no rule knows fails closed",
    diff: modified("tools/new-thing/run.ts", "@@ -1,0 +1,1 @@\n+export {};"),
    lane: "red",
    rules: ["unknown-path"],
  },
  {
    name: "a root package manifest is a dependency change",
    diff: modified(
      "package.json",
      '@@ -30,1 +30,1 @@\n-    "lint": "vp lint",\n+    "lint": "true",',
    ),
    lane: "red",
    rules: ["dependencies"],
  },
  {
    name: "a change to the lane rules is never self-approving",
    diff: modified(
      ".github/scripts/merge-lane.cjs",
      '@@ -1,1 +1,1 @@\n-const a = "red";\n+const a = "green";',
    ),
    lane: "red",
    rules: ["lane-rules"],
  },
];

describe("merge lane", () => {
  it.each(cases)("$name -> $lane", ({ diff, lane, rules }) => {
    const result = classify(parseGitDiff(diff), { packageDirs });
    expect(result.lane).toBe(lane);
    expect(
      result.reasons.filter((reason) => reason.lane === lane).map((reason) => reason.rule),
    ).toEqual(expect.arrayContaining([...rules]));
  });

  it("names the files behind each reason, highest lane first", () => {
    const result = classify(
      parseGitDiff(
        `${webFixSource}\n${modified("packages/contracts/src/relay.ts", "@@ -1,0 +1,1 @@\n+export {};")}`,
      ),
      {
        packageDirs,
      },
    );
    expect(result.reasons[0]).toMatchObject({
      rule: "contracts",
      lane: "red",
      files: ["packages/contracts/src/relay.ts"],
    });
    expect(result.reasons.find((reason) => reason.rule === "app-code")?.files).toContain(
      "apps/web/src/components/files/LargeTextViewer.tsx",
    );
  });

  it("treats a code file GitHub sent without a patch as red, but not an image", () => {
    const image: ChangedFile = {
      filename: "apps/web/public/icon.png",
      status: "modified",
      changes: 0,
    };
    const tooLarge: ChangedFile = {
      filename: "apps/web/src/routeTree.ts",
      status: "modified",
      changes: 4000,
    };
    expect(classify([image], { packageDirs }).lane).toBe("amber");
    expect(
      classify([image, tooLarge], { packageDirs }).reasons.map((reason) => reason.rule),
    ).toContain("unreadable-diff");
  });

  it("is red when GitHub listed only part of the changed files", () => {
    const files = parseGitDiff(modified("docs/user/install.md", "@@ -1,1 +1,1 @@\n-a\n+b"));
    expect(classify(files, { packageDirs, fileListComplete: false }).lane).toBe("red");
  });

  it("reads renames and binary files from git output", () => {
    const files = parseGitDiff(
      [
        "diff --git a/apps/web/src/Old.tsx b/apps/web/src/New.tsx",
        "similarity index 90%",
        "rename from apps/web/src/Old.tsx",
        "rename to apps/web/src/New.tsx",
        "--- a/apps/web/src/Old.tsx",
        "+++ b/apps/web/src/New.tsx",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "diff --git a/assets/logo.png b/assets/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/assets/logo.png and b/assets/logo.png differ",
      ].join("\n"),
    );
    expect(files).toMatchObject([
      {
        filename: "apps/web/src/New.tsx",
        previous_filename: "apps/web/src/Old.tsx",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
      { filename: "assets/logo.png", binary: true, patch: null },
    ]);
    expect(classify(files, { packageDirs }).lane).toBe("amber");
  });
});

const slugTest: ApiFile = {
  filename: "apps/web/src/lib/slug.test.ts",
  status: "added",
  patch: '@@ -0,0 +1,2 @@\n+it("keeps letters", () => {});\n+it("drops spaces", () => {});',
};
const editedSlugTest: ApiFile = {
  ...slugTest,
  patch: '@@ -0,0 +1,2 @@\n+it("keeps letters", () => {});\n+it("accepts anything", () => {});',
};
const slugSource: ApiFile = {
  filename: "apps/web/src/lib/slug.ts",
  status: "added",
  patch: "@@ -0,0 +1,1 @@\n+export const slug = (text: string) => text;",
};
const slugHelper: ApiFile = {
  filename: "apps/web/src/lib/testkit/slugInputs.ts",
  status: "added",
  patch: '@@ -0,0 +1,1 @@\n+export const inputs = ["a b"];',
};
const commit = (sha: string, message: string): CommitInfo => ({
  sha: sha.repeat(40),
  message,
});
const checks = commit("c", "test(web): checks for slugs\n\nBlind-checks: written from the request");
const rebased = commit("e", checks.message);
const code = commit("d", "feat(web): slugs");
const revision = commit(
  "f",
  "test(web): revise a check\n\nBlind-checks: revised after an objection",
);
const noTest = (reason: string) => commit("a", `chore: start\n\nBlind-checks: ${reason}`);
const request = "## Request\n\nTurn a title into a URL slug.\n\n## Proven\n";

const checked = {
  lane: "amber" as Lane,
  body: request,
  commits: [checks, code],
  firstFiles: [slugTest],
  prFiles: [slugTest, slugSource],
  lock: null as ChecksLock | null,
};
const originalLock = judgeChecks(checked).lock;

const docsOnly = commit("b", "docs(user): slugs guide");
const docsEdit: ApiFile = {
  filename: "docs/user/slugs.md",
  status: "modified",
  patch: "@@ -1,1 +1,1 @@\n-Slugs.\n+Slugs keep letters.",
};
const lockedNames = ["keeps letters", "drops spaces", "ends a comment -->"] as const;
const lockedFile = (names: ReadonlyArray<string>): ApiFile => ({
  filename: slugTest.filename,
  status: "added",
  patch: [
    `@@ -0,0 +1,${names.length} @@`,
    ...names.map((name) => `+it(${JSON.stringify(name)}, () => {});`),
  ].join("\n"),
});
const historyNames = [
  "checked",
  "rebased",
  "docs only",
  "checks gone",
  "rewritten",
  "revised",
] as const;
const histories: Record<
  (typeof historyNames)[number],
  (file: ApiFile) => Pick<typeof checked, "commits" | "firstFiles" | "prFiles">
> = {
  checked: (file) => ({ commits: [checks, code], firstFiles: [file], prFiles: [file, slugSource] }),
  rebased: (file) => ({
    commits: [rebased, code],
    firstFiles: [file],
    prFiles: [file, slugSource],
  }),
  "docs only": () => ({ commits: [docsOnly], firstFiles: [docsEdit], prFiles: [docsEdit] }),
  "checks gone": () => ({ commits: [code], firstFiles: [], prFiles: [slugSource] }),
  rewritten: () => ({
    commits: [rebased, code],
    firstFiles: [editedSlugTest],
    prFiles: [editedSlugTest, slugSource],
  }),
  revised: (file) => ({
    commits: [checks, revision, code],
    firstFiles: [file],
    prFiles: [editedSlugTest, slugSource],
  }),
};
const strengthSections = [
  "### Test strength: strong\n\nThe tests noticed all 3 breaks tried.",
  "### Test strength: not measured\n\nBlind checks has not finished for this commit yet.",
] as const;

const checksCases: ReadonlyArray<{
  readonly name: string;
  readonly input: Partial<typeof checked>;
  readonly rules: ReadonlyArray<string>;
  readonly state: string | null;
}> = [
  {
    name: "an amber change with no checks commit is not checked blind",
    input: { commits: [code], firstFiles: [], prFiles: [slugSource] },
    rules: ["checks-missing"],
    state: "no checks",
  },
  {
    name: "a red change with no checks commit has no checks rules",
    input: { lane: "red", commits: [code], firstFiles: [], prFiles: [slugSource] },
    rules: [],
    state: "no checks",
  },
  {
    name: "a green change is exempt",
    input: { lane: "green", commits: [code], firstFiles: [] },
    rules: [],
    state: null,
  },
  {
    name: "checks first, code after, tests untouched",
    input: {},
    rules: [],
    state: "checked blind",
  },
  {
    name: "a red change with checks gets the checks rules",
    input: { lane: "red", prFiles: [editedSlugTest, slugSource] },
    rules: ["checks-touched"],
    state: "checks revised",
  },
  {
    name: "a checks commit that also writes code",
    input: { firstFiles: [slugTest, slugSource] },
    rules: ["checks-not-tests"],
    state: "checked blind",
  },
  {
    name: "a checks commit with only a test helper",
    input: { firstFiles: [slugHelper], prFiles: [slugHelper, slugSource] },
    rules: ["checks-not-tests"],
    state: "checked blind",
  },
  {
    name: "no test needed, said with a reason in an empty first commit",
    input: {
      commits: [noTest("none, copy text only"), code],
      firstFiles: [],
      prFiles: [slugSource],
    },
    rules: [],
    state: "none needed",
  },
  {
    name: "no test needed, with no reason",
    input: { commits: [noTest("none"), code], firstFiles: [], prFiles: [slugSource] },
    rules: ["checks-none-invalid"],
    state: "none needed",
  },
  {
    name: "no test needed, in a commit that changes files",
    input: { commits: [noTest("none, refactor"), code], firstFiles: [slugSource] },
    rules: ["checks-none-invalid"],
    state: "none needed",
  },
  {
    name: "the coder edits a locked test",
    input: { prFiles: [editedSlugTest, slugSource] },
    rules: ["checks-touched"],
    state: "checks revised",
  },
  {
    name: "the coder puts a locked test back as it was",
    input: { prFiles: [slugSource] },
    rules: ["checks-touched"],
    state: "checks revised",
  },
  {
    name: "the coder adds a test helper",
    input: { prFiles: [slugTest, slugHelper, slugSource] },
    rules: ["checks-touched"],
    state: "checks revised",
  },
  {
    name: "a later commit marked as checks revises them",
    input: { commits: [checks, revision, code], prFiles: [editedSlugTest, slugSource] },
    rules: ["checks-revised"],
    state: "checks revised",
  },
  {
    name: "a rewritten checks commit no longer matches its lock",
    input: {
      commits: [rebased, code],
      firstFiles: [editedSlugTest],
      prFiles: [editedSlugTest, slugSource],
      lock: originalLock,
    },
    rules: ["checks-rewritten"],
    state: "checks revised",
  },
  {
    name: "a rebased checks commit keeps its lock",
    input: { commits: [rebased, code], lock: originalLock },
    rules: [],
    state: "checked blind",
  },
  {
    name: "a locked checks commit that is gone",
    input: { commits: [code], firstFiles: [], prFiles: [slugSource], lock: originalLock },
    rules: ["checks-rewritten"],
    state: "checks revised",
  },
  {
    name: "checks without a ## Request section",
    input: { body: "## Why\n\nSlugs.\n" },
    rules: ["request-missing"],
    state: "checked blind",
  },
  {
    name: "an empty ## Request section",
    input: { body: "## Request\n\n## Why\n\nSlugs.\n" },
    rules: ["request-missing"],
    state: "checked blind",
  },
  {
    name: "a ## Request section written with Windows line ends",
    input: { body: request.replace(/\n/g, "\r\n") },
    rules: [],
    state: "checked blind",
  },
];

const older = 1_000;
const fixTime = 2_000;
const repairsCases: ReadonlyArray<{
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly resolved: ReadonlyArray<ResolvedRepair>;
  readonly rules: ReadonlyArray<string>;
}> = [
  {
    name: "a feature needs no Repairs: line",
    title: "feat(web): slugs",
    body: "",
    resolved: [],
    rules: [],
  },
  {
    name: "a fix with no Repairs: line",
    title: "fix(web): slugs keep dashes",
    body: "Slugs dropped dashes.",
    resolved: [],
    rules: ["repairs-missing"],
  },
  {
    name: "a fix with an empty Repairs: line",
    title: "fix(web): slugs keep dashes",
    body: "Repairs:",
    resolved: [],
    rules: ["repairs-missing"],
  },
  {
    name: "fork PR 7's form: two older commits on the base branch",
    title: "fix(test): the fork's base branch is green again",
    body: "Repairs: 6fceb557b2, 94e84eee32",
    resolved: [
      { ref: "6fceb557b2", onBase: true, time: older },
      { ref: "94e84eee32", onBase: true, time: older },
    ],
    rules: [],
  },
  {
    name: "a merged pull request number",
    title: "fix(ledger): links",
    body: "Repairs: #5",
    resolved: [{ ref: "#5", onBase: true, time: older }],
    rules: [],
  },
  {
    name: "a target that is not on the base branch",
    title: "fix(web): slugs keep dashes",
    body: "Repairs: 0123456789",
    resolved: [{ ref: "0123456789", onBase: false, time: null }],
    rules: ["repairs-unknown"],
  },
  {
    name: "a target newer than the fix",
    title: "fix(web): slugs keep dashes",
    body: "Repairs: abcdef1234",
    resolved: [{ ref: "abcdef1234", onBase: true, time: fixTime + 1 }],
    rules: ["repairs-not-older"],
  },
  {
    name: "a fix of code older than the window",
    title: "fix!: slugs keep dashes",
    body: "Repairs: none, older than 14 days",
    resolved: [],
    rules: [],
  },
];

describe("locked checks", () => {
  it.each(checksCases)("$name", ({ input, rules, state }) => {
    const verdict = judgeChecks({ ...checked, ...input });
    expect(verdict.reasons.map((reason) => reason.rule)).toEqual([...rules]);
    expect(verdict.state).toBe(state);
  });

  it("tells the owner in plain words how a locked test changed", () => {
    const verdict = judgeChecks({ ...checked, prFiles: [editedSlugTest, slugHelper, slugSource] });
    expect(renderChanges(verdict.changes).split("\n").slice(2)).toEqual([
      '- `apps/web/src/lib/slug.test.ts`: locked with 2 tests, now 2. Gone: "drops spaces". New: "accepts anything".',
      "- `apps/web/src/lib/testkit/slugInputs.ts`: a test helper changed after the lock.",
    ]);
  });

  it("reads back the lock it wrote, whatever the test names hold", () => {
    const tricky: ApiFile = {
      ...slugTest,
      patch: '@@ -0,0 +1,1 @@\n+it("ends a comment -->", () => {});',
    };
    const verdict = judgeChecks({
      ...checked,
      firstFiles: [tricky],
      prFiles: [tricky, slugSource],
    });
    const lock = verdict.lock!;
    expect(lock.files[0]?.tests).toEqual(["ends a comment -->"]);
    expect(readLock(renderLockComment(lock, verdict))).toEqual(lock);
  });

  it("still calls a weaker checks commit rewritten after a green docs-only run", () => {
    const locked = renderBotComment({
      previous: null,
      checks: judgeChecks(checked),
      strength: null,
    });
    const green = judgeChecks({ ...checked, ...histories["docs only"](slugTest), lane: "green" });
    const afterGreen = renderBotComment({
      previous: locked,
      checks: green,
      strength: strengthSections[1],
    });
    expect(readLock(afterGreen)).toEqual(originalLock);
    const weaker = judgeChecks({
      ...checked,
      ...histories.rewritten(slugTest),
      lock: readLock(afterGreen),
    });
    expect(weaker.reasons.map((reason) => reason.rule)).toEqual(["checks-rewritten"]);
    expect(weaker.state).toBe("checks revised");
  });

  effectIt.prop(
    "keeps the saved lock in its one comment on every later run",
    {
      names: Schema.NonEmptyArray(Schema.Literals(lockedNames)),
      firstStrength: Schema.NullOr(Schema.Literals(strengthSections)),
      writtenBefore: Schema.Boolean,
      runs: Schema.Array(
        Schema.Struct({
          lane: Schema.Literals(["green", "amber", "red"]),
          history: Schema.Literals(historyNames),
          strength: Schema.NullOr(Schema.Literals(strengthSections)),
        }),
      ),
    },
    ({ names, firstStrength, writtenBefore, runs }) => {
      const file = lockedFile(names);
      const first = judgeChecks({ ...checked, ...histories.checked(file) });
      const saved = first.lock;
      expect(saved).not.toBeNull();
      let comment = writtenBefore
        ? renderLockComment(saved!, first)
        : renderBotComment({ previous: null, checks: first, strength: firstStrength });
      expect(readLock(comment)).toEqual(saved);
      for (const run of runs) {
        const now = judgeChecks({
          ...checked,
          ...histories[run.history](file),
          lane: run.lane,
          lock: readLock(comment),
        });
        comment = renderBotComment({ previous: comment, checks: now, strength: run.strength });
        expect(readLock(comment)).toEqual(saved);
      }
    },
  );
});

const head = "1".repeat(40);
const moved = "2".repeat(40);
const openPull = (number: number, sha: string, base = "amaraa-mode") => ({
  number,
  head: { sha },
  base: { ref: base },
});
const runCases: ReadonlyArray<{
  readonly name: string;
  readonly linked: ReadonlyArray<{ readonly number: number }>;
  readonly open: ReadonlyArray<ReturnType<typeof openPull>>;
  readonly writes: number | null;
}> = [
  {
    name: "a pull request from a branch in this repository",
    linked: [{ number: 11 }],
    open: [openPull(9, moved), openPull(11, head)],
    writes: 11,
  },
  {
    name: "a pull request from another fork, which the run does not link",
    linked: [],
    open: [openPull(9, moved), openPull(12, head)],
    writes: 12,
  },
  {
    name: "a fork pull request that moved on to a newer commit",
    linked: [],
    open: [openPull(12, moved)],
    writes: null,
  },
  {
    name: "a linked pull request that moved on to a newer commit",
    linked: [{ number: 11 }],
    open: [openPull(11, moved)],
    writes: null,
  },
  {
    name: "an open pull request at that commit into another branch",
    linked: [],
    open: [openPull(14, head, "release")],
    writes: null,
  },
  {
    name: "no open pull request at all",
    linked: [],
    open: [],
    writes: null,
  },
];

describe("which pull request a finished Blind Checks run writes to", () => {
  it.each(runCases)("$name -> $writes", ({ linked, open, writes }) => {
    expect(
      pullRequestForRun({
        run: { head_sha: head, pull_requests: linked },
        open,
        defaultBranch: "amaraa-mode",
      }),
    ).toBe(writes);
  });
});

describe("Repairs: line", () => {
  it.each(repairsCases)("$name", ({ title, body, resolved, rules }) => {
    expect(judgeRepairs({ title, body, resolved, fixTime }).map((reason) => reason.rule)).toEqual([
      ...rules,
    ]);
  });

  it.each([
    ["Repairs: 6fceb557b2, 94e84eee32, bed3be36c1", ["6fceb557b2", "94e84eee32", "bed3be36c1"]],
    ["Text.\r\n\r\nRepairs: `12A233D6F9` and #5\r\n", ["12a233d6f9", "and", "#5"]],
  ])("reads the targets of %j", (text, refs) => {
    expect(parseRepairs(text)?.targets.map((target) => target.ref)).toEqual(refs);
  });
});

const loaded = (name: string, tests: ReadonlyArray<readonly [string, string]>): TestResult => ({
  name,
  assertionResults: tests.map(([title, status]) => ({ title, status })),
});
const notLoaded = (name: string): TestResult => ({
  name,
  message: "Cannot find module './slug.ts'",
  assertionResults: [],
});
const newFile = { file: slugTest.filename, added: true, tests: ["keeps letters"] };
const changedFile = {
  file: "apps/web/src/lib/title.test.ts",
  added: false,
  tests: ["slugs $title"],
};
const proofCases: ReadonlyArray<{
  readonly name: string;
  readonly file: typeof newFile;
  readonly before: TestResult | null;
  readonly after: TestResult | null;
  readonly ok: boolean;
}> = [
  {
    name: "a new file that cannot load without the code and passes with it",
    file: newFile,
    before: notLoaded(newFile.file),
    after: loaded(newFile.file, [["keeps letters", "passed"]]),
    ok: true,
  },
  {
    name: "a new file that cannot load with the code either",
    file: newFile,
    before: notLoaded(newFile.file),
    after: notLoaded(newFile.file),
    ok: false,
  },
  {
    name: "a new test that passes before the code exists",
    file: newFile,
    before: loaded(newFile.file, [["keeps letters", "passed"]]),
    after: loaded(newFile.file, [["keeps letters", "passed"]]),
    ok: false,
  },
  {
    name: "a changed file whose old tests pass and whose new test fails without the code",
    file: changedFile,
    before: loaded(changedFile.file, [
      ["keeps the title", "passed"],
      ["slugs My Title", "failed"],
    ]),
    after: loaded(changedFile.file, [
      ["keeps the title", "passed"],
      ["slugs My Title", "passed"],
    ]),
    ok: true,
  },
  {
    name: "a test that still fails with the code",
    file: changedFile,
    before: loaded(changedFile.file, [["slugs My Title", "failed"]]),
    after: loaded(changedFile.file, [["slugs My Title", "failed"]]),
    ok: false,
  },
  {
    name: "a file that did not run with the code",
    file: newFile,
    before: notLoaded(newFile.file),
    after: null,
    ok: false,
  },
];

describe("blind checks proof", () => {
  it.each(proofCases)("$name", ({ file, before, after, ok }) => {
    const report = (result: TestResult | null) =>
      new Map(result ? [[file.file, result] as const] : []);
    expect(judge({ commit: "c".repeat(40), files: [file] }, report(before), report(after)).ok).toBe(
      ok,
    );
  });
});
