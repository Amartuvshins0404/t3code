// @effect-diagnostics nodeBuiltinImport:off
import { it as effectIt } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
const urlTest = "apps/web/src/lib/url.test.ts";
const slugInputs = "apps/web/src/lib/testkit/slugInputs.ts";
const testSetup = "apps/web/test/setup.ts";
const realCode = "src/real.ts";

type Lines = ReadonlyArray<string>;
interface Change {
  readonly file: string;
  readonly lines: Lines | null;
  readonly from?: string;
}
interface Step {
  readonly sha: string;
  readonly message: string;
  readonly changes: ReadonlyArray<Change>;
}

const testLine = (name: string) => `it("${name}", () => {});`;

const patchOf = (from: Lines, to: Lines) => {
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same += 1;
  let tail = 0;
  while (
    tail < from.length - same &&
    tail < to.length - same &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  )
    tail += 1;
  const removed = from.slice(same, from.length - tail);
  const added = to.slice(same, to.length - tail);
  return [
    `@@ -${same + 1},${removed.length} +${same + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
};

const statusOf = (change: Change, was: Lines | undefined) => {
  if (change.lines === null) return "removed";
  if (change.from !== undefined) return "renamed";
  return was ? "modified" : "added";
};

const story = (start: ReadonlyMap<string, Lines>, steps: ReadonlyArray<Step>) => {
  const head = new Map(start);
  const commits = steps.map((step) => ({
    sha: step.sha.repeat(40),
    message: step.message,
    files: step.changes.map((change): ChangedFile => {
      const source = change.from ?? change.file;
      const was = head.get(source);
      head.delete(source);
      if (change.lines) head.set(change.file, change.lines);
      return {
        filename: change.file,
        ...(change.from === undefined ? {} : { previous_filename: change.from }),
        status: statusOf(change, was),
        patch: patchOf(was ?? [], change.lines ?? []),
      };
    }),
  }));
  const text = (lines: Lines | undefined) => (lines ? `${lines.join("\n")}\n` : null);
  return {
    commits,
    base,
    read: (at: "base" | "head", file: string) => text((at === "base" ? start : head).get(file)),
  };
};

const step = (sha: string, message: string, ...changes: ReadonlyArray<Change>): Step => ({
  sha,
  message,
  changes,
});
const checksMessage = "test(web): checks for slugs\n\nBlind-checks: written from the request";
const checks = (...changes: ReadonlyArray<Change>) => step("c", checksMessage, ...changes);
const revise = (...changes: ReadonlyArray<Change>) =>
  step("f", "test(web): revise a check\n\nBlind-checks: revised after an objection", ...changes);
const code = step("d", "feat(web): slugs", {
  file: "apps/web/src/lib/slug.ts",
  lines: ["export const slug = (text: string) => text;"],
});
const slugChecks: ReadonlyArray<Change> = [
  { file: slugTest, lines: [testLine("keeps letters"), testLine("drops spaces")] },
  { file: slugInputs, lines: ['export const inputs = ["a b"];'] },
];
const titleAtBase = [testLine("keeps the title"), testLine("keeps case")];
const titleWith = (...names: Lines): Change => ({
  file: titleTest,
  lines: [...titleAtBase, ...names.map(testLine)],
});
const atBase = new Map<string, Lines>([
  [titleTest, titleAtBase],
  [realCode, ["export const real = false;"]],
  [testSetup, ["export const locale = 'mn';"]],
]);
const planOf = (...steps: ReadonlyArray<Step>) => planProof(story(atBase, steps));

const supportOf = (plan: ReturnType<typeof planProof>) =>
  plan.run ? [...plan.support].sort() : [];

const sorted = (plan: ReturnType<typeof planProof>) =>
  plan.run
    ? plan.files
        .map((entry) => ({ ...entry, tests: [...entry.tests].sort() }))
        .sort((a, b) => a.file.localeCompare(b.file))
    : [];

const testsIn = (plan: ReturnType<typeof planProof>, file: string) =>
  plan.run ? [...(plan.files.find((entry) => entry.file === file)?.tests ?? [])].sort() : [];

const loaded = (file: string, tests: ReadonlyArray<readonly [string, string]>): TestResult => ({
  name: `/repo/${file}`,
  assertionResults: tests.map(([title, status]) => ({ title, status })),
});
const byFile = (results: ReadonlyArray<TestResult>) =>
  new Map(results.map((result) => [result.name.replace("/repo/", ""), result] as const));
const proven = (
  plan: ReturnType<typeof planProof>,
  before: ReadonlyArray<TestResult>,
  after: ReadonlyArray<TestResult>,
) => {
  if (!plan.run) throw new Error(`nothing planned: ${plan.note}`);
  return judge({ files: plan.files }, byFile(before), byFile(after)).ok;
};

const tableAt = (title: string) => [
  ...titleAtBase,
  'const cases = [{ name: "a b" }, { name: "c" }];',
  `it.each(cases)("${title}", () => {});`,
];
const retitled = () =>
  planOf(
    checks({ file: titleTest, lines: tableAt("$name") }),
    code,
    revise({ file: titleTest, lines: tableAt("slugs $name") }),
  );

describe("blind checks proof: what is planned", () => {
  it("a pull request whose checks were never revised plans the checks commit's test files, as before", () => {
    const plan = planOf(checks(...slugChecks), code);
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
    ]);
  });

  it("runs without the code on the point where the pull request left the base branch", () => {
    expect(planOf(checks(...slugChecks), code)).toMatchObject({ run: true, base });
  });

  it("plans a test file that only a revision adds or changes, with the tests the revision names", () => {
    const plan = planOf(
      checks(...slugChecks),
      code,
      revise(titleWith("slugs emoji"), { file: urlTest, lines: [testLine("keeps the scheme")] }),
    );
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
      { file: titleTest, added: false, tests: ["slugs emoji"] },
      { file: urlTest, added: true, tests: ["keeps the scheme"] },
    ]);
  });

  it("drops a name a revision removed from a changed file and keeps every name still at the head", () => {
    const plan = planOf(
      checks(titleWith("slugs My Title", "slugs emoji")),
      code,
      revise(titleWith("slugs emoji", "slugs digits")),
    );
    expect(sorted(plan)).toEqual([
      { file: titleTest, added: false, tests: ["slugs digits", "slugs emoji"] },
    ]);
  });

  it("leaves out a test file a revision removed, since the newest commit has no such tests", () => {
    const plan = planOf(
      checks(...slugChecks, titleWith("slugs My Title")),
      code,
      revise({ file: slugTest, lines: null }),
    );
    expect(sorted(plan)).toEqual([{ file: titleTest, added: false, tests: ["slugs My Title"] }]);
  });

  it("ignores test files changed by commits with no checks trailer, such as merged base branch work", () => {
    const mergedBase = step(
      "e",
      "Merge branch 'amaraa-mode' into fix/slugs",
      { file: upstreamTest, lines: [testLine("reads refs")] },
      titleWith("trims"),
    );
    const plan = planOf(checks(...slugChecks), mergedBase, code);
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
    ]);
  });

  it("keeps a test file the checks commit added as added after a revision changed it", () => {
    const plan = planOf(
      checks(...slugChecks),
      code,
      revise({
        file: slugTest,
        lines: [testLine("keeps letters"), testLine("drops spaces"), testLine("keeps digits")],
      }),
    );
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps digits", "keeps letters"] },
    ]);
  });

  it("compares a test file a revision renamed with the base file under its old name, and keeps an added one added", () => {
    const renamedSlug = "apps/web/src/lib/slugify.test.ts";
    const renamedTitle = "apps/web/src/lib/heading.test.ts";
    const plan = planOf(
      checks(...slugChecks, titleWith("slugs My Title")),
      code,
      revise(
        {
          file: renamedSlug,
          from: slugTest,
          lines: [testLine("keeps letters"), testLine("drops spaces"), testLine("keeps digits")],
        },
        { file: renamedTitle, from: titleTest, lines: [...titleAtBase, testLine("slugs emoji")] },
      ),
    );
    expect(sorted(plan)).toEqual([
      { file: renamedTitle, added: false, tests: ["slugs emoji"] },
      { file: renamedSlug, added: true, tests: ["drops spaces", "keeps digits", "keeps letters"] },
    ]);
  });

  it("proves the tests of a revision that comes after a first commit saying no test is needed", () => {
    const plan = planOf(
      step("a", "chore(web): slugs\n\nBlind-checks: none, copy text only"),
      code,
      revise({ file: urlTest, lines: [testLine("keeps the scheme")] }),
    );
    expect(sorted(plan)).toEqual([{ file: urlTest, added: true, tests: ["keeps the scheme"] }]);
  });
});

describe("blind checks proof: which files the base branch run takes from the newest commit", () => {
  it("takes a test-support file the checks commit changed", () => {
    expect(supportOf(planOf(checks(...slugChecks), code))).toEqual([slugInputs]);
  });

  it("takes a test-support file that only a commit with no checks trailer changed", () => {
    const setupFix = step("e", "fix(web): slug test setup", {
      file: testSetup,
      lines: ["export const locale = 'en';"],
    });
    expect(supportOf(planOf(checks(...slugChecks), code, setupFix))).toEqual(
      [slugInputs, testSetup].sort(),
    );
  });

  it("leaves code a revision edits as the base branch has it, and still plans the revision's test file", () => {
    const plan = planOf(
      checks(...slugChecks),
      code,
      revise(titleWith("slugs emoji"), { file: realCode, lines: ["export const real = true;"] }),
    );
    expect(supportOf(plan)).not.toContain(realCode);
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["drops spaces", "keeps letters"] },
      { file: titleTest, added: false, tests: ["slugs emoji"] },
    ]);
  });
});

describe("blind checks proof: new tests are the names the head writes more often than the base", () => {
  it("plans only the head's title for a table a revision retitled from a bare placeholder", () => {
    expect(sorted(retitled())).toEqual([{ file: titleTest, added: false, tests: ["slugs $name"] }]);
  });

  it("is proven when a retitled table fails without the code while the file's old tests pass", () => {
    expect(
      proven(
        retitled(),
        [
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["keeps case", "passed"],
            ["slugs a b", "failed"],
            ["slugs c", "failed"],
          ]),
        ],
        [
          loaded(titleTest, [
            ["keeps the title", "passed"],
            ["keeps case", "passed"],
            ["slugs a b", "passed"],
            ["slugs c", "passed"],
          ]),
        ],
      ),
    ).toBe(true);
  });

  it("counts a name as new only when the head writes it more times, even if a checks commit moved it", () => {
    const plan = planOf(
      checks({
        file: titleTest,
        lines: [
          testLine("keeps case"),
          testLine("keeps the title"),
          testLine("keeps case"),
          testLine("slugs emoji"),
        ],
      }),
      code,
    );
    expect(sorted(plan)).toEqual([
      { file: titleTest, added: false, tests: ["keeps case", "slugs emoji"] },
    ]);
  });

  it("lists every name at the head of an added test file once, after a revision dropped one", () => {
    const plan = planOf(
      checks(...slugChecks),
      code,
      revise({
        file: slugTest,
        lines: [testLine("keeps letters"), testLine("keeps digits"), testLine("keeps letters")],
      }),
    );
    expect(sorted(plan)).toEqual([
      { file: slugTest, added: true, tests: ["keeps digits", "keeps letters"] },
    ]);
  });

  const names = Arbitrary.array(
    Arbitrary.schema(Schema.Literals(["keeps letters", "drops spaces", "slugs emoji"])),
    { maxLength: 5 },
  );
  const timesIn = (list: Lines, name: string) => list.filter((entry) => entry === name).length;
  const newNames = ([baseNames, headNames]: readonly [Lines, Lines]) => {
    const plan = planProof(
      story(new Map([[titleTest, ['export const side = "base";', ...baseNames.map(testLine)]]]), [
        checks({
          file: titleTest,
          lines: ['export const side = "head";', ...headNames.map(testLine)],
        }),
        code,
      ]),
    );
    expect(testsIn(plan, titleTest)).toEqual(
      [...new Set(headNames)]
        .filter((name) => timesIn(headNames, name) > timesIn(baseNames, name))
        .sort(),
    );
  };
  const sides: [typeof names, typeof names] = [names, names];
  const seeded = { arbitrary: { seed: 42 } };

  effectIt.prop("plans exactly the names the head writes more often", sides, newNames, seeded);
});

describe("blind checks proof: names that cannot pick out their tests", () => {
  const allFailedThenPassed = (titles: Lines) => ({
    before: byFile([
      loaded(
        titleTest,
        titles.map((title) => [title, "failed"] as const),
      ),
    ]),
    after: byFile([
      loaded(
        titleTest,
        titles.map((title) => [title, "passed"] as const),
      ),
    ]),
  });
  const verdictFor = (name: string, titles: Lines) => {
    const planned: PlannedFile = { file: titleTest, added: false, tests: [name] };
    const { before, after } = allFailedThenPassed(titles);
    const verdict = judge({ files: [planned] }, before, after);
    const problems = verdict.rows.find((row) => row.file === titleTest)?.problems ?? [];
    return { ok: verdict.ok, named: problems.some((problem) => problem.includes(name)) };
  };
  const titles = ["keeps the title", "slugs a b", "slugs c"];

  it("is not proven when a new test's name is only placeholders, and still proven with fixed words beside one", () => {
    const rows = [
      { name: "$name", ok: false },
      { name: "%s", ok: false },
      { name: "$input %s", ok: false },
      { name: "$from, $to", ok: false },
      { name: "slugs $input", ok: true },
    ];
    expect(rows.map((row) => ({ name: row.name, ...verdictFor(row.name, titles) }))).toEqual(
      rows.map((row) => ({ name: row.name, ok: row.ok, named: !row.ok })),
    );
  });

  it("is not proven when a new test's name is not on its first line, and says so", () => {
    expect(verdictFor("a test whose name is not on its first line", titles)).toEqual({
      ok: false,
      named: true,
    });
  });
});

const tempRepo = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "blind-checks-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Dev",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Dev",
    GIT_COMMITTER_EMAIL: "dev@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_OUTPUT: "",
    GITHUB_STEP_SUMMARY: "",
  };
  const run = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  const commitFiles = (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, path), text);
    }
    run(["add", "-A"]);
    run(["commit", "-q", "-m", message]);
    return run(["rev-parse", "HEAD"]);
  };
  return { dir, env, run, commitFiles };
};

describe("blind checks proof: the pull request's own commits", () => {
  it("lists only the commits since the branch left the base branch, oldest first, with their messages and files", () => {
    const { dir, run, commitFiles } = tempRepo();
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

  it("the plan command reads both sides of a test file from git and keeps only the head's title", () => {
    const { dir, env, run, commitFiles } = tempRepo();
    const oldTests = 'it("keeps the title", () => {});\nit("keeps case", () => {});\n';
    const table = (title: string) =>
      `${oldTests}const cases = [{ name: "a b" }];\nit.each(cases)("${title}", () => {});\n`;
    const script = NodeURL.fileURLToPath(
      new URL("../.github/scripts/blind-checks.cjs", import.meta.url),
    );
    try {
      run(["init", "-q", "-b", "amaraa-mode"]);
      const left = commitFiles("feat: start", {
        "src/slug.js": "export const slug = (text) => text;\n",
        "src/slug.test.js": oldTests,
      });
      run(["checkout", "-q", "-b", "fix/slugs"]);
      commitFiles("test: checks for slugs\n\nBlind-checks: written from the request", {
        "src/slug.test.js": table("$name"),
      });
      commitFiles("feat: slugs lowercase", {
        "src/slug.js": "export const slug = (text) => text.toLowerCase();\n",
      });
      const head = commitFiles(
        "test: retitle the table\n\nBlind-checks: revised after an objection",
        {
          "src/slug.test.js": table("slugs $name"),
        },
      );
      const out = NodePath.join(dir, ".proof");
      NodeChildProcess.execFileSync(
        process.execPath,
        [script, "plan", "--base", left, "--head", head, "--dir", out, "--cwd", dir],
        { cwd: dir, encoding: "utf8", env },
      );
      const planned: unknown = JSON.parse(
        NodeFS.readFileSync(NodePath.join(out, "plan.json"), "utf8"),
      );
      expect(planned).toMatchObject({
        run: true,
        base: left,
        files: [{ file: "src/slug.test.js", added: false, tests: ["slugs $name"] }],
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blind checks proof: revised checks are judged as they are at the newest commit", () => {
  const revised = () => planOf(checks(...slugChecks), code, revise(titleWith("slugs emoji")));
  const slugPassed = loaded(slugTest, [
    ["keeps letters", "passed"],
    ["drops spaces", "passed"],
  ]);
  const slugFailed = loaded(slugTest, [
    ["keeps letters", "failed"],
    ["drops spaces", "failed"],
  ]);
  const titleRun = (emoji: string) =>
    loaded(titleTest, [
      ["keeps the title", "passed"],
      ["keeps case", "passed"],
      ["slugs emoji", emoji],
    ]);

  it("is proven when a test only the revision added fails on the base branch code and passes at the newest commit", () => {
    expect(
      proven(revised(), [slugFailed, titleRun("failed")], [slugPassed, titleRun("passed")]),
    ).toBe(true);
  });

  it("is not proven when a test only the revision added already passes on the base branch code", () => {
    expect(
      proven(revised(), [slugFailed, titleRun("passed")], [slugPassed, titleRun("passed")]),
    ).toBe(false);
  });

  it("is not proven when a file only the revision touched did not run", () => {
    expect(proven(revised(), [slugFailed], [slugPassed])).toBe(false);
  });
});
