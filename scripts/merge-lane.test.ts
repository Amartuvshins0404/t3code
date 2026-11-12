import { it as effectIt } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { judge, type TestResult } from "../.github/scripts/blind-checks.cjs";
import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  LANES,
  checkOutcome,
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
  runForPullRequest,
  summarize,
  type ApiFile,
  type ChangedFile,
  type ChecksLock,
  type CommitInfo,
  type Lane,
  type LaneReason,
  type LaneResult,
  type ResolvedRepair,
} from "../.github/scripts/merge-lane.cjs";
import { strengthReasons, type StrengthVerdict } from "../.github/scripts/test-strength.cjs";

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
      { ref: "6fceb557b2", onBase: true, inHistory: true },
      { ref: "94e84eee32", onBase: true, inHistory: true },
    ],
    rules: [],
  },
  {
    name: "a merged pull request number",
    title: "fix(ledger): links",
    body: "Repairs: #5",
    resolved: [{ ref: "#5", onBase: true, inHistory: true }],
    rules: [],
  },
  {
    name: "a target that is not on the base branch",
    title: "fix(web): slugs keep dashes",
    body: "Repairs: 0123456789",
    resolved: [{ ref: "0123456789", onBase: false, inHistory: false }],
    rules: ["repairs-unknown"],
  },
  {
    name: "a target outside the fix's history",
    title: "fix(web): slugs keep dashes",
    body: "Repairs: abcdef1234",
    resolved: [{ ref: "abcdef1234", onBase: true, inHistory: false }],
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

  it.each(checksCases)("$name turns the lane red for every reason", ({ input, rules }) => {
    const verdict = judgeChecks({ ...checked, ...input });
    expect(verdict.reasons.map((reason) => [reason.rule, reason.lane])).toEqual(
      rules.map((rule) => [rule, "red"]),
    );
  });

  const fingerprintOf = (file: ApiFile) =>
    judgeChecks({ ...checked, firstFiles: [file], prFiles: [file, slugSource] }).lock!.fingerprint;
  const text = Arbitrary.array(Arbitrary.schema(Schema.Literals(["a", "-", "+", " ", "@", "1"])), {
    maxLength: 8,
  }).pipe(Arbitrary.map((chars) => chars.join("")));
  const position = Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 })),
  );
  const patchLines = Arbitrary.array(
    Arbitrary.all({ kind: Arbitrary.schema(Schema.Literals(["+", "-", " "])), text, other: text }),
    { minLength: 1, maxLength: 8 },
  );
  const patchOf = (
    at: number,
    lines: ReadonlyArray<{ readonly kind: string; readonly text: string; readonly other: string }>,
    context: "text" | "other",
  ) =>
    [
      `@@ -${at},${lines.length} +${at},${lines.length} @@`,
      ...lines.map((line) => `${line.kind}${line.kind === " " ? line[context] : line.text}`),
    ].join("\n");
  const renamed = (from: string, patch: string): ApiFile => ({
    ...slugTest,
    status: "renamed",
    previous_filename: from,
    patch,
  });

  effectIt.prop(
    "a rebase that moves the hunk or changes the lines around it keeps the lock",
    [patchLines, position, position],
    ([lines, before, after]) => {
      expect(fingerprintOf(renamed("a.test.ts", patchOf(after, lines, "other")))).toBe(
        fingerprintOf(renamed("a.test.ts", patchOf(before, lines, "text"))),
      );
    },
    { arbitrary: { seed: 42 } },
  );

  effectIt.prop(
    "rewriting an added or removed line, or the name a test file came from, breaks the lock",
    [patchLines, Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })))],
    ([lines, pick]) => {
      const original = fingerprintOf(renamed("a.test.ts", patchOf(1, lines, "text")));
      expect(fingerprintOf(renamed("b.test.ts", patchOf(1, lines, "text")))).not.toBe(original);
      const changed = lines.findIndex(
        (line, index) => line.kind !== " " && index >= pick % lines.length,
      );
      if (changed === -1) return;
      const rewritten = lines.map((line, index) =>
        index === changed ? { ...line, text: `${line.text}x` } : line,
      );
      expect(fingerprintOf(renamed("a.test.ts", patchOf(1, rewritten, "text")))).not.toBe(original);
    },
    { arbitrary: { seed: 42 } },
  );

  it("locks a test file GitHub sent without a patch by its content", () => {
    const blob = (sha: string): ApiFile => ({ ...slugTest, patch: null, sha });
    expect(fingerprintOf(blob("1".repeat(40)))).not.toBe(fingerprintOf(blob("2".repeat(40))));
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
    expect(judgeRepairs({ title, body, resolved }).map((reason) => reason.rule)).toEqual([
      ...rules,
    ]);
  });

  it.each(repairsCases)(
    "$name turns the lane red for every reason",
    ({ title, body, resolved, rules }) => {
      expect(
        judgeRepairs({ title, body, resolved }).map((reason) => [reason.rule, reason.lane]),
      ).toEqual(rules.map((rule) => [rule, "red"]));
    },
  );

  it.each([
    ["Repairs: 6fceb557b2, 94e84eee32, bed3be36c1", ["6fceb557b2", "94e84eee32", "bed3be36c1"]],
    ["Text.\r\n\r\nRepairs: `12A233D6F9` and #5\r\n", ["12a233d6f9", "and", "#5"]],
  ])("reads the targets of %j", (text, refs) => {
    expect(parseRepairs(text)?.targets.map((target) => target.ref)).toEqual(refs);
  });

  it("accepts a Repairs: target already in the history the fix was built on, whatever the commit times", () => {
    const resolved: ReadonlyArray<ResolvedRepair> = [
      { ref: "6fceb557b2", onBase: true, inHistory: true },
      { ref: "#5", onBase: true, inHistory: true },
    ];
    expect(
      judgeRepairs({
        title: "fix(web): slugs keep dashes",
        body: "Repairs: 6fceb557b2, #5",
        resolved,
      }),
    ).toEqual([]);
  });

  effectIt.prop(
    "judges each Repairs: target by the base branch and the history the fix was built on alone",
    {
      title: Schema.Literals(["fix(web): slugs keep dashes", "fix!: slugs", "feat(web): slugs"]),
      targets: Schema.NonEmptyArray(
        Schema.Struct({ onBase: Schema.Boolean, inHistory: Schema.Boolean }),
      ),
    },
    ({ title, targets }) => {
      const resolved: ReadonlyArray<ResolvedRepair> = targets.map((target, index) => ({
        ref: `abcdef${String(index).padStart(4, "0")}`,
        onBase: target.onBase,
        inHistory: target.inHistory,
      }));
      const body = `Repairs: ${resolved.map((target) => target.ref).join(", ")}`;
      const refsWhere = (keep: (target: ResolvedRepair) => boolean) =>
        resolved.filter(keep).map((target) => target.ref);
      const unknown = refsWhere((target) => !target.onBase);
      const notOlder = refsWhere((target) => target.onBase && !target.inHistory);
      const expected = title.startsWith("fix")
        ? {
            ...(unknown.length > 0 ? { "repairs-unknown": unknown } : {}),
            ...(notOlder.length > 0 ? { "repairs-not-older": notOlder } : {}),
          }
        : {};
      const reasons = judgeRepairs({ title, body, resolved });
      expect(Object.fromEntries(reasons.map((entry) => [entry.rule, entry.files]))).toEqual(
        expected,
      );
      expect(reasons.every((entry) => entry.lane === "red")).toBe(true);
    },
    { arbitrary: { seed: 42 } },
  );
});

const sourceNames = ["path", "content", "checks", "repairs", "strength", "amber", "green"] as const;
type SourceName = (typeof sourceNames)[number];
const laneEvents = ["pull_request_target", "workflow_run"] as const;
type LaneEvent = (typeof laneEvents)[number];
const weakStrength: StrengthVerdict = {
  result: "weak",
  tried: 3,
  missed: 1,
  missedLines: 1,
  uncovered: 0,
  examples: [],
};
const reasonsFrom: Record<SourceName, ReadonlyArray<LaneReason>> = {
  path: classify(
    parseGitDiff(
      added(
        "apps/server/src/persistence/Migrations/065_ThreadIndexes.ts",
        "@@ -0,0 +1,1 @@\n+export {};",
      ),
    ),
    { packageDirs },
  ).reasons,
  content: classify(
    parseGitDiff(
      modified(
        "apps/web/src/lib/paths.ts",
        '@@ -0,0 +1,2 @@\n+// @effect-diagnostics nodeBuiltinImport:off\n+import * as NodePath from "node:path";',
      ),
    ),
    { packageDirs },
  ).reasons,
  checks: judgeChecks({ ...checked, prFiles: [editedSlugTest, slugSource] }).reasons,
  repairs: judgeRepairs({
    title: "fix(web): slugs keep dashes",
    body: "Slugs dropped dashes.",
    resolved: [],
  }),
  strength: strengthReasons(weakStrength, { required: true }),
  amber: classify(parseGitDiff(webFixSource), { packageDirs }).reasons,
  green: classify(parseGitDiff(modified("docs/user/slugs.md", "@@ -1,1 +1,1 @@\n-Old\n+New")), {
    packageDirs,
  }).reasons,
};
const laneFrom = (sources: ReadonlyArray<SourceName>): LaneResult => {
  const reasons = [...new Set(sources)].flatMap((source) => reasonsFrom[source]);
  const lane = LANES.reduce<Lane>(
    (top, next) => (reasons.some((entry) => entry.lane === next) ? next : top),
    "green",
  );
  return { lane, reasons };
};
const blockingRules = (result: LaneResult, required: boolean, event: LaneEvent) =>
  required && event === "pull_request_target"
    ? result.reasons
        .filter((entry) => entry.lane === "red" && entry.rule !== "test-strength")
        .map((entry) => entry.rule)
    : [];
const everyRed: ReadonlyArray<SourceName> = ["path", "content", "checks", "repairs", "strength"];
const outcomeCases: ReadonlyArray<{
  readonly name: string;
  readonly sources: ReadonlyArray<SourceName>;
  readonly required: boolean;
  readonly event: LaneEvent;
  readonly blocks: ReadonlyArray<string>;
}> = [
  {
    name: "a red path, switch on, own run",
    sources: ["path"],
    required: true,
    event: "pull_request_target",
    blocks: ["migrations"],
  },
  {
    name: "a red content line, switch on, own run",
    sources: ["content"],
    required: true,
    event: "pull_request_target",
    blocks: ["suppression"],
  },
  {
    name: "red checks, switch on, own run",
    sources: ["checks"],
    required: true,
    event: "pull_request_target",
    blocks: ["checks-touched"],
  },
  {
    name: "a red Repairs: line, switch on, own run",
    sources: ["repairs"],
    required: true,
    event: "pull_request_target",
    blocks: ["repairs-missing"],
  },
  {
    name: "green, switch on, own run",
    sources: ["green"],
    required: true,
    event: "pull_request_target",
    blocks: [],
  },
  {
    name: "amber, switch on, own run",
    sources: ["amber"],
    required: true,
    event: "pull_request_target",
    blocks: [],
  },
  {
    name: "red strength only, switch on, own run",
    sources: ["amber", "strength"],
    required: true,
    event: "pull_request_target",
    blocks: [],
  },
  {
    name: "red strength + path, switch on, own run",
    sources: ["path", "strength"],
    required: true,
    event: "pull_request_target",
    blocks: ["migrations"],
  },
  {
    name: "all red, switch off, own run",
    sources: everyRed,
    required: false,
    event: "pull_request_target",
    blocks: [],
  },
  {
    name: "all red, switch on, after Blind Checks",
    sources: everyRed,
    required: true,
    event: "workflow_run",
    blocks: [],
  },
  {
    name: "all red, switch off, after Blind Checks",
    sources: everyRed,
    required: false,
    event: "workflow_run",
    blocks: [],
  },
];
const summaryCases: ReadonlyArray<{
  readonly name: string;
  readonly sources: ReadonlyArray<SourceName>;
  readonly event: LaneEvent;
  readonly fails: boolean;
}> = [
  {
    name: "a red path, own run",
    sources: ["path"],
    event: "pull_request_target",
    fails: true,
  },
  {
    name: "a red content line, own run",
    sources: ["content"],
    event: "pull_request_target",
    fails: true,
  },
  {
    name: "red checks, after Blind Checks",
    sources: ["checks"],
    event: "workflow_run",
    fails: false,
  },
  {
    name: "a red Repairs: line, after Blind Checks",
    sources: ["repairs"],
    event: "workflow_run",
    fails: false,
  },
];
const laneInputs = {
  sources: Schema.Array(Schema.Literals(sourceNames)),
  required: Schema.Boolean,
  event: Schema.Literals(laneEvents),
};
const saysItFails = (text: string) => text.includes("this check fails");

describe("the Merge lane check fails only for a red lane on the pull request's own run", () => {
  it.each(outcomeCases)("the lane check with $name", ({ sources, required, event, blocks }) => {
    const outcome = checkOutcome({ result: laneFrom(sources), required, event });
    expect(outcome.fails).toBe(blocks.length > 0);
    expect(outcome.reasons.map((entry) => entry.rule)).toHaveLength(blocks.length);
    expect(outcome.reasons.map((entry) => entry.rule)).toEqual(expect.arrayContaining([...blocks]));
    expect(outcome.reasons.every((entry) => entry.lane === "red")).toBe(true);
  });

  effectIt.prop(
    "fails exactly for the red reasons other than test strength, with the switch on, on the pull request's own run",
    laneInputs,
    ({ sources, required, event }) => {
      const result = laneFrom(sources);
      const expected = blockingRules(result, required, event);
      const outcome = checkOutcome({ result, required, event });
      expect(outcome.fails).toBe(expected.length > 0);
      expect(outcome.reasons.map((entry) => entry.rule).sort()).toEqual([...expected].sort());
    },
    { arbitrary: { seed: 42 } },
  );

  it.each(summaryCases)("the summary for $name says this check fails: $fails", (row) => {
    const text = summarize(laneFrom(row.sources), { required: true, event: row.event });
    expect(saysItFails(text)).toBe(row.fails);
  });

  it("the summary says this check fails exactly when the check fails, over every lane, switch and event", () => {
    const lanes: ReadonlyArray<ReadonlyArray<SourceName>> = [
      ...sourceNames.map((source) => [source]),
      ["amber", "strength"],
      ["path", "strength"],
      everyRed,
      [],
    ];
    for (const sources of lanes) {
      for (const required of [true, false]) {
        for (const event of laneEvents) {
          const result = laneFrom(sources);
          expect(saysItFails(summarize(result, { required, event }))).toBe(
            blockingRules(result, required, event).length > 0,
          );
        }
      }
    }
  });

  effectIt.prop(
    "the summary says this check fails exactly when checkOutcome says it fails",
    laneInputs,
    ({ sources, required, event }) => {
      const result = laneFrom(sources);
      expect(saysItFails(summarize(result, { maxFiles: 10, required, event }))).toBe(
        checkOutcome({ result, required, event }).fails,
      );
    },
    { arbitrary: { seed: 42 } },
  );
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

  effectIt.prop(
    "holds only when every test file holds",
    [
      Arbitrary.array(
        Arbitrary.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: proofCases.length - 1 })),
        ),
        { minLength: 1, maxLength: 6 },
      ),
    ],
    ([picks]) => {
      const cases = picks.map((pick, index) => {
        const { file, before, after, ok } = proofCases[pick]!;
        return { file: { ...file, file: `${index}/${file.file}` }, before, after, ok };
      });
      const report = (pick: (entry: (typeof cases)[number]) => TestResult | null) =>
        new Map(cases.flatMap((entry) => (pick(entry) ? [[entry.file.file, pick(entry)!]] : [])));
      const verdict = judge(
        { commit: "c".repeat(40), files: cases.map((entry) => entry.file) },
        report((entry) => entry.before),
        report((entry) => entry.after),
      );
      expect(verdict.ok).toBe(cases.every((entry) => entry.ok));
    },
    { arbitrary: { seed: 42 } },
  );
});

const sharedHead = "3".repeat(40);
const forkRun = (
  id: number,
  owner: string,
  branch: string,
  linked: ReadonlyArray<{ readonly number: number }> = [],
) => ({
  id,
  run_number: id,
  run_attempt: 1,
  status: "completed",
  head_sha: sharedHead,
  head_branch: branch,
  head_repository: { full_name: `${owner}/t3code` },
  pull_requests: linked,
});
const forkPull = (number: number, owner: string, branch: string) => ({
  number,
  head: { sha: sharedHead, ref: branch, repo: { full_name: `${owner}/t3code` } },
  base: { ref: "amaraa-mode" },
});
const pullAda = forkPull(21, "ada", "fix-slugs");
const pullBo = forkPull(22, "bo", "fix-slugs");
const pullHere = forkPull(23, "Amartuvshins0404", "fix-slugs-here");
const runAda = forkRun(101, "ada", "fix-slugs");
const runBo = forkRun(102, "bo", "fix-slugs");
const runHere = forkRun(100, "Amartuvshins0404", "fix-slugs-here", [{ number: 23 }]);
const ownRunCases: ReadonlyArray<{
  readonly name: string;
  readonly runs: ReadonlyArray<ReturnType<typeof forkRun>>;
  readonly pr: ReturnType<typeof forkPull>;
  readonly reads: number | null;
}> = [
  {
    name: "a fork pull request whose commit another fork ran later",
    runs: [runAda, runBo],
    pr: pullAda,
    reads: 101,
  },
  {
    name: "the other fork pull request at the same commit",
    runs: [runAda, runBo],
    pr: pullBo,
    reads: 102,
  },
  {
    name: "a fork pull request with no run of its own yet",
    runs: [runBo],
    pr: pullAda,
    reads: null,
  },
  {
    name: "a branch in this repository whose commit a fork also ran",
    runs: [runHere, runBo],
    pr: pullHere,
    reads: 100,
  },
];

const strengthMarker = "<!-- test-strength -->";
const webEditNames = [
  "line endings",
  "a note at the end",
  "a note above the strength section",
  "a blank line removed",
  "a new line at the end",
] as const;
const webEdits: Record<(typeof webEditNames)[number], (text: string) => string> = {
  "line endings": (text) => text.replace(/\r?\n/g, "\r\n"),
  "a note at the end": (text) => `${text}\r\n\r\nChecked by hand.`,
  "a note above the strength section": (text) =>
    text.replace(/(\r?\n)(\r?\n)<!-- test-strength -->/, `$1Seen.$1$2${strengthMarker}`),
  "a blank line removed": (text) =>
    text.replace(/(\r?\n)\r?\n<!-- test-strength -->/, `$1${strengthMarker}`),
  "a new line at the end": (text) => `${text}\r\n`,
};
const countOf = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

const commitPieces = [
  "@octocat",
  "#12",
  "GH-7",
  "6fceb557b2",
  "https://x.io",
  "www.x.io",
  "[a](b)",
  "<b>",
  "&#64;x",
  "<!--",
  "-->",
  "--!>",
  "`",
  "``",
  "\\",
  "\n",
  "\r\n",
  "\r",
  "# ",
  "===",
  "|",
  "fine words",
] as const;
const commitText = Schema.Tuple([
  Schema.NonEmptyArray(Schema.Literals(commitPieces)).check(Schema.isMaxLength(5)),
  Schema.String.check(Schema.isMaxLength(12)),
]);
const joined = ([pieces, tail]: readonly [ReadonlyArray<string>, string]) =>
  `${pieces.join("")}${tail}`;
const outsideCodeSpans = (line: string) => {
  let out = "";
  let at = 0;
  while (at < line.length) {
    if (line[at] === "\\" && at + 1 < line.length) {
      out += line.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (line[at] !== "`") {
      out += line[at];
      at += 1;
      continue;
    }
    let open = 0;
    while (line[at + open] === "`") open += 1;
    let scan = at + open;
    let close = -1;
    while (scan < line.length && close === -1) {
      if (line[scan] !== "`") {
        scan += 1;
        continue;
      }
      let run = 0;
      while (line[scan + run] === "`") run += 1;
      if (run === open) close = scan;
      scan += run;
    }
    if (close === -1) {
      out += line.slice(at, at + open);
      at += open;
    } else {
      out += " ";
      at = close + open;
    }
  }
  return out;
};
const markupOutsideCode = /[@<>[\]&#]|:\/\/|www\.|[0-9a-f]{7}|gh-\d/i;
const lockFromCommits = (kind: "checks" | "none", reason: string, stem: string, test: string) => {
  const file = `${stem}.test.ts`;
  const lock: ChecksLock = {
    commit: "c".repeat(40),
    fingerprint: "f".repeat(64),
    kind,
    ...(kind === "none" ? { reason } : {}),
    files: [{ file, status: "added", key: "k".repeat(64), tests: [test] }],
  };
  return {
    lock,
    checks: {
      state: "checks revised" as const,
      reasons: [],
      lock,
      changes: [{ file, before: [test], after: [`${test}!`] }],
    },
  };
};

describe("the lane bot comment holds each pull request's own result, as plain text", () => {
  it.each(ownRunCases)("reads the strength of $name from run $reads", ({ runs, pr, reads }) => {
    expect(runForPullRequest({ runs, pr })?.id ?? null).toBe(reads);
  });

  it("writes the result of each fork's run to that fork's pull request", () => {
    expect(
      [runHere, runAda, runBo].map((run) =>
        pullRequestForRun({ run, open: [pullHere, pullAda, pullBo], defaultBranch: "amaraa-mode" }),
      ),
    ).toEqual([23, 21, 22]);
  });

  effectIt.prop(
    "keeps one strength section and the lock after a person edits the comment on the web page",
    {
      names: Schema.NonEmptyArray(Schema.Literals(lockedNames)),
      firstStrength: Schema.Literals(strengthSections),
      runs: Schema.NonEmptyArray(
        Schema.Struct({
          edits: Schema.NonEmptyArray(Schema.Literals(webEditNames)),
          lane: Schema.Literals(["green", "amber", "red"]),
          history: Schema.Literals(historyNames),
          strength: Schema.Literals(strengthSections),
        }),
      ),
    },
    ({ names, firstStrength, runs }) => {
      const file = lockedFile(names);
      const first = judgeChecks({ ...checked, ...histories.checked(file) });
      const saved = first.lock;
      let comment = renderBotComment({ previous: null, checks: first, strength: firstStrength });
      for (const run of runs) {
        const edited = run.edits.reduce((text, edit) => webEdits[edit](text), comment);
        const now = judgeChecks({
          ...checked,
          ...histories[run.history](file),
          lane: run.lane,
          lock: readLock(edited),
        });
        comment = renderBotComment({ previous: edited, checks: now, strength: run.strength });
        expect(countOf(comment, /<!-- test-strength -->/g)).toBe(1);
        expect(countOf(comment, /^#{1,6}[ \t]+Test strength/gm)).toBe(1);
        expect(comment).toContain(run.strength);
        expect(readLock(comment)).toEqual(saved);
      }
    },
    { arbitrary: { seed: 26601, runs: 200 } },
  );

  effectIt.prop(
    "shows text from commits as plain text that cannot cut the lock short",
    {
      kind: Schema.Literals(["checks", "none"]),
      reason: commitText,
      stem: commitText,
      test: commitText,
    },
    ({ kind, reason, stem, test }) => {
      const texts = [joined(reason), joined(stem), joined(test)];
      const tricky = lockFromCommits(kind, texts[0]!, texts[1]!, texts[2]!);
      const plain = lockFromCommits(kind, "plain", "plain", "plain");
      const body = renderLockComment(tricky.lock, tricky.checks);
      const lines = body.split(/\r\n|\r|\n/);
      const plainLines = renderLockComment(plain.lock, plain.checks).split(/\r\n|\r|\n/);
      expect(lines.length).toBe(plainLines.length);
      const marker = lines[0]!;
      expect(marker.endsWith("-->")).toBe(true);
      expect(marker.slice(0, -3)).not.toMatch(/--!?>/);
      expect(readLock(body)).toEqual(tricky.lock);
      lines.slice(1).forEach((line, index) => {
        if (line === plainLines[index + 1]) return;
        expect(outsideCodeSpans(line)).not.toMatch(markupOutsideCode);
      });
      const shown = lines.slice(1).join("\n");
      const words = (kind === "none" ? texts : texts.slice(1)).flatMap(
        (text) => text.match(/[A-Za-z0-9]+/g) ?? [],
      );
      for (const word of words) expect(shown).toContain(word);
    },
    { arbitrary: { seed: 26602, runs: 300 } },
  );
});
