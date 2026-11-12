import { describe, expect, it } from "vite-plus/test";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { classify, parseGitDiff, type ChangedFile } from "../.github/scripts/merge-lane.cjs";

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
