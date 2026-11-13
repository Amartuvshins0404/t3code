// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  judge,
  planProof,
  pullRequestCommits,
  type PlannedFile,
  type TestResult,
} from "../.github/scripts/blind-checks.cjs";
import type { ChangedFile } from "../.github/scripts/merge-lane.cjs";

const base = "b".repeat(40);
const slugTest = "apps/web/src/lib/slug.test.ts";
const titleTest = "apps/web/src/lib/title.test.ts";
const upstreamTest = "packages/shared/src/git.test.ts";
const basePaths = [titleTest, upstreamTest];
const onBaseOf = (paths: ReadonlyArray<string>) => (file: string) => paths.includes(file);
const onBase = onBaseOf(basePaths);
const unchangedAt = (paths: ReadonlyArray<string>) => (file: string) => !paths.includes(file);
const changed = unchangedAt([]);

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
const revertedFile = (filename: string, lines: ReadonlyArray<string>): ChangedFile => ({
  filename,
  status: "modified",
  patch: [
    `@@ -1,${lines.length + 1} +1,1 @@`,
    ' it("keeps the title", () => {});',
    ...lines.map((line) => `-${line}`),
  ].join("\n"),
});
const renamedFile = (from: string, filename: string): ChangedFile => ({
  filename,
  previous_filename: from,
  status: "renamed",
  patch: '@@ -1,1 +1,2 @@\n it("keeps the title", () => {});\n+it("slugs emoji", () => {});',
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
  plan.run ? [...plan.files].sort((a, b) => a.file.localeCompare(b.file)) : [];

const resultOf = (name: string, status: string) => {
  const path = name.split(" > ");
  return { ancestorTitles: path.slice(0, -1), title: path.at(-1) ?? name, status };
};
const loaded = (file: string, tests: ReadonlyArray<readonly [string, string]>): TestResult => ({
  name: `/repo/${file}`,
  assertionResults: tests.map(([name, status]) => resultOf(name, status)),
});
const notLoaded = (file: string): TestResult => ({
  name: `/repo/${file}`,
  message: "Cannot find module './slug.ts'",
  assertionResults: [],
});
const byFile = (results: ReadonlyArray<TestResult>) =>
  new Map(results.map((result) => [result.name.replace("/repo/", ""), result] as const));
const verdictOf = (
  files: ReadonlyArray<PlannedFile>,
  baseline: ReadonlyArray<TestResult>,
  before: ReadonlyArray<TestResult>,
  after: ReadonlyArray<TestResult>,
) => judge({ files }, { baseline: byFile(baseline), before: byFile(before), after: byFile(after) });
const problemsOf = (verdict: ReturnType<typeof judge>) =>
  verdict.rows.flatMap((row) => row.problems).join("\n");
const withoutOf = (verdict: ReturnType<typeof judge>, file: string) =>
  verdict.rows.filter((row) => row.file === file).map((row) => row.without);
const proven = (
  plan: ReturnType<typeof planProof>,
  baseline: ReadonlyArray<TestResult>,
  before: ReadonlyArray<TestResult>,
  after: ReadonlyArray<TestResult>,
) => {
  if (!plan.run) throw new Error(`nothing planned: ${plan.note}`);
  return verdictOf(plan.files, baseline, before, after).ok;
};

const gitIn = (dir: string) => {
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
  const commitFiles = (
    message: string,
    files: Record<string, string>,
    removed: ReadonlyArray<string> = [],
  ) => {
    for (const path of removed) NodeFS.rmSync(NodePath.join(dir, path));
    for (const [path, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, path), text);
    }
    run(["add", "-A"]);
    run(["commit", "-q", "-m", message]);
    return run(["rev-parse", "HEAD"]);
  };
  return { run, commitFiles };
};

describe("blind checks proof: what is planned", () => {
  it("a pull request whose checks were never revised plans the checks commit's test files, as before", () => {
    const plan = planProof({ commits: [checks, code], base, onBase, changed });
    expect(sorted(plan)).toEqual([{ file: slugTest, baseFile: null }]);
  });

  it("runs without the code on the point where the pull request left the base branch", () => {
    expect(planProof({ commits: [checks, code], base, onBase, changed })).toMatchObject({
      run: true,
      base,
    });
  });

  it("plans a test file that only a revision adds or changes, with its path on the base", () => {
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
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([
      { file: slugTest, baseFile: null },
      { file: titleTest, baseFile: titleTest },
      { file: "apps/web/src/lib/url.test.ts", baseFile: null },
    ]);
  });

  it("plans a changed file once when every checks commit touched it, with its own path on the base", () => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [changedFile(titleTest, ['it("slugs My Title", () => {});'])]),
        code,
        revise([changedFile(titleTest, ['it("slugs emoji", () => {});'])]),
      ],
      base,
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: titleTest, baseFile: titleTest }]);
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
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: titleTest, baseFile: titleTest }]);
  });

  it("guard: a test file a commit with no checks marker deletes stays planned, and only a checks commit takes one out", () => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [
          ...checks.files,
          changedFile(titleTest, ['it("slugs My Title", () => {});']),
        ]),
        code,
        commit("e", "chore(web): drop the slug test", [removedFile(slugTest)]),
        revise([removedFile(titleTest)]),
      ],
      base,
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: slugTest, baseFile: null }]);
  });

  it("ignores test files changed by commits with no checks trailer, such as merged base branch work", () => {
    const mergedBase = commit("e", "Merge branch 'amaraa-mode' into fix/slugs", [
      addedFile(upstreamTest, ['it("reads refs", () => {});']),
      changedFile(titleTest, ['it("trims", () => {});']),
    ]);
    const plan = planProof({ commits: [checks, mergedBase, code], base, onBase, changed });
    expect(sorted(plan)).toEqual([{ file: slugTest, baseFile: null }]);
  });

  it("gives a test file the checks commit added no path on the base after a revision changed it", () => {
    const plan = planProof({
      commits: [checks, code, revise([changedFile(slugTest, ['it("keeps digits", () => {});'])])],
      base,
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: slugTest, baseFile: null }]);
  });

  it("follows a test file a revision renamed, and gives it no path on the base when the base never had it", () => {
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
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: renamedTest, baseFile: null }]);
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
      onBase,
      changed,
    });
    expect(sorted(plan)).toEqual([{ file: urlTest, baseFile: null }]);
  });

  it.each([
    { by: "a revision", later: revise },
    {
      by: "a commit with no checks trailer",
      later: (files: ReadonlyArray<ChangedFile>) =>
        commit("e", "chore(web): put the title test back", files),
    },
  ])("leaves out a test file $by put back as on the base, and plans the others", ({ later }) => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [
          ...checks.files,
          changedFile(titleTest, ['it("slugs My Title", () => {});']),
          changedFile(upstreamTest, ['it("reads tags", () => {});']),
        ]),
        code,
        later([
          revertedFile(titleTest, ['it("slugs My Title", () => {});']),
          changedFile(upstreamTest, ['it("reads notes", () => {});']),
        ]),
      ],
      base,
      onBase,
      changed: unchangedAt([titleTest]),
    });
    expect(sorted(plan)).toEqual([
      { file: slugTest, baseFile: null },
      { file: upstreamTest, baseFile: upstreamTest },
    ]);
  });

  it("does not run when every test file the checks touched is back as on the base", () => {
    const plan = planProof({
      commits: [
        commit("c", checks.message, [
          changedFile(titleTest, ['it("slugs My Title", () => {});']),
          changedFile(upstreamTest, ['it("reads tags", () => {});']),
        ]),
        code,
        revise([
          revertedFile(titleTest, ['it("slugs My Title", () => {});']),
          revertedFile(upstreamTest, ['it("reads tags", () => {});']),
        ]),
      ],
      base,
      onBase,
      changed: unchangedAt([titleTest, upstreamTest]),
    });
    expect(plan).toMatchObject({ run: false, note: expect.stringMatching(/changed test file/) });
  });

  const fileHistory = Arbitrary.all({
    checks: Arbitrary.schema(Schema.Boolean),
    revision: Arbitrary.schema(Schema.Boolean),
    plain: Arbitrary.schema(Schema.Boolean),
    back: Arbitrary.schema(Schema.Boolean),
  });

  effectIt.prop(
    "for any history, plans exactly the test files checks touched that still differ from the base",
    [fileHistory, fileHistory, fileHistory, Arbitrary.schema(Schema.Boolean)],
    ([title, upstream, notes, added]) => {
      const notesTest = "apps/web/src/lib/notes.test.ts";
      const paths = [titleTest, upstreamTest, notesTest];
      const histories = [
        { file: titleTest, ...title },
        { file: upstreamTest, ...upstream },
        { file: notesTest, ...notes },
      ];
      const kinds = ["checks", "revision", "plain"] as const;
      const touches = (entry: (typeof histories)[number]) => kinds.filter((kind) => entry[kind]);
      const unchanged = histories
        .filter((entry) => entry.back && touches(entry).length >= 2)
        .map((entry) => entry.file);
      const differing = histories
        .filter((entry) => touches(entry).length > 0 && !unchanged.includes(entry.file))
        .map((entry) => entry.file);
      const filesOf = (kind: (typeof kinds)[number]) =>
        histories
          .filter((entry) => entry[kind])
          .map((entry) =>
            unchanged.includes(entry.file) && touches(entry).at(-1) === kind
              ? revertedFile(entry.file, ['it("slugs emoji", () => {});'])
              : changedFile(entry.file, ['it("slugs emoji", () => {});']),
          );
      const plan = planProof({
        commits: [
          commit("c", checks.message, [
            ...(added ? [addedFile(slugTest, ['it("keeps letters", () => {});'])] : []),
            ...filesOf("checks"),
          ]),
          code,
          revise(filesOf("revision")),
          commit("e", "chore(web): tidy the tests", filesOf("plain")),
        ],
        base,
        onBase: onBaseOf(paths),
        changed: (file: string) => !paths.includes(file) || differing.includes(file),
      });
      const planned: Array<PlannedFile> = [
        ...(added ? [{ file: slugTest, baseFile: null }] : []),
        ...histories
          .filter((entry) => (entry.checks || entry.revision) && differing.includes(entry.file))
          .map((entry) => ({ file: entry.file, baseFile: entry.file })),
      ].sort((a, b) => a.file.localeCompare(b.file));
      expect(plan.run).toBe(planned.length > 0);
      expect(sorted(plan)).toEqual(planned);
    },
    { arbitrary: { seed: 42 } },
  );
});

const headingTest = "apps/web/src/lib/heading.test.ts";
const renamedTitleTest = "apps/web/src/lib/pageTitle.test.ts";
const baseFileCases: ReadonlyArray<{
  readonly name: string;
  readonly basePaths: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<ReturnType<typeof commit>>;
  readonly planned: ReadonlyArray<PlannedFile>;
}> = [
  {
    name: "a file the pull request added has none",
    basePaths: [titleTest],
    commits: [checks, code],
    planned: [{ file: slugTest, baseFile: null }],
  },
  {
    name: "a changed file has its own path",
    basePaths: [titleTest],
    commits: [
      commit("c", checks.message, [changedFile(titleTest, ['it("slugs emoji", () => {});'])]),
      code,
    ],
    planned: [{ file: titleTest, baseFile: titleTest }],
  },
  {
    name: "a file a commit renamed has its old path",
    basePaths: [titleTest],
    commits: [commit("c", checks.message, [renamedFile(titleTest, renamedTitleTest)]), code],
    planned: [{ file: renamedTitleTest, baseFile: titleTest }],
  },
  {
    name: "a renamed file with both its names on the base has the newer one",
    basePaths: [titleTest, renamedTitleTest],
    commits: [commit("c", checks.message, [renamedFile(titleTest, renamedTitleTest)]), code],
    planned: [{ file: renamedTitleTest, baseFile: renamedTitleTest }],
  },
  {
    name: "a file renamed twice has its first path",
    basePaths: [titleTest],
    commits: [
      commit("c", checks.message, [renamedFile(titleTest, headingTest)]),
      code,
      revise([renamedFile(headingTest, renamedTitleTest)]),
    ],
    planned: [{ file: renamedTitleTest, baseFile: titleTest }],
  },
  {
    name: "a file a commit shows as added that merged base work put on the base has its own path",
    basePaths: [titleTest, slugTest],
    commits: [checks, code],
    planned: [{ file: slugTest, baseFile: slugTest }],
  },
  {
    name: "a file merged base work renamed has the new name",
    basePaths: [renamedTitleTest],
    commits: [
      commit("c", checks.message, [changedFile(titleTest, ['it("slugs emoji", () => {});'])]),
      code,
      commit("e", "Merge branch 'amaraa-mode' into fix/slugs", [
        renamedFile(titleTest, renamedTitleTest),
      ]),
    ],
    planned: [{ file: renamedTitleTest, baseFile: renamedTitleTest }],
  },
];

describe("blind checks proof: where each planned file was on the base", () => {
  it.each(baseFileCases)("by results, the plan's path on the base: $name", (entry) => {
    const plan = planProof({
      commits: entry.commits,
      base,
      onBase: onBaseOf(entry.basePaths),
      changed,
    });
    expect(sorted(plan)).toEqual(entry.planned);
  });
});

describe("blind checks proof: which files the base branch run takes from the newest commit", () => {
  it("takes a test-support file the checks commit changed", () => {
    expect(supportOf(planProof({ commits: [checks, code], base, onBase, changed }))).toEqual([
      slugInputs,
    ]);
  });

  it("takes a test-support file that only a commit with no checks trailer changed", () => {
    const setupFix = commit("e", "fix(web): slug test setup", [
      changedFile(testSetup, ["export const locale = 'en';"]),
    ]);
    expect(
      supportOf(planProof({ commits: [checks, code, setupFix], base, onBase, changed })),
    ).toEqual([slugInputs, testSetup].sort());
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
      onBase,
      changed,
    });
    expect(supportOf(plan)).not.toContain("src/real.ts");
    expect(sorted(plan)).toEqual([
      { file: slugTest, baseFile: null },
      { file: titleTest, baseFile: titleTest },
    ]);
  });
});

describe("blind checks proof: the pull request's own commits", () => {
  it("lists only the commits since the branch left the base branch, oldest first, with their messages and files", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
    const { run, commitFiles } = gitIn(dir);
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
      onBase,
      changed,
    });
  const titleOld = loaded(titleTest, [["keeps the title", "passed"]]);
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
        [titleOld],
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
        [titleOld],
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
    expect(proven(revised(), [titleOld], [slugFailed], [slugPassed])).toBe(false);
  });
});

const titled: PlannedFile = { file: titleTest, baseFile: titleTest };
const keepsTheTitle = "title > keeps the title";
const titleOldRun = loaded(titleTest, [[keepsTheTitle, "passed"]]);
const titleRun = (tests: ReadonlyArray<readonly [string, string]>) =>
  loaded(titleTest, [[keepsTheTitle, "passed"], ...tests]);

const slippedTitles = [
  { shape: "a filled-in table row", title: "slugs a" },
  { shape: "a title made only of placeholders", title: "a" },
  { shape: "a title built from a value", title: "slugs 3 titles" },
  { shape: "a property test", title: "slugs any title to lowercase" },
  { shape: "a title with % or $ left in it", title: "slugs %j as $missing" },
  { shape: "a test whose name is on a later line", title: "keeps the slug short" },
] as const;

const countExamples: ReadonlyArray<{
  readonly name: string;
  readonly old: ReadonlyArray<readonly [string, string]>;
  readonly without: ReadonlyArray<readonly [string, string]>;
  readonly ok: boolean;
}> = [
  {
    name: "two new tests of one name with one failure",
    old: [["slugs a", "passed"]],
    without: [
      ["slugs a", "passed"],
      ["slugs a", "failed"],
      ["slugs a", "passed"],
    ],
    ok: false,
  },
  {
    name: "two new tests of one name with two failures",
    old: [["slugs a", "passed"]],
    without: [
      ["slugs a", "failed"],
      ["slugs a", "failed"],
      ["slugs a", "passed"],
    ],
    ok: true,
  },
  {
    name: "a new name next to an old one, passing without the code",
    old: [["slugs a", "passed"]],
    without: [
      ["slugs a", "passed"],
      ["slugs b", "passed"],
    ],
    ok: false,
  },
  {
    name: "the same title under two describe paths, one of them old",
    old: [["title > slugs a", "passed"]],
    without: [
      ["title > slugs a", "passed"],
      ["slugs a", "failed"],
    ],
    ok: true,
  },
];

const freshCounts: ReadonlyArray<{
  readonly name: string;
  readonly old: ReadonlyArray<readonly [string, string]>;
  readonly without: ReadonlyArray<readonly [string, string]>;
  readonly withCode: ReadonlyArray<string>;
  readonly counted: string;
}> = [
  {
    name: "some new tests fail and some do not",
    old: [["title > keeps the title", "passed"]],
    without: [
      ["title > keeps the title", "passed"],
      ["title > slugs a", "failed"],
      ["title > slugs b", "passed"],
    ],
    withCode: ["title > keeps the title", "title > slugs a", "title > slugs b"],
    counted: "1 of 2 new tests failed",
  },
  {
    name: "a name fails more often than it has new tests",
    old: [
      ["title > keeps the title", "passed"],
      ["title > slugs a", "passed"],
    ],
    without: [
      ["title > keeps the title", "passed"],
      ["title > slugs a", "failed"],
      ["title > slugs a", "failed"],
    ],
    withCode: ["title > keeps the title", "title > slugs a", "title > slugs a"],
    counted: "1 of 1 new tests failed",
  },
  {
    name: "an old name comes up less often with the code than in the old run",
    old: [
      ["title > keeps the title", "passed"],
      ["title > slugs a", "passed"],
      ["title > slugs a", "passed"],
    ],
    without: [
      ["title > keeps the title", "passed"],
      ["title > slugs a", "passed"],
      ["title > slugs b", "failed"],
    ],
    withCode: ["title > keeps the title", "title > slugs a", "title > slugs b"],
    counted: "1 of 1 new tests failed",
  },
];

describe("blind checks proof: new tests are found from the test runner's results", () => {
  it("by results, old tests that pass without the code are not judged and a failing new test is proven", () => {
    expect(
      verdictOf(
        [titled],
        [titleOldRun],
        [titleRun([["title > slugs My Title", "failed"]])],
        [titleRun([["title > slugs My Title", "passed"]])],
      ).ok,
    ).toBe(true);
  });

  it("by results, a new test that passes without the code is not proven and its problem names it", () => {
    const verdict = verdictOf(
      [titled],
      [titleOldRun],
      [titleRun([["title > slugs My Title", "passed"]])],
      [titleRun([["title > slugs My Title", "passed"]])],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsOf(verdict)).toContain("title > slugs My Title");
  });

  it.each(slippedTitles)("by results, any title shape is judged alike: $shape", ({ title }) => {
    const name = `title > ${title}`;
    const run = (status: string) => titleRun([[name, status]]);
    expect(verdictOf([titled], [titleOldRun], [run("failed")], [run("passed")]).ok).toBe(true);
    const held = verdictOf([titled], [titleOldRun], [run("passed")], [run("passed")]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain(name);
  });

  it("by results, an old title under another describe path is a new test", () => {
    const oldRun = loaded(titleTest, [["title > slugs a", "passed"]]);
    const run = (old: string, moved: string) =>
      loaded(titleTest, [
        ["title > slugs a", old],
        ["title > emoji > slugs a", moved],
      ]);
    const after = run("passed", "passed");
    expect(verdictOf([titled], [oldRun], [run("passed", "failed")], [after]).ok).toBe(true);
    const held = verdictOf([titled], [oldRun], [run("failed", "passed")], [after]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain("title > emoji > slugs a");
  });

  it("by results, a name that comes up more often at the head than in the old run has new tests", () => {
    const oldRun = loaded(titleTest, [
      ["title > slugs a", "passed"],
      ["title > slugs a", "passed"],
    ]);
    const run = (statuses: ReadonlyArray<string>) =>
      loaded(
        titleTest,
        statuses.map((status) => ["title > slugs a", status] as const),
      );
    const after = run(["passed", "passed", "passed"]);
    expect(verdictOf([titled], [oldRun], [run(["passed", "failed", "passed"])], [after]).ok).toBe(
      true,
    );
    const held = verdictOf([titled], [oldRun], [run(["passed", "passed", "passed"])], [after]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain("title > slugs a");
  });

  it.each(countExamples)("by results, count rule example: $name", ({ old, without, ok }) => {
    const after = loaded(
      titleTest,
      without.map(([name]) => [name, "passed"] as const),
    );
    expect(
      verdictOf([titled], [loaded(titleTest, old)], [loaded(titleTest, without)], [after]).ok,
    ).toBe(ok);
  });

  it.each(freshCounts)("guard: the row's count of new tests that failed: $name", (entry) => {
    const verdict = verdictOf(
      [titled],
      [loaded(titleTest, entry.old)],
      [loaded(titleTest, entry.without)],
      [
        loaded(
          titleTest,
          entry.withCode.map((name) => [name, "passed"] as const),
        ),
      ],
    );
    expect(withoutOf(verdict, titleTest)).toEqual([
      expect.stringMatching(new RegExp(`^${entry.counted}`)),
    ]);
  });

  it("by results, a test that was skipped, pending or todo in the old run counts as new", () => {
    const oldRun = loaded(titleTest, [
      [keepsTheTitle, "passed"],
      ["title > slugs a", "skipped"],
      ["title > slugs b", "pending"],
      ["title > slugs c", "todo"],
    ]);
    const names = ["title > slugs a", "title > slugs b", "title > slugs c"];
    const after = titleRun(names.map((name) => [name, "passed"] as const));
    const failing = titleRun(names.map((name) => [name, "failed"] as const));
    expect(verdictOf([titled], [oldRun], [failing], [after]).ok).toBe(true);
    for (const held of names) {
      const before = titleRun(
        names.map((name) => [name, name === held ? "passed" : "failed"] as const),
      );
      const verdict = verdictOf([titled], [oldRun], [before], [after]);
      expect(verdict.ok).toBe(false);
      expect(problemsOf(verdict)).toContain(held);
    }
  });

  it("by results, a new test that is skipped or missing without the code did not fail", () => {
    const after = titleRun([["title > slugs a", "passed"]]);
    const skipped = verdictOf(
      [titled],
      [titleOldRun],
      [titleRun([["title > slugs a", "skipped"]])],
      [after],
    );
    expect(skipped.ok).toBe(false);
    expect(problemsOf(skipped)).toContain("title > slugs a");
    const missing = verdictOf([titled], [titleOldRun], [titleRun([])], [after]);
    expect(missing.ok).toBe(false);
    expect(problemsOf(missing)).toContain("title > slugs a");
  });

  it("by results, every test in a file the pull request added is new", () => {
    const added: PlannedFile = { file: slugTest, baseFile: null };
    const run = (letters: string, spaces: string) =>
      loaded(slugTest, [
        ["slugs > keeps letters", letters],
        ["slugs > drops spaces", spaces],
      ]);
    const after = run("passed", "passed");
    expect(verdictOf([added], [], [run("failed", "failed")], [after]).ok).toBe(true);
    const held = verdictOf([added], [], [run("failed", "passed")], [after]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain("slugs > drops spaces");
  });

  it("by results, a renamed file is compared with the old run under its name on the base", () => {
    const slugifyTest = "apps/web/src/lib/slugify.test.ts";
    const renamed: PlannedFile = { file: slugifyTest, baseFile: slugTest };
    const oldRun = loaded(slugTest, [["slugs > keeps letters", "passed"]]);
    const run = (spaces: string) =>
      loaded(slugifyTest, [
        ["slugs > keeps letters", "passed"],
        ["slugs > drops spaces", spaces],
      ]);
    expect(verdictOf([renamed], [oldRun], [run("failed")], [run("passed")]).ok).toBe(true);
    const held = verdictOf([renamed], [oldRun], [run("passed")], [run("passed")]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain("slugs > drops spaces");
  });

  it("by results, a file on the base with no old run is not proven", () => {
    const verdict = verdictOf(
      [titled],
      [],
      [loaded(titleTest, [[keepsTheTitle, "failed"]])],
      [loaded(titleTest, [[keepsTheTitle, "passed"]])],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.rows.flatMap((row) => row.problems)).not.toEqual([]);
  });

  it("by results, every test is new when the old run could not load, and the row says so", () => {
    const run = (oldTest: string, newTest: string) =>
      loaded(titleTest, [
        [keepsTheTitle, oldTest],
        ["title > slugs a", newTest],
      ]);
    const failing = run("failed", "failed");
    const after = run("passed", "passed");
    const fromBrokenOldRun = verdictOf([titled], [notLoaded(titleTest)], [failing], [after]);
    expect(fromBrokenOldRun.ok).toBe(true);
    expect(fromBrokenOldRun.rows).not.toEqual(
      verdictOf([{ file: titleTest, baseFile: null }], [], [failing], [after]).rows,
    );
    const held = verdictOf([titled], [notLoaded(titleTest)], [run("passed", "failed")], [after]);
    expect(held.ok).toBe(false);
    expect(problemsOf(held)).toContain(keepsTheTitle);
  });

  const namePool = Arbitrary.schema(
    Schema.Literals(["slugs a", "slugs b", "title > slugs a", "title > emoji > slugs a"]),
  );
  const oldTests = Arbitrary.array(
    Arbitrary.all({
      name: namePool,
      status: Arbitrary.schema(Schema.Literals(["passed", "failed", "skipped", "pending", "todo"])),
    }),
    { maxLength: 5 },
  );
  const headTests = Arbitrary.array(
    Arbitrary.all({
      name: namePool,
      without: Arbitrary.schema(Schema.Literals(["passed", "failed", "skipped"])),
      withCode: Arbitrary.schema(Schema.Boolean),
    }),
    { minLength: 1, maxLength: 6 },
  );

  effectIt.prop(
    "by results, for any old and head tests the proof holds exactly when each name has enough failures",
    [oldTests, headTests],
    ([old, head]) => {
      const withCode = head.filter((test) => test.withCode);
      const holds = head.every(({ name }) => {
        const atHead = withCode.filter((test) => test.name === name);
        const failed = head.filter(
          (test) => test.name === name && test.without === "failed",
        ).length;
        const wasOld = old.filter(
          (test) => test.name === name && (test.status === "passed" || test.status === "failed"),
        ).length;
        return failed >= atHead.length - wasOld;
      });
      const shows = head.some(
        ({ name }) =>
          head.filter((test) => test.name === name && test.without === "failed").length >
          old.filter((test) => test.name === name && test.status === "failed").length,
      );
      const stays = head.every(
        ({ name }) =>
          head.filter((test) => test.name === name).length <=
          withCode.filter((test) => test.name === name).length,
      );
      const verdict = verdictOf(
        [titled],
        [
          loaded(
            titleTest,
            old.map((test) => [test.name, test.status] as const),
          ),
        ],
        [
          loaded(
            titleTest,
            head.map((test) => [test.name, test.without] as const),
          ),
        ],
        [
          loaded(
            titleTest,
            withCode.map((test) => [test.name, "passed"] as const),
          ),
        ],
      );
      expect(verdict.ok).toBe(holds && shows && stays);
    },
    { arbitrary: { seed: 42 } },
  );
});

const nothingFailed = "Nothing in it failed without the code.";
const problemsIn = (verdict: ReturnType<typeof judge>, file: string) =>
  verdict.rows.filter((row) => row.file === file).flatMap((row) => row.problems);
const slugsA = "title > slugs a";
const addedSlug: PlannedFile = { file: slugTest, baseFile: null };
const gitOld: PlannedFile = { file: upstreamTest, baseFile: upstreamTest };
const noSuite = (file: string): TestResult => ({
  name: `/repo/${file}`,
  message: `No test suite found in file /repo/${file}`,
  assertionResults: [],
});
const loadError = (file: string): TestResult => ({
  name: `/repo/${file}`,
  message: `Cannot find module './slug.ts' imported from /repo/${file}`,
  assertionResults: [],
});

describe("blind checks proof: every checked file shows a test that fails without the code", () => {
  it("floor: a file of old tests that all pass without the code is not proven, and one changed to need the code is", () => {
    const oldRun = titleRun([[slugsA, "passed"]]);
    const run = (slugs: string) => titleRun([[slugsA, slugs]]);
    const hollow = verdictOf([titled], [oldRun], [run("passed")], [run("passed")]);
    expect(hollow.ok).toBe(false);
    expect(problemsIn(hollow, titleTest)).toContain(nothingFailed);
    const changed = verdictOf([titled], [oldRun], [run("failed")], [run("passed")]);
    expect(changed.ok).toBe(true);
    expect(problemsIn(changed, titleTest)).not.toContain(nothingFailed);
  });

  it("floor: a name that fails without the code only as often as in the old run does not count", () => {
    const oldRun = titleRun([[slugsA, "failed"]]);
    const verdict = verdictOf(
      [titled],
      [oldRun],
      [titleRun([[slugsA, "failed"]])],
      [titleRun([[slugsA, "passed"]])],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsIn(verdict, titleTest)).toContain(nothingFailed);
    const twice = verdictOf(
      [titled],
      [oldRun],
      [
        titleRun([
          [slugsA, "failed"],
          [slugsA, "failed"],
        ]),
      ],
      [
        titleRun([
          [slugsA, "passed"],
          [slugsA, "passed"],
        ]),
      ],
    );
    expect(twice.ok).toBe(true);
  });

  it("floor: of two files only the hollow one has the problem, and a file that cannot load without the code is untouched", () => {
    const gitRun = loaded(upstreamTest, [["git > reads refs", "passed"]]);
    const verdict = verdictOf(
      [titled, gitOld],
      [titleOldRun, gitRun],
      [titleRun([[slugsA, "failed"]]), gitRun],
      [titleRun([[slugsA, "passed"]]), gitRun],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsIn(verdict, titleTest)).not.toContain(nothingFailed);
    expect(problemsIn(verdict, upstreamTest)).toContain(nothingFailed);
    const unloaded = verdictOf(
      [addedSlug],
      [],
      [notLoaded(slugTest)],
      [loaded(slugTest, [["slugs > keeps letters", "passed"]])],
    );
    expect(unloaded.ok).toBe(true);
    expect(problemsIn(unloaded, slugTest)).not.toContain(nothingFailed);
  });

  it("holes: a file that loads without the code but holds no tests there is judged as loaded, and only another message means it could not load", () => {
    const keepsLetters = "slugs > keeps letters";
    const dropsSpaces = "slugs > drops spaces";
    const slugAfter = loaded(slugTest, [
      [keepsLetters, "passed"],
      [dropsSpaces, "passed"],
    ]);
    const titleAfter = titleRun([[slugsA, "passed"]]);
    const empty = verdictOf(
      [addedSlug, titled],
      [titleOldRun],
      [noSuite(slugTest), noSuite(titleTest)],
      [slugAfter, titleAfter],
    );
    expect(empty.ok).toBe(false);
    expect(problemsIn(empty, slugTest)).toContain(nothingFailed);
    expect(problemsIn(empty, titleTest)).toContain(nothingFailed);
    const slugProblems = problemsIn(empty, slugTest).join("\n");
    expect(slugProblems).toContain(keepsLetters);
    expect(slugProblems).toContain(dropsSpaces);
    expect(problemsIn(empty, titleTest).join("\n")).toContain(slugsA);
    expect(withoutOf(empty, slugTest)).toEqual([expect.stringMatching(/^0 of 2 new tests failed/)]);
    expect(withoutOf(empty, titleTest)).toEqual([
      expect.stringMatching(/^0 of 1 new tests failed/),
    ]);
    const unloaded = verdictOf(
      [addedSlug, titled],
      [titleOldRun],
      [loadError(slugTest), loadError(titleTest)],
      [slugAfter, titleAfter],
    );
    expect(unloaded.ok).toBe(true);
  });
});

describe("blind checks proof: a file must run, load and pass with the code", () => {
  it("pinned: a file with no run without the code is not proven, even when it passes with the code", () => {
    const verdict = verdictOf(
      [addedSlug],
      [],
      [],
      [loaded(slugTest, [["slugs > keeps letters", "passed"]])],
    );
    expect(verdict.ok).toBe(false);
  });

  it("pinned: a file that loads without the code but cannot load with it is not proven", () => {
    const verdict = verdictOf(
      [addedSlug],
      [],
      [loaded(slugTest, [["slugs > keeps letters", "failed"]])],
      [notLoaded(slugTest)],
    );
    expect(verdict.ok).toBe(false);
  });

  it("pinned: a test skipped with the code did not pass, so the file is not proven and the problem names it", () => {
    const verdict = verdictOf(
      [addedSlug],
      [],
      [
        loaded(slugTest, [
          ["slugs > keeps letters", "failed"],
          ["slugs > drops spaces", "failed"],
        ]),
      ],
      [
        loaded(slugTest, [
          ["slugs > keeps letters", "passed"],
          ["slugs > drops spaces", "skipped"],
        ]),
      ],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsOf(verdict)).toContain("slugs > drops spaces");
  });

  it("holes: a test that fails without the code and is gone with it did not pass, so the row names it", () => {
    const vanished = "title > slugs only without the code";
    const verdict = verdictOf(
      [titled],
      [titleOldRun],
      [titleRun([[vanished, "failed"]])],
      [titleRun([])],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsIn(verdict, titleTest).join("\n")).toContain(vanished);
  });

  it("holes: a name that comes up more often without the code than with it did not pass, even next to a real new test", () => {
    const slugsB = "title > slugs b";
    const verdict = verdictOf(
      [titled],
      [titleRun([[slugsA, "passed"]])],
      [
        titleRun([
          [slugsA, "passed"],
          [slugsA, "passed"],
          [slugsB, "failed"],
        ]),
      ],
      [
        titleRun([
          [slugsA, "passed"],
          [slugsB, "passed"],
        ]),
      ],
    );
    expect(verdict.ok).toBe(false);
    expect(problemsIn(verdict, titleTest).join("\n")).toContain(slugsA);
  });

  it("holes: a top-level test whose title holds the join text is not the test of that name inside a describe block", () => {
    const run = (ancestorTitles: ReadonlyArray<string>, title: string, status: string) =>
      byFile([
        { name: `/repo/${slugTest}`, assertionResults: [{ ancestorTitles, title, status }] },
      ]);
    const judged = (before: ReturnType<typeof run>) =>
      judge(
        { files: [addedSlug] },
        { baseline: byFile([]), before, after: run(["slugs"], "keeps letters", "passed") },
      );
    expect(judged(run(["slugs"], "keeps letters", "failed")).ok).toBe(true);
    expect(judged(run([], "slugs > keeps letters", "failed")).ok).toBe(false);
  });

  it("guard: a file that ran without the code but has no run with the code is not proven, and judging it does not throw", () => {
    const verdict = verdictOf(
      [addedSlug],
      [],
      [loaded(slugTest, [["slugs > keeps letters", "failed"]])],
      [],
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("blind checks proof: the commands the job runs", () => {
  const script = NodePath.join(import.meta.dirname, "../.github/scripts/blind-checks.cjs");
  const jobEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GITHUB_") && key !== "BLIND_CHECKS_MODE",
    ),
  );
  const node = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("node", [script, ...args], { encoding: "utf8", env: jobEnv });
  const linesOf = (file: string) =>
    NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).sort();
  const writerIn = (out: string) => (name: string, value: unknown) =>
    NodeFS.writeFileSync(NodePath.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  const reportIn =
    (dir: string) =>
    (files: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]>) => {
      const testResults = files.map(([file, tests]) => {
        const assertionResults = tests.map(([name, status]) => ({
          ...resultOf(name, status),
          fullName: name.split(" > ").join(" "),
          duration: 1,
          failureMessages: status === "failed" ? ["AssertionError: expected 1 to be 2"] : [],
          meta: {},
          tags: [],
          benchmarks: [],
        }));
        return {
          assertionResults,
          startTime: 0,
          endTime: 1,
          status: assertionResults.some((test) => test.status === "failed") ? "failed" : "passed",
          message: "",
          name: NodePath.join(dir, file),
        };
      });
      const all = testResults.flatMap((result) => result.assertionResults);
      return {
        numTotalTestSuites: testResults.length,
        numPassedTestSuites: testResults.filter((result) => result.status === "passed").length,
        numFailedTestSuites: testResults.filter((result) => result.status === "failed").length,
        numPendingTestSuites: 0,
        numTotalTests: all.length,
        numPassedTests: all.filter((test) => test.status === "passed").length,
        numFailedTests: all.filter((test) => test.status === "failed").length,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: 0,
        success: all.every((test) => test.status === "passed"),
        testResults,
      };
    };

  it("by results, the plan command writes base-files.txt with each planned file's path on the base", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
    const repo = NodePath.join(dir, "repo");
    const out = NodePath.join(dir, "out");
    NodeFS.mkdirSync(repo);
    const { run, commitFiles } = gitIn(repo);
    const oldTests = 'it("keeps letters", () => {});\nit("drops spaces", () => {});\n';
    const keptTests = 'it("keeps the case", () => {});\n';
    try {
      run(["init", "-q", "-b", "amaraa-mode"]);
      commitFiles("feat: start", {
        "src/slug.js": "export const slug = (text) => text;\n",
        "src/title.test.js": 'it("keeps the title", () => {});\n',
        "src/old.test.js": `${oldTests}it("keeps digits", () => {});\n`,
        "src/kept.test.js": keptTests,
      });
      run(["checkout", "-q", "-b", "fix/slugs"]);
      commitFiles(
        "test: checks for slugs\n\nBlind-checks: written from the request",
        {
          "src/title.test.js":
            'it("keeps the title", () => {});\nit("slugs My Title", () => {});\n',
          "src/slug.test.js": 'it("lowercases", () => {});\n',
          "src/renamed.test.js": `${oldTests}it("keeps digits", () => {});\nit("keeps dashes", () => {});\n`,
          "src/kept.test.js": `${keptTests}it("keeps accents", () => {});\n`,
        },
        ["src/old.test.js"],
      );
      commitFiles("feat: slugs lowercase", {
        "src/slug.js": "export const slug = (text) => text.toLowerCase();\n",
      });
      const head = commitFiles(
        "test: drop the accent check\n\nBlind-checks: revised after an objection",
        { "src/kept.test.js": keptTests },
      );
      const left = run(["merge-base", "amaraa-mode", "fix/slugs"]);
      node(["plan", "--base", left, "--head", head, "--dir", out, "--cwd", repo]);
      expect(linesOf(NodePath.join(out, "files.txt"))).toEqual([
        "src/renamed.test.js",
        "src/slug.test.js",
        "src/title.test.js",
      ]);
      expect(linesOf(NodePath.join(out, "base-files.txt"))).toEqual([
        "src/old.test.js",
        "src/title.test.js",
      ]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("by results, the judge command reads baseline.json, before.json and after.json and prints the verdict", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
    const out = NodePath.join(dir, "out");
    NodeFS.mkdirSync(out);
    const write = writerIn(out);
    const report = reportIn(dir);
    const judged = () => node(["judge", "--dir", out, "--cwd", dir]);
    const titleFile = "src/title.test.js";
    const slugFile = "src/slug.test.js";
    const withCode = report([
      [
        titleFile,
        [
          ["title > keeps the title", "passed"],
          ["title > slugs My Title", "passed"],
        ],
      ],
      [slugFile, [["slugs > lowercases", "passed"]]],
    ]);
    const without = (newTitleTest: string) =>
      report([
        [
          titleFile,
          [
            ["title > keeps the title", "passed"],
            ["title > slugs My Title", newTitleTest],
          ],
        ],
        [slugFile, [["slugs > lowercases", "failed"]]],
      ]);
    try {
      write("plan.json", {
        run: true,
        base,
        files: [
          { file: titleFile, baseFile: titleFile },
          { file: slugFile, baseFile: null },
        ],
        support: [],
      });
      write("baseline.json", report([[titleFile, [["title > keeps the title", "passed"]]]]));
      write("after.json", withCode);
      write("before.json", without("failed"));
      expect(judged().startsWith("### Blind checks: proven")).toBe(true);
      write("before.json", without("passed"));
      const held = judged();
      expect(held.startsWith("### Blind checks: not proven")).toBe(true);
      expect(held).toContain("title > slugs My Title");
      write("before.json", without("failed"));
      NodeFS.rmSync(NodePath.join(out, "baseline.json"));
      expect(judged().startsWith("### Blind checks: not proven")).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pinned: the judge command exits 1 only when BLIND_CHECKS_MODE is required and the proof does not hold", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
    const out = NodePath.join(dir, "out");
    NodeFS.mkdirSync(out);
    const write = writerIn(out);
    const report = reportIn(dir);
    const slugFile = "src/slug.test.js";
    const judgedIn = (mode: string, without: string) => {
      write("before.json", report([[slugFile, [["slugs > lowercases", without]]]]));
      const result = NodeChildProcess.spawnSync(
        "node",
        [script, "judge", "--dir", out, "--cwd", dir],
        { encoding: "utf8", env: { ...jobEnv, BLIND_CHECKS_MODE: mode } },
      );
      const verdict = ["### Blind checks: proven", "### Blind checks: not proven"].find((line) =>
        result.stdout.startsWith(line),
      );
      return { exit: result.status, verdict: verdict ?? result.stdout.slice(0, 200) };
    };
    try {
      write("plan.json", {
        run: true,
        base,
        files: [{ file: slugFile, baseFile: null }],
        support: [],
      });
      write("after.json", report([[slugFile, [["slugs > lowercases", "passed"]]]]));
      expect([
        judgedIn("required", "passed"),
        judgedIn("required", "failed"),
        judgedIn("report", "passed"),
      ]).toEqual([
        { exit: 1, verdict: "### Blind checks: not proven" },
        { exit: 0, verdict: "### Blind checks: proven" },
        { exit: 0, verdict: "### Blind checks: not proven" },
      ]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the bots run the base branch's tools as they are when the job starts", () => {
  const workflowStep = (workflow: string, name: string) => {
    const text = NodeFS.readFileSync(
      new URL(`../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    const run = text
      .split(`      - name: ${name}\n`)[1]
      ?.split("\n      - name:")[0]
      ?.split("        run: |\n")[1];
    if (!run) throw new Error(`no run block in ${workflow}: ${name}`);
    return run
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
  };

  const withMovedBase = (
    check: (fixture: {
      openedOn: string;
      first: string;
      head: string;
      run: (args: ReadonlyArray<string>) => string;
      runStep: (script: string, env: Record<string, string>) => void;
      read: (...path: ReadonlyArray<string>) => string;
    }) => void,
  ) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-")),
    );
    const origin = NodePath.join(root, "host", "owner", "repo.git");
    const work = NodePath.join(root, "work");
    const temp = NodePath.join(root, "temp");
    for (const dir of [origin, work, temp]) NodeFS.mkdirSync(dir, { recursive: true });
    const { run, commitFiles } = gitIn(origin);
    try {
      run(["init", "-q", "-b", "amaraa-mode"]);
      run(["config", "uploadpack.allowFilter", "true"]);
      run(["config", "uploadpack.allowAnySHA1InWant", "true"]);
      const openedOn = commitFiles("feat: start", {
        ".github/scripts/blind-checks.cjs": "old judge\n",
        ".github/scripts/merge-lane.cjs": "old rules\n",
        "src/slug.js": "export const slug = (text) => text;\n",
      });
      run(["checkout", "-q", "-b", "fix/slugs"]);
      const first = commitFiles(
        "test: checks for slugs\n\nBlind-checks: written from the request",
        { "src/slug.test.js": 'it("lowercases", () => {});\n' },
      );
      const head = commitFiles("feat: slugs lowercase", {
        "src/slug.js": "export const slug = (text) => text.toLowerCase();\n",
      });
      run(["checkout", "-q", "amaraa-mode"]);
      commitFiles("feat: a newer judge and newer rules", {
        ".github/scripts/blind-checks.cjs": "new judge\n",
        ".github/scripts/merge-lane.cjs": "new rules\n",
      });
      check({
        openedOn,
        first,
        head,
        run,
        runStep: (script, env) => {
          NodeChildProcess.execFileSync("bash", ["-c", script], {
            cwd: work,
            encoding: "utf8",
            stdio: "pipe",
            env: {
              PATH: process.env.PATH,
              HOME: root,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GITHUB_SERVER_URL: `file://${NodePath.join(root, "host")}`,
              GITHUB_REPOSITORY: "owner/repo",
              GITHUB_OUTPUT: NodePath.join(temp, "output.txt"),
              RUNNER_TEMP: temp,
              ...env,
            },
          });
        },
        read: (...path) => NodeFS.readFileSync(NodePath.join(root, ...path), "utf8"),
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };

  it("the proof job takes the judge from the newest commit on the base branch, not from the commit the pull request was opened on", () => {
    withMovedBase(({ openedOn, first, head, runStep, read }) => {
      runStep(
        workflowStep(
          "blind-checks.yml",
          "Fetch the pull request commits and the judge from the base branch",
        ),
        { HEAD_SHA: head, BASE_SHA: openedOn, BASE_REF: "amaraa-mode" },
      );
      expect({
        judge: read("temp", "judge", ".github", "scripts", "blind-checks.cjs"),
        outputs: read("temp", "output.txt").trim().split("\n"),
      }).toEqual({
        judge: "new judge\n",
        outputs: [`base=${openedOn}`, `first=${first}`],
      });
    });
  });

  it("the proof runs without the code from the newest base commit the pull request merged in, not from the commit it was opened on", () => {
    withMovedBase(({ openedOn, first, run, runStep, read }) => {
      const tip = run(["rev-parse", "amaraa-mode"]);
      run(["checkout", "-q", "fix/slugs"]);
      run([
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'amaraa-mode' into fix/slugs",
        "amaraa-mode",
      ]);
      runStep(
        workflowStep(
          "blind-checks.yml",
          "Fetch the pull request commits and the judge from the base branch",
        ),
        { HEAD_SHA: run(["rev-parse", "HEAD"]), BASE_SHA: openedOn, BASE_REF: "amaraa-mode" },
      );
      expect(read("temp", "output.txt").trim().split("\n")).toEqual([
        `base=${tip}`,
        `first=${first}`,
      ]);
    });
  });

  it("the lane bot runs the rules from the newest commit on the base branch, not from the commit the pull request was opened on", () => {
    withMovedBase(({ openedOn, runStep, read }) => {
      runStep(
        workflowStep(
          "merge-lane.yml",
          "Checkout base branch rules without the vendored .repos tree",
        ),
        { CHECKOUT_REF: openedOn, BASE_REF: "amaraa-mode" },
      );
      expect(read("work", ".github", "scripts", "merge-lane.cjs")).toBe("new rules\n");
    });
  });
});
