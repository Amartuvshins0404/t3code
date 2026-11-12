import { describe, expect, it } from "vite-plus/test";

import type { ChangedFile } from "../.github/scripts/merge-lane.cjs";
import {
  BREAK_WORDING,
  isStrengthRequired,
  judgeStrength,
  planStrength,
  renderStrength,
  strengthLabelChanges,
  strengthReasons,
  type StrengthVerdict,
  type StrykerReport,
} from "../.github/scripts/test-strength.cjs";
import rootPackage from "../package.json" with { type: "json" };
import weakReport from "./fixtures/test-strength/weak-report.json" with { type: "json" };

const COUNTED = [
  "ConditionalExpression",
  "EqualityOperator",
  "LogicalOperator",
  "MethodExpression",
  "Regex",
  "BooleanLiteral",
  "ArithmeticOperator",
  "UnaryOperator",
  "OptionalChaining",
  "UpdateOperator",
  "AssignmentOperator",
] as const;
const NOT_COUNTED = [
  "StringLiteral",
  "ObjectLiteral",
  "ArrayDeclaration",
  "BlockStatement",
  "ArrowFunction",
] as const;

const head = "a".repeat(40);
const checksMessage = "test(web): checks for slugs\n\nBlind-checks: written from the request";
const slug = "apps/web/src/lib/slug.ts";
const title = "apps/web/src/lib/title.ts";
const slugTestFile = "apps/web/src/lib/slug.test.ts";

const changedAt = (filename: string, lines: ReadonlyArray<number>): ChangedFile => ({
  filename,
  status: "modified",
  patch: lines
    .map(
      (line) =>
        `@@ -${line},1 +${line},1 @@\n-const old${line} = a || b;\n+const new${line} = a && b;`,
    )
    .join("\n"),
});
const addedFile = (filename: string, lines: ReadonlyArray<string>): ChangedFile => ({
  filename,
  status: "added",
  patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
});
const testFile = (filename: string) => addedFile(filename, ['it("slugs titles", () => {});']);

const pr = {
  firstMessage: checksMessage as string | null,
  commit: head,
  files: [
    changedAt(slug, [10, 11, 12, 13, 14, 20, 21, 30, 31]),
    changedAt(title, [5, 6]),
    testFile(slugTestFile),
  ],
  repoFiles: [] as ReadonlyArray<string>,
};
const plan = planStrength(pr);
const runPlan = (input: Parameters<typeof planStrength>[0]) => {
  const planned = planStrength(input);
  if (!planned.run) throw new Error(`not measured: ${planned.reason}`);
  return planned;
};

type Mutant = StrykerReport["files"][string]["mutants"][number];
const mutant = (
  id: number,
  mutatorName: string,
  status: string,
  line: number,
  replacement = "true",
): Mutant => ({
  id: String(id),
  mutatorName,
  replacement,
  status,
  location: { start: { line, column: 5 }, end: { line, column: 12 } },
});
const report = (files: Record<string, ReadonlyArray<Mutant>>): StrykerReport => ({
  schemaVersion: "1.0",
  files: Object.fromEntries(
    Object.entries(files).map(([file, mutants]) => [file, { language: "typescript", mutants }]),
  ),
});
const killedAt11 = mutant(90, "ConditionalExpression", "Killed", 11);
const strongReport = report({ [slug]: [killedAt11] });

const measure = (reports: ReadonlyArray<StrykerReport>) =>
  judgeStrength({ plan, testsPassed: true, reports });
const weak = measure([weakReport]);
const strong = measure([
  report({
    [slug]: [
      mutant(1, "ConditionalExpression", "Killed", 10),
      mutant(2, "EqualityOperator", "Killed", 11),
      mutant(3, "LogicalOperator", "Timeout", 12),
      mutant(4, "Regex", "Killed", 13),
      mutant(5, "BooleanLiteral", "Timeout", 20),
    ],
  }),
]);

const numbersIn = (text: string) => [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const showsLocation = (text: string, file: string, line: number) =>
  new RegExp(`${escapeRegex(file)}\\D{0,12}${line}(?!\\d)`).test(text);
const HOSTILE = ["evil.example", "<img", "@everyone", "<script", "alert(1)", "](https"];

describe("test strength: which breaks count", () => {
  it.each([
    ...COUNTED.map((kind) => [kind, true] as const),
    ...NOT_COUNTED.map((kind) => [kind, false] as const),
  ])("a surviving %s break counted: %s", (kind, counted) => {
    const verdict = measure([report({ [slug]: [killedAt11, mutant(1, kind, "Survived", 10)] })]);
    expect(verdict.result).toBe(counted ? "weak" : "strong");
    expect(verdict.tried).toBe(counted ? 2 : 1);
    expect(verdict.missed).toBe(counted ? 1 : 0);
  });

  it("a report holding only breaks that are not counted is not measured", () => {
    const verdict = measure([
      report({
        [slug]: NOT_COUNTED.map((kind, index) => mutant(index, kind, "Survived", 10 + index)),
      }),
    ]);
    expect(verdict).toMatchObject({ result: "not measured", reason: "no-breaks", tried: 0 });
  });

  it("names exactly the counted kinds in the fixed wording, one distinct sentence each", () => {
    expect(Object.keys(BREAK_WORDING).sort()).toEqual([...COUNTED].sort());
    const sentences = Object.values(BREAK_WORDING);
    expect(sentences.every((sentence) => sentence.trim().length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(COUNTED.length);
  });

  it.each(COUNTED)("an example of a %s break uses its fixed wording", (kind) => {
    const verdict = measure([
      report({ [slug]: [mutant(1, kind, "Survived", 12, "<b>free text</b>")] }),
    ]);
    expect(verdict.examples).toMatchObject([{ file: slug, line: 12, kind, ran: true }]);
    const text = renderStrength(verdict, { required: false });
    expect(text).toContain(BREAK_WORDING[kind]);
    expect(text).not.toContain("free text");
  });
});

describe("test strength: statuses", () => {
  it.each([
    { status: "Killed", result: "strong", tried: 2, missed: 0, uncovered: 0 },
    { status: "Timeout", result: "strong", tried: 2, missed: 0, uncovered: 0 },
    { status: "Survived", result: "weak", tried: 2, missed: 1, uncovered: 0 },
    { status: "NoCoverage", result: "weak", tried: 2, missed: 1, uncovered: 1 },
    { status: "RuntimeError", result: "strong", tried: 1, missed: 0, uncovered: 0 },
    { status: "CompileError", result: "strong", tried: 1, missed: 0, uncovered: 0 },
    { status: "Ignored", result: "strong", tried: 1, missed: 0, uncovered: 0 },
    { status: "Pending", result: "strong", tried: 1, missed: 0, uncovered: 0 },
  ])("a $status break", ({ status, result, tried, missed, uncovered }) => {
    const verdict = measure([
      report({ [slug]: [killedAt11, mutant(1, "EqualityOperator", status, 10)] }),
    ]);
    expect(verdict).toMatchObject({ result, tried, missed, uncovered });
  });
});

describe("test strength: the same break in several reports", () => {
  it.each([
    { statuses: ["Survived", "Killed"], result: "strong", missed: 0 },
    { statuses: ["NoCoverage", "Timeout"], result: "strong", missed: 0 },
    { statuses: ["Killed", "Survived"], result: "strong", missed: 0 },
    { statuses: ["Survived", "NoCoverage"], result: "weak", missed: 1 },
    { statuses: ["Survived", "RuntimeError"], result: "weak", missed: 1 },
  ])("$statuses is one break, $result", ({ statuses, result, missed }) => {
    const reports = statuses.map((status, index) =>
      report({ [slug]: [mutant(index * 7 + 3, "EqualityOperator", status, 10, "a !== b")] }),
    );
    expect(measure(reports)).toMatchObject({ result, tried: 1, missed });
  });

  it("two different breaks at the same place stay two breaks", () => {
    const verdict = measure([
      report({ [slug]: [mutant(1, "EqualityOperator", "Survived", 10, "a <= b")] }),
      report({ [slug]: [mutant(1, "EqualityOperator", "Killed", 10, "a >= b")] }),
    ]);
    expect(verdict).toMatchObject({ result: "weak", tried: 2, missed: 1 });
  });
});

describe("test strength: results", () => {
  it("strong says how many breaks were tried", () => {
    expect(strong).toMatchObject({ result: "strong", tried: 5, missed: 0 });
    const text = renderStrength(strong, { required: false });
    expect(text).toMatch(/\bstrong\b/);
    expect(numbersIn(text)).toContain(5);
  });

  it("weak counts breaks tried, not noticed, their lines and the lines no test ran", () => {
    expect(weak).toMatchObject({
      result: "weak",
      tried: 7,
      missed: 5,
      missedLines: 4,
      uncovered: 2,
    });
    const text = renderStrength(weak, { required: false });
    expect(text).toMatch(/\bweak\b/);
    expect(numbersIn(text)).toEqual(expect.arrayContaining([7, 5, 4, 2]));
  });

  it("weak shows at most 3 examples, tested-but-missed before untested, in fixed wording", () => {
    const survived = [
      { file: slug, line: 10, kind: "ConditionalExpression" },
      { file: slug, line: 10, kind: "EqualityOperator" },
      { file: slug, line: 12, kind: "LogicalOperator" },
    ];
    expect(weak.examples).toHaveLength(3);
    for (const example of weak.examples) {
      expect(survived).toContainEqual({
        file: example.file,
        line: example.line,
        kind: example.kind,
      });
      expect(example.ran).toBe(true);
    }
    const text = renderStrength(weak, { required: false });
    for (const example of weak.examples) {
      expect(showsLocation(text, example.file, example.line)).toBe(true);
      expect(text).toContain(BREAK_WORDING[example.kind]);
    }
    expect(showsLocation(text, slug, 20)).toBe(false);
    expect(showsLocation(text, title, 5)).toBe(false);
  });

  it("fills the examples with untested lines only after the tested ones", () => {
    const verdict = measure([
      report({
        [slug]: [
          mutant(1, "ConditionalExpression", "Survived", 10),
          mutant(2, "LogicalOperator", "NoCoverage", 12),
          mutant(3, "BooleanLiteral", "NoCoverage", 13),
          mutant(4, "Regex", "Survived", 14),
          mutant(5, "UnaryOperator", "NoCoverage", 20),
        ],
      }),
    ]);
    expect(verdict.examples).toHaveLength(3);
    expect(verdict.examples.map((example) => example.ran)).toEqual([true, true, false]);
    expect(
      verdict.examples
        .slice(0, 2)
        .map((example) => example.line)
        .sort(),
    ).toEqual([10, 14]);
    expect([12, 13, 20]).toContain(verdict.examples[2]?.line);
  });

  it("never shows more than 3 examples in the text", () => {
    const lines = [10, 11, 12, 13, 14];
    const verdict = measure([
      report({
        [slug]: lines.map((line, index) =>
          mutant(index, "ConditionalExpression", "Survived", line),
        ),
      }),
    ]);
    const text = renderStrength(verdict, { required: false });
    expect(lines.filter((line) => showsLocation(text, slug, line))).toHaveLength(3);
  });

  it("shows no free text from the report, only paths, lines, counts and fixed wording", () => {
    const text = renderStrength(weak, { required: true });
    for (const hostile of HOSTILE) expect(text).not.toContain(hostile);
  });

  it("does not trust example text or kinds in a measurement read back as data", () => {
    const tampered = JSON.parse(
      JSON.stringify({
        ...weak,
        examples: weak.examples.map((example) => ({
          ...example,
          kind: "<img src=x onerror=alert(1)>",
          text: "@everyone [win](https://evil.example)",
        })),
      }),
    ) as StrengthVerdict;
    const text = renderStrength(tampered, { required: false });
    for (const hostile of HOSTILE) expect(text).not.toContain(hostile);
  });

  it("does not count breaks in files or lines the pull request did not change", () => {
    const verdict = measure([
      report({
        [slug]: [killedAt11, mutant(2, "EqualityOperator", "Survived", 50)],
        [slugTestFile]: [mutant(3, "ConditionalExpression", "Survived", 1)],
        "apps/web/src/lib/other.ts": [mutant(4, "LogicalOperator", "Survived", 10)],
      }),
    ]);
    expect(verdict).toMatchObject({ result: "strong", tried: 1, missed: 0 });
  });
});

describe("test strength: not measured", () => {
  it.each([
    {
      name: "no checks commit",
      input: { firstMessage: "feat(web): slugs" },
      reason: "no-checks",
    },
    {
      name: "no first commit at all",
      input: { firstMessage: null },
      reason: "no-checks",
    },
    {
      name: "the first commit says no test is needed",
      input: { firstMessage: "chore: start\n\nBlind-checks: none, copy text only" },
      reason: "none-needed",
    },
    {
      name: "no changed JavaScript or TypeScript code",
      input: {
        files: [
          changedAt("docs/user/slugs.md", [3]),
          changedAt("scripts/convert-device-model.py", [4]),
          changedAt("apps/web/src/lib/slug.css", [5]),
          changedAt("apps/web/package.json", [6]),
          testFile(slugTestFile),
        ],
      },
      reason: "no-code",
    },
    {
      name: "the only tests are browser tests",
      input: {
        files: [changedAt(slug, [10]), testFile("apps/web/src/lib/slug.browser.test.tsx")],
      },
      reason: "browser-only",
    },
  ])("$name", ({ input, reason }) => {
    const planned = planStrength({ ...pr, ...input });
    const verdict = judgeStrength({ plan: planned, testsPassed: true, reports: [strongReport] });
    expect(verdict).toMatchObject({ result: "not measured", reason });
  });

  it("repeats the reason the first commit gives for needing no test", () => {
    const planned = planStrength({
      ...pr,
      firstMessage: "chore: start\n\nBlind-checks: none, copy text only",
    });
    const text = renderStrength(judgeStrength({ plan: planned }), { required: false });
    expect(text).toContain("not measured");
    expect(text).toContain("copy text only");
  });

  it("the tests did not pass with the code", () => {
    expect(judgeStrength({ plan, testsPassed: false, reports: [strongReport] })).toMatchObject({
      result: "not measured",
      reason: "tests-failed",
    });
  });

  it("no counted break could be made, including when no report came back", () => {
    expect(measure([])).toMatchObject({ result: "not measured", reason: "no-breaks" });
  });

  it("ran out of time, saying how many breaks were tried of how many", () => {
    const verdict = judgeStrength({
      plan,
      testsPassed: true,
      reports: [strongReport],
      outOfTime: { tried: 37, total: 90 },
    });
    expect(verdict).toMatchObject({ result: "not measured", reason: "out-of-time" });
    expect(numbersIn(renderStrength(verdict, { required: false }))).toEqual(
      expect.arrayContaining([37, 90]),
    );
  });

  it("never says strong when no test ran", () => {
    const planned = planStrength({ ...pr, files: [changedAt(slug, [10, 11])] });
    const verdict = judgeStrength({ plan: planned, testsPassed: true, reports: [strongReport] });
    expect(verdict.result).toBe("not measured");
  });

  it("says a different why for each reason", () => {
    const verdicts = [
      judgeStrength({ plan: planStrength({ ...pr, firstMessage: "feat(web): slugs" }) }),
      judgeStrength({
        plan: planStrength({ ...pr, firstMessage: "chore: x\n\nBlind-checks: none, copy text" }),
      }),
      judgeStrength({
        plan: planStrength({ ...pr, files: [changedAt("docs/a.md", [1]), testFile(slugTestFile)] }),
      }),
      judgeStrength({
        plan: planStrength({
          ...pr,
          files: [changedAt(slug, [10]), testFile("apps/web/src/lib/slug.browser.test.tsx")],
        }),
      }),
      judgeStrength({ plan, testsPassed: false, reports: [strongReport] }),
      measure([]),
      judgeStrength({
        plan,
        testsPassed: true,
        reports: [strongReport],
        outOfTime: { tried: 1, total: 2 },
      }),
    ];
    expect(new Set(verdicts.map((verdict) => verdict.reason)).size).toBe(7);
    const texts = verdicts.map((verdict) => renderStrength(verdict, { required: false }));
    for (const text of texts) expect(text).toContain("not measured");
    expect(new Set(texts).size).toBe(7);
  });
});

describe("test strength: what gets broken and which tests run", () => {
  it("breaks only changed JavaScript and TypeScript code, never tests, docs, lockfiles, generated or vendored files", () => {
    const code = ["js", "cjs", "mjs", "jsx", "ts", "tsx", "mts", "cts"].map(
      (ext) => `apps/web/src/kinds/a.${ext}`,
    );
    const never = [
      "apps/web/src/kinds/a.test.ts",
      "apps/web/src/kinds/a.spec.tsx",
      "apps/web/src/kinds/fixtures/data.ts",
      "packages/shared/src/testing/clock.ts",
      "apps/server/src/thread.testkit.ts",
      "apps/web/src/__tests__/helpers.ts",
      "docs/user/guide.md",
      "README.md",
      "pnpm-lock.yaml",
      "apps/web/src/routeTree.gen.ts",
      "packages/client-runtime/src/generated/api.ts",
      ".repos/effect-smol/packages/effect/src/Effect.ts",
      "apps/web/src/style.css",
      "scripts/convert-device-model.py",
    ];
    const planned = runPlan({
      ...pr,
      files: [...code, ...never].map((file) => changedAt(file, [3])),
    });
    expect(planned.code.map((entry) => entry.file).sort()).toEqual([...code].sort());
  });

  it("breaks the lines the pull request added or changed, not context or deleted lines", () => {
    const patch = [
      "@@ -10,5 +10,5 @@ export function slug(text: string) {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = b > 2;",
      " const d = 5;",
      "-const e = 6;",
      " const f = 7;",
      "@@ -40,1 +41,1 @@",
      "-return a || b;",
      "+return a && b;",
    ].join("\n");
    const planned = runPlan({
      ...pr,
      files: [{ filename: slug, status: "modified", patch }, testFile(slugTestFile)],
    });
    expect(planned.code).toMatchObject([{ file: slug, lines: [11, 12, 41] }]);
  });

  it("runs the pull request's tests, in any package, plus same-name tests next to changed code", () => {
    const planned = runPlan({
      ...pr,
      files: [
        changedAt("packages/shared/src/git.ts", [4]),
        testFile("apps/server/src/thread.test.ts"),
        testFile("apps/web/src/lib/slug.browser.test.tsx"),
      ],
      repoFiles: [
        "packages/shared/src/git.ts",
        "packages/shared/src/git.test.ts",
        "packages/shared/src/gitRemote.test.ts",
        "packages/shared/test/git.test.ts",
        "apps/server/src/thread.test.ts",
        "apps/server/src/other.test.ts",
      ],
    });
    expect([...planned.tests].sort()).toEqual([
      "apps/server/src/thread.test.ts",
      "packages/shared/src/git.test.ts",
    ]);
  });

  it("a same-name test next to changed code is enough to measure", () => {
    const planned = runPlan({
      ...pr,
      files: [changedAt(slug, [10]), testFile("apps/web/src/lib/slug.browser.test.tsx")],
      repoFiles: [slug, slugTestFile],
    });
    expect(planned.tests).toEqual([slugTestFile]);
  });
});

describe("test strength: over 800 changed lines", () => {
  const big = {
    ...pr,
    files: [
      ...["a", "b", "c", "d"].map((name) =>
        addedFile(
          `apps/web/src/big/${name}.ts`,
          Array.from({ length: 250 }, (_, index) => `export const v${index} = ${index} > 3;`),
        ),
      ),
      testFile("apps/web/src/big/a.test.ts"),
    ],
  };

  it("measures an even sample of 800 lines and says so", () => {
    const planned = runPlan(big);
    expect(planned).toMatchObject({ measured: 800, total: 1000 });
    const lines = planned.code.flatMap((entry) =>
      entry.lines.map((line) => `${entry.file}:${line}`),
    );
    expect(lines).toHaveLength(800);
    expect(new Set(lines).size).toBe(800);
    for (const entry of planned.code) {
      expect(entry.lines.every((line) => line >= 1 && line <= 250)).toBe(true);
      expect(entry.lines.length).toBeGreaterThanOrEqual(150);
      expect(entry.lines.length).toBeLessThanOrEqual(250);
    }
    expect(planned.code).toHaveLength(4);

    const [first] = planned.code;
    const text = renderStrength(
      judgeStrength({
        plan: planned,
        testsPassed: true,
        reports: [
          report({
            [first?.file ?? ""]: [
              mutant(1, "ConditionalExpression", "Killed", first?.lines[0] ?? 0),
            ],
          }),
        ],
      }),
      { required: false },
    );
    expect(numbersIn(text)).toEqual(expect.arrayContaining([800, 1000]));
  });

  it("gives the same sample for the same commit", () => {
    expect(planStrength(big)).toEqual(planStrength({ ...big, files: [...big.files] }));
  });

  it("measures every line at 800 or fewer", () => {
    const planned = planStrength({ ...big, files: big.files.filter((_, index) => index !== 3) });
    expect(planned).toMatchObject({ run: true, measured: 750, total: 750 });
  });
});

describe("test strength: the switch, the lane and the labels", () => {
  it.each([
    [{ TEST_STRENGTH_MODE: "required" }, true],
    [{ TEST_STRENGTH_MODE: "report" }, false],
    [{}, false],
    [{ BLIND_CHECKS_MODE: "required" }, false],
    [{ TEST_STRENGTH_MODE: "required", BLIND_CHECKS_MODE: "report" }, true],
  ])("%j switched on: %s", (env, required) => {
    expect(isStrengthRequired(env)).toBe(required);
  });

  const noneNeeded = judgeStrength({
    plan: planStrength({ ...pr, firstMessage: "chore: start\n\nBlind-checks: none, copy text" }),
  });
  const testsFailed = judgeStrength({ plan, testsPassed: false, reports: [strongReport] });
  const outOfTime = judgeStrength({
    plan,
    testsPassed: true,
    reports: [strongReport],
    outOfTime: { tried: 3, total: 9 },
  });
  const pending: StrengthVerdict = {
    result: "not measured",
    reason: "pending",
    tried: 0,
    missed: 0,
    missedLines: 0,
    uncovered: 0,
    examples: [],
  };

  it.each([
    { name: "weak", verdict: weak, required: true, red: true },
    { name: "strong", verdict: strong, required: true, red: false },
    { name: "tests did not pass", verdict: testsFailed, required: true, red: true },
    { name: "out of time", verdict: outOfTime, required: true, red: true },
    { name: "no test needed", verdict: noneNeeded, required: true, red: false },
    { name: "Blind checks has not finished", verdict: pending, required: true, red: true },
    { name: "weak", verdict: weak, required: false, red: false },
    { name: "tests did not pass", verdict: testsFailed, required: false, red: false },
  ])("$name with the switch on: $required -> red: $red", ({ verdict, required, red }) => {
    const reasons = strengthReasons(verdict, { required });
    if (!red) {
      expect(reasons).toEqual([]);
      return;
    }
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.lane).toBe("red");
    expect(reasons[0]?.why.trim().length).toBeGreaterThan(0);
  });

  it("says it does not change the lane only while the switch is off", () => {
    expect(renderStrength(weak, { required: false })).toMatch(/not change the lane/i);
    expect(renderStrength(weak, { required: true })).not.toMatch(/not change the lane/i);
  });

  it("names its section Test strength", () => {
    expect(renderStrength(strong, { required: false })).toContain("Test strength");
  });

  it.each([
    { current: ["lane:amber"], result: "strong", add: ["strength:strong"], remove: [] },
    {
      current: ["strength:weak", "lane:red", "strength:unmeasured"],
      result: "strong",
      add: ["strength:strong"],
      remove: ["strength:weak", "strength:unmeasured"],
    },
    { current: ["strength:weak", "bug"], result: "weak", add: [], remove: [] },
    {
      current: ["strength:strong", "bug"],
      result: "not measured",
      add: ["strength:unmeasured"],
      remove: ["strength:strong"],
    },
    { current: [], result: "weak", add: ["strength:weak"], remove: [] },
  ] as const)("keeps exactly one strength label: $current -> $result", (row) => {
    const changes = strengthLabelChanges(row.current, row.result);
    expect([...changes.add].sort()).toEqual([...row.add].sort());
    expect([...changes.remove].sort()).toEqual([...row.remove].sort());
  });
});

describe("test strength: Stryker", () => {
  it("pins Stryker 10.1.1 and its vitest runner as root dev dependencies", () => {
    const devDependencies: Record<string, string> = rootPackage.devDependencies;
    expect(devDependencies["@stryker-mutator/core"]).toBe("10.1.1");
    expect(devDependencies["@stryker-mutator/vitest-runner"]).toBe("10.1.1");
  });
});
