// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  judge,
  planProof,
  pullRequestCommits,
  type TestResult,
} from "../.github/scripts/blind-checks.cjs";
import type { ChangedFile } from "../.github/scripts/merge-lane.cjs";

const base = "b".repeat(40);
const slugTest = "apps/web/src/lib/slug.test.ts";
const titleTest = "apps/web/src/lib/title.test.ts";
const upstreamTest = "packages/shared/src/git.test.ts";

const addedFile = (filename: string, lines: ReadonlyArray<string>): ChangedFile => ({
  filename,
  status: "added",
  patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
});
const changedFile = (filename: string, lines: ReadonlyArray<string>): ChangedFile => ({
  filename,
  status: "modified",
  patch: [
    `@@ -1,1 +1,${lines.length + 1} @@`,
    ' it("keeps the title", () => {});',
    ...lines.map((line) => `+${line}`),
  ].join("\n"),
});
const removedFile = (filename: string): ChangedFile => ({
  filename,
  status: "removed",
  patch: '@@ -1,1 +0,0 @@\n-it("keeps letters", () => {});',
});
const commit = (sha: string, message: string, files: ReadonlyArray<ChangedFile>) => ({
  sha: sha.repeat(40),
  message,
  files,
});

const checks = commit(
  "c",
  "test(web): checks for slugs\n\nBlind-checks: written from the request",
  [
    addedFile(slugTest, ['it("keeps letters", () => {});', 'it("drops spaces", () => {});']),
    addedFile("apps/web/src/lib/testkit/slugInputs.ts", ['export const inputs = ["a b"];']),
  ],
);
const code = commit("d", "feat(web): slugs", [
  addedFile("apps/web/src/lib/slug.ts", ["export const slug = (text: string) => text;"]),
]);
const revise = (files: ReadonlyArray<ChangedFile>) =>
  commit("f", "test(web): revise a check\n\nBlind-checks: revised after an objection", files);

const slugInputs = "apps/web/src/lib/testkit/slugInputs.ts";
const testSetup = "apps/web/test/setup.ts";
const supportOf = (plan: ReturnType<typeof planProof>) =>
  plan.run ? [...plan.support].sort() : [];

const sorted = (plan: ReturnType<typeof planProof>) =>
  plan.run
    ? plan.files
        .map((entry) => ({ ...entry, tests: [...entry.tests].sort() }))
        .sort((a, b) => a.file.localeCompare(b.file))
    : [];

const loaded = (file: string, tests: ReadonlyArray<readonly [string, string]>): TestResult => ({
  name: `/repo/${file}`,
  assertionResults: tests.map(([title, status]) => ({ title, status })),
});
const proven = (
  plan: ReturnType<typeof planProof>,
  before: ReadonlyArray<TestResult>,
  after: ReadonlyArray<TestResult>,
) => {
  if (!plan.run) throw new Error(`nothing planned: ${plan.note}`);
  const byFile = (results: ReadonlyArray<TestResult>) =>
    new Map(results.map((result) => [result.name.replace("/repo/", ""), result] as const));
  return judge({ commit: checks.sha, files: plan.files }, byFile(before), byFile(after)).ok;
};

describe("blind checks proof: what is planned", () => {
  it("a pull request whose checks were never revised plans the checks commit's test files, as before", () => {
    const plan = planProof({ commits: [checks, code], base });
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
    ]);
  });

  it("runs without the code on the point where the pull request left the base branch", () => {
    expect(planProof({ commits: [checks, code], base })).toMatchObject({ run: true, base });
  });

  it("plans a test file that only a revision adds or changes, with the tests the revision names", () => {
    const plan = planProof({
      commits: [
        checks,
        code,
        revise([
          changedFile(titleTest, ['it("slugs emoji", () => {});']),
          addedFile("apps/web/src/lib/url.test.ts", ['it("keeps the scheme", () => {});']),
        ]),
      ],
      base,
    });
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
      { file: titleTest, added: false, tests: ["slugs emoji"] },
      { file: "apps/web/src/lib/url.test.ts", added: true, tests: ["keeps the scheme"] },
    ]);
  });

  it("names a changed file's tests from every checks commit that touched it", () => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [changedFile(titleTest, ['it("slugs My Title", () => {});'])]),
        code,
        revise([changedFile(titleTest, ['it("slugs emoji", () => {});'])]),
      ],
      base,
    });
    expect(sorted(plan)).toEqual([
      { file: titleTest, added: false, tests: ["slugs My Title", "slugs emoji"] },
    ]);
  });

  it("leaves out a test file a revision removed, since the newest commit has no such tests", () => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [
          ...checks.files,
          changedFile(titleTest, ['it("slugs My Title", () => {});']),
        ]),
        code,
        revise([removedFile(slugTest)]),
      ],
      base,
    });
    expect(sorted(plan)).toEqual([{ file: titleTest, added: false, tests: ["slugs My Title"] }]);
  });

  it("ignores test files changed by commits with no checks trailer, such as merged base branch work", () => {
    const mergedBase = commit("e", "Merge branch 'amaraa-mode' into fix/slugs", [
      addedFile(upstreamTest, ['it("reads refs", () => {});']),
      changedFile(titleTest, ['it("trims", () => {});']),
    ]);
    const plan = planProof({ commits: [checks, mergedBase, code], base });
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
    ]);
  });

  it("keeps a test file the checks commit added as added after a revision changed it", () => {
    const plan = planProof({
      commits: [checks, code, revise([changedFile(slugTest, ['it("keeps digits", () => {});'])])],
      base,
    });
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps digits", "keeps letters"] },
    ]);
  });

  it("follows a test file a revision renamed, with the tests named under the old name and the new ones", () => {
    const renamedTest = "apps/web/src/lib/slugify.test.ts";
    const plan = planProof({
      commits: [
        checks,
        code,
        revise([
          {
            filename: renamedTest,
            previous_filename: slugTest,
            status: "renamed",
            patch: [
              "@@ -1,2 +1,3 @@",
              ' it("keeps letters", () => {});',
              ' it("drops spaces", () => {});',
              '+it("keeps digits", () => {});',
            ].join("\n"),
          },
        ]),
      ],
      base,
    });
    expect(sorted(plan)).toEqual([
      { file: renamedTest, added: true, tests: ["drops spaces", "keeps digits", "keeps letters"] },
    ]);
  });

  it("proves the tests of a revision that comes after a first commit saying no test is needed", () => {
    const urlTest = "apps/web/src/lib/url.test.ts";
    const plan = planProof({
      commits: [
        commit("a", "chore(web): slugs\n\nBlind-checks: none, copy text only", []),
        code,
        revise([addedFile(urlTest, ['it("keeps the scheme", () => {});'])]),
      ],
      base,
    });
    expect(sorted(plan)).toEqual([{ file: urlTest, added: true, tests: ["keeps the scheme"] }]);
  });
});

describe("blind checks proof: which files the base branch run takes from the newest commit", () => {
  it("takes a test-support file the checks commit changed", () => {
    expect(supportOf(planProof({ commits: [checks, code], base }))).toEqual([slugInputs]);
  });

  it("takes a test-support file that only a commit with no checks trailer changed", () => {
    const setupFix = commit("e", "fix(web): slug test setup", [
      changedFile(testSetup, ["export const locale = 'en';"]),
    ]);
    expect(supportOf(planProof({ commits: [checks, code, setupFix], base }))).toEqual(
      [slugInputs, testSetup].sort(),
    );
  });

  it("leaves code a revision edits as the base branch has it, and still plans the revision's test file", () => {
    const plan = planProof({
      commits: [
        checks,
        code,
        revise([
          changedFile(titleTest, ['it("slugs emoji", () => {});']),
          changedFile("src/real.ts", ["export const real = true;"]),
        ]),
      ],
      base,
    });
    expect(supportOf(plan)).not.toContain("src/real.ts");
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
      { file: titleTest, added: false, tests: ["slugs emoji"] },
    ]);
  });
});

describe("blind checks proof: the pull request's own commits", () => {
  it("lists only the commits since the branch left the base branch, oldest first, with their messages and files", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
    const run = (args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Dev",
          GIT_AUTHOR_EMAIL: "dev@example.com",
          GIT_COMMITTER_NAME: "Dev",
          GIT_COMMITTER_EMAIL: "dev@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }).trim();
    const commitFiles = (message: string, files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, path), text);
      }
      run(["add", "-A"]);
      run(["commit", "-q", "-m", message]);
      return run(["rev-parse", "HEAD"]);
    };
    try {
      run(["init", "-q", "-b", "amaraa-mode"]);
      commitFiles("feat: start", { "src/slug.js": "export const slug = (text) => text;\n" });
      commitFiles("feat: older base work", { "src/older.js": "export const older = 1;\n" });
      run(["checkout", "-q", "-b", "fix/slugs"]);
      const checksSha = commitFiles(
        "test: checks for slugs\n\nBlind-checks: written from the request",
        { "src/slug.test.js": 'it("lowercases", () => {});\n' },
      );
      const fixSha = commitFiles("feat: slugs lowercase", {
        "src/slug.js": "export const slug = (text) => text.toLowerCase();\n",
      });
      run(["checkout", "-q", "amaraa-mode"]);
      commitFiles("feat: newer base work", { "src/upstream.js": "export const upstream = 1;\n" });
      run(["checkout", "-q", "fix/slugs"]);
      run([
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'amaraa-mode' into fix/slugs",
        "amaraa-mode",
      ]);
      const mergeSha = run(["rev-parse", "HEAD"]);
      run(["checkout", "-q", "amaraa-mode"]);
      commitFiles("feat: base work after the merge", {
        "src/later.js": "export const later = 1;\n",
      });
      const left = run(["merge-base", "amaraa-mode", "fix/slugs"]);

      const commits = pullRequestCommits(dir, left, mergeSha).map((entry) => ({
        sha: entry.sha,
        message: entry.message.trim(),
        files: entry.files.map((file) => ({ filename: file.filename, status: file.status })),
      }));
      expect(commits).toEqual([
        {
          sha: checksSha,
          message: "test: checks for slugs\n\nBlind-checks: written from the request",
          files: [{ filename: "src/slug.test.js", status: "added" }],
        },
        {
          sha: fixSha,
          message: "feat: slugs lowercase",
          files: [{ filename: "src/slug.js", status: "modified" }],
        },
        {
          sha: mergeSha,
          message: "Merge branch 'amaraa-mode' into fix/slugs",
          files: [{ filename: "src/upstream.js", status: "added" }],
        },
      ]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blind checks proof: revised checks are judged as they are at the newest commit", () => {
  const revised = () =>
    planProof({
      commits: [checks, code, revise([changedFile(titleTest, ['it("slugs emoji", () => {});'])])],
      base,
    });
  const slugPassed = loaded(slugTest, [
    ["keeps letters", "passed"],
    ["drops spaces", "passed"],
  ]);
  const slugFailed = loaded(slugTest, [
    ["keeps letters", "failed"],
    ["drops spaces", "failed"],
  ]);

  it("is proven when a test only the revision added fails on the base branch code and passes at the newest commit", () => {
    expect(
      proven(
        revised(),
        [
          slugFailed,
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["slugs emoji", "failed"],
          ]),
        ],
        [
          slugPassed,
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["slugs emoji", "passed"],
          ]),
        ],
      ),
    ).toBe(true);
  });

  it("is not proven when a test only the revision added already passes on the base branch code", () => {
    expect(
      proven(
        revised(),
        [
          slugFailed,
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["slugs emoji", "passed"],
          ]),
        ],
        [
          slugPassed,
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["slugs emoji", "passed"],
          ]),
        ],
      ),
    ).toBe(false);
  });

  it("is not proven when a file only the revision touched did not run", () => {
    expect(proven(revised(), [slugFailed], [slugPassed])).toBe(false);
  });
});
