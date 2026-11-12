import { describe, expect, it } from "vite-plus/test";

import { judge, planProof, type TestResult } from "../.github/scripts/blind-checks.cjs";
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
