const { execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { TEST_FILE, checksMarker, isTestSupport, parseGitDiff } = require("./merge-lane.cjs");

const MAX_LINES = 800;
const MINUTES = 5;
const CODE_FILE = /\.(?:js|cjs|mjs|jsx|ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const GENERATED = /(\.gen\.|_generated|(^|\/)generated|\.generated\.)/;
const VENDORED = /(^|\/)(\.repos|node_modules)\//;
const BROWSER_TEST = /\.browser\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_STEM = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NOTICED = new Set(["Killed", "Timeout"]);
const MISSED = new Set(["Survived", "NoCoverage"]);
const NOT_COUNTED = [
  "ArrayDeclaration",
  "ArrowFunction",
  "BlockStatement",
  "CallExpression",
  "ObjectLiteral",
  "StringLiteral",
];
const RED_WHEN_UNMEASURED = new Set([
  "browser-only",
  "tests-failed",
  "no-breaks",
  "out-of-time",
  "pending",
  "missing",
]);

const BREAK_WORDING = Object.freeze({
  ConditionalExpression:
    "A condition was forced to always be true or always be false, and every test still passed.",
  EqualityOperator:
    "A comparison was changed, for example 'at least' to 'more than' or 'equal' to 'not equal', and every test still passed.",
  LogicalOperator:
    "'and' was changed to 'or', or the other way round, and every test still passed.",
  MethodExpression:
    "A built-in step was swapped for another, for example 'all of them' to 'any one of them' or 'starts with' to 'ends with', and every test still passed.",
  Regex: "A text pattern was changed so it matches different text, and every test still passed.",
  BooleanLiteral:
    "'true' was changed to 'false', or the other way round, and every test still passed.",
  ArithmeticOperator:
    "A calculation was changed, for example 'plus' to 'minus', and every test still passed.",
  UnaryOperator: "A 'not' or a minus sign was flipped or removed, and every test still passed.",
  OptionalChaining:
    "A guard for a missing value was removed, so the code would crash on it, and every test still passed.",
  UpdateOperator:
    "A count that goes up was made to go down, or the other way round, and every test still passed.",
  AssignmentOperator:
    "How a value is updated was changed, for example 'add to it' to 'take away from it', and every test still passed.",
});

const UNMEASURED_WHY = {
  "no-checks": () =>
    "This pull request has no checks commit with tests to run, so there is nothing to measure.",
  "none-needed": (verdict) =>
    `The first commit says no test is needed: "${plainNote(verdict.note) || "no reason given"}".`,
  "no-code": () =>
    "None of the changed code is JavaScript or TypeScript, so there is nothing to break.",
  "browser-only": () => "The only tests are browser tests, which this check does not run yet.",
  "tests-failed": () => "The tests did not pass with the code, so there was nothing to break.",
  "no-breaks": () =>
    "No break that changes a decision could be made in the changed lines, so there was nothing to try.",
  "out-of-time": (verdict) =>
    `It ran out of time after ${MINUTES} minutes; ${count(verdict.outOfTime?.tried)} of ${count(verdict.outOfTime?.total)} breaks were tried.`,
  pending: () =>
    "Blind checks has not finished for this commit yet. This section updates a few minutes after it does.",
  missing: () =>
    "Blind checks finished for this commit without a measurement, for example because its install or its tests stopped early.",
};

const LABELS = {
  strong: "strength:strong",
  weak: "strength:weak",
  "not measured": "strength:unmeasured",
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
const unique = (items) => [...new Set(items)];
const safePath = (file) =>
  String(file)
    .replace(/[`\r\n]/g, "?")
    .slice(0, 200);
const plainNote = (text) =>
  String(text ?? "")
    .replace(/[^\p{L}\p{N} .,;:'()-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

function isCode(file) {
  return (
    CODE_FILE.test(file) &&
    !DECLARATION.test(file) &&
    !GENERATED.test(file) &&
    !VENDORED.test(file) &&
    !isTestSupport(file)
  );
}

function changedLines(patch) {
  const lines = [];
  let next = 0;
  for (const line of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || line.startsWith("-") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) lines.push(next);
    next += 1;
  }
  return unique(lines).sort((a, b) => a - b);
}

function sample(code, commit) {
  const total = code.reduce((sum, entry) => sum + entry.lines.length, 0);
  if (total <= MAX_LINES) return { code, measured: total, total };
  const step = total / MAX_LINES;
  const offset = (Number.parseInt(sha256(commit).slice(0, 8), 16) / 0x100000000) * step;
  const picked = new Set(
    Array.from({ length: MAX_LINES }, (_, i) => Math.floor(offset + i * step)),
  );
  let index = 0;
  const sampled = code
    .map((entry) => ({
      file: entry.file,
      lines: entry.lines.filter(() => picked.has(index++)),
    }))
    .filter((entry) => entry.lines.length > 0);
  return { code: sampled, measured: MAX_LINES, total };
}

function planStrength({ firstMessage, commit, files, repoFiles }) {
  const marker = checksMarker(firstMessage);
  if (!marker) return { run: false, reason: "no-checks" };
  if (marker.kind === "none") return { run: false, reason: "none-needed", note: marker.reason };
  const present = files.filter((file) => file.status !== "removed");
  const code = present
    .filter((file) => isCode(file.filename))
    .map((file) => ({ file: file.filename, lines: changedLines(file.patch) }))
    .filter((entry) => entry.lines.length > 0)
    .sort((a, b) => a.file.localeCompare(b.file));
  if (code.length === 0) return { run: false, reason: "no-code" };
  const stems = new Set(code.map((entry) => entry.file.replace(CODE_FILE, "")));
  const isTest = (file) => TEST_FILE.test(file) && !VENDORED.test(file);
  const found = unique([
    ...present.map((file) => file.filename).filter(isTest),
    ...repoFiles.filter((file) => isTest(file) && stems.has(file.replace(TEST_STEM, ""))),
  ]).sort();
  const tests = found.filter((file) => !BROWSER_TEST.test(file));
  if (tests.length === 0) {
    return { run: false, reason: found.length > 0 ? "browser-only" : "no-checks" };
  }
  return { run: true, commit, tests, ...sample(code, commit) };
}

function judgeStrength({ plan, testsPassed, reports = [], outOfTime }) {
  const empty = { tried: 0, missed: 0, missedLines: 0, uncovered: 0, examples: [] };
  const sampled = plan.run ? { measured: plan.measured, total: plan.total } : {};
  const notMeasured = (reason, extra = {}) => ({
    result: "not measured",
    reason,
    ...empty,
    ...sampled,
    ...extra,
  });
  if (!plan.run) {
    return notMeasured(plan.reason, plan.note === undefined ? {} : { note: plan.note });
  }
  if (testsPassed !== true) return notMeasured("tests-failed");
  if (outOfTime) {
    return notMeasured("out-of-time", {
      outOfTime: { tried: count(outOfTime.tried), total: count(outOfTime.total) },
    });
  }

  const wanted = new Map(plan.code.map((entry) => [entry.file, new Set(entry.lines)]));
  const breaks = new Map();
  const ranLines = new Set();
  for (const report of reports) {
    for (const [file, entry] of Object.entries(report?.files ?? {})) {
      const lines = wanted.get(file);
      if (!lines) continue;
      for (const mutant of Array.isArray(entry?.mutants) ? entry.mutants : []) {
        const kind = mutant?.mutatorName;
        const status = mutant?.status;
        const start = mutant?.location?.start;
        if (typeof kind !== "string" || !Object.hasOwn(BREAK_WORDING, kind)) continue;
        if (!NOTICED.has(status) && !MISSED.has(status)) continue;
        if (!lines.has(start?.line)) continue;
        const key = JSON.stringify([file, start.line, start.column, kind, mutant.replacement]);
        const found = breaks.get(key) ?? {
          file,
          line: start.line,
          column: count(start.column),
          kind,
          noticed: false,
          ran: false,
        };
        found.noticed ||= NOTICED.has(status);
        found.ran ||= status !== "NoCoverage";
        if (found.ran) ranLines.add(`${file}:${start.line}`);
        breaks.set(key, found);
      }
    }
  }
  const all = [...breaks.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  if (all.length === 0) return notMeasured("no-breaks");
  const missed = all.filter((entry) => !entry.noticed);
  const missedLines = unique(missed.map((entry) => `${entry.file}:${entry.line}`));
  const spread = (list) => {
    const seen = new Set();
    const first = list.filter((entry) => {
      const place = `${entry.file}:${entry.line}`;
      if (seen.has(place)) return false;
      seen.add(place);
      return true;
    });
    return [...first, ...list.filter((entry) => !first.includes(entry))];
  };
  const examples = [
    ...spread(missed.filter((entry) => entry.ran)),
    ...spread(missed.filter((entry) => !entry.ran)),
  ]
    .slice(0, 3)
    .map(({ file, line, kind, ran }) => ({ file, line, kind, ran }));
  return {
    result: missed.length > 0 ? "weak" : "strong",
    tried: all.length,
    missed: missed.length,
    missedLines: missedLines.length,
    uncovered: missedLines.filter((line) => !ranLines.has(line)).length,
    examples,
    ...sampled,
  };
}

function renderStrength(verdict, { required }) {
  const result = Object.hasOwn(LABELS, verdict?.result) ? verdict.result : "not measured";
  const lines = [`### Test strength: ${result}`, ""];
  const tried = count(verdict.tried);
  const sampledNote =
    count(verdict.total) > count(verdict.measured)
      ? [
          "",
          `This pull request changed ${count(verdict.total)} code lines, so an even sample of ${count(verdict.measured)} of them was measured.`,
        ]
      : [];
  if (result === "strong") {
    lines.push(
      `We broke the changed code on purpose in ${plural(tried, "small way")}, one at a time, such as turning "at least" into "more than" or "true" into "false". The tests noticed every one.`,
      ...sampledNote,
      "",
      "Changed wording and log messages are not counted.",
    );
  } else if (result === "weak") {
    const missed = count(verdict.missed);
    const uncovered = count(verdict.uncovered);
    lines.push(
      `We broke the changed code on purpose in ${plural(tried, "small way")}, one at a time. The tests did not notice ${missed} of them, on ${plural(count(verdict.missedLines), "changed line")}. Each one is a way this code could be wrong while every test still passes.`,
    );
    if (uncovered > 0) {
      lines.push("", `${plural(uncovered, "of those line")} never ran in any test.`);
    }
    const examples = (Array.isArray(verdict.examples) ? verdict.examples : []).slice(0, 3);
    if (examples.length > 0) {
      lines.push(
        "",
        "For example:",
        ...examples.map((example) => {
          const wording = Object.hasOwn(BREAK_WORDING, example?.kind)
            ? BREAK_WORDING[example.kind]
            : "A decision in the code was changed, and every test still passed.";
          return `- \`${safePath(example?.file)}\` line ${count(example?.line)}: ${wording}`;
        }),
      );
    }
    lines.push(
      ...sampledNote,
      "",
      "About 1 in 4 of these breaks makes no real difference. Look at the examples before you decide. Changed wording and log messages are not counted.",
    );
  } else {
    const why = UNMEASURED_WHY[verdict.reason];
    lines.push(why ? why(verdict) : "The measurement could not be read.");
  }
  lines.push(
    "",
    required
      ? "The test strength switch is on: a weak result, or one not measured while tests exist, turns the lane red."
      : "This is a report only. It does not change the lane.",
  );
  return lines.join("\n");
}

function isStrengthRequired(env = process.env) {
  return env.TEST_STRENGTH_MODE === "required";
}

function strengthReasons(verdict, { required }) {
  if (!required) return [];
  if (verdict.result === "weak") {
    return [
      {
        rule: "test-strength",
        lane: "red",
        why: `The tests still pass when the changed code is broken in ${plural(count(verdict.missed), "way")}`,
        files: unique((verdict.examples ?? []).map((example) => safePath(example.file))),
      },
    ];
  }
  if (verdict.result !== "strong" && RED_WHEN_UNMEASURED.has(verdict.reason)) {
    return [
      {
        rule: "test-strength",
        lane: "red",
        why: "The test strength could not be measured",
        files: [],
      },
    ];
  }
  return [];
}

function strengthLabelChanges(currentLabels, result) {
  const wanted = LABELS[result] ?? LABELS["not measured"];
  return {
    add: currentLabels.includes(wanted) ? [] : [wanted],
    remove: currentLabels.filter((label) => label.startsWith("strength:") && label !== wanted),
  };
}

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

const globSafe = (file) => file.replace(/[*?[\]{}()!+@\\]/g, "\\$&");

function ranges(lines) {
  const runs = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

function ownerOf(cwd, test) {
  for (let dir = path.posix.dirname(test); dir !== "."; dir = path.posix.dirname(dir)) {
    const config = path.join(cwd, dir, "vite.config.ts");
    if (fs.existsSync(config) && /\btest\s*:/.test(fs.readFileSync(config, "utf8"))) return dir;
  }
  return ".";
}

function vitestConfig(cwd, owner, tests) {
  const root = path.join(cwd, owner);
  return [
    'import path from "node:path";',
    `import base from ${JSON.stringify(path.join(root, "vite.config.ts"))};`,
    `const root = ${JSON.stringify(root)};`,
    `const tests = ${JSON.stringify(tests.map((test) => path.join(cwd, test)))};`,
    'const loaded = typeof base === "function" ? await base({ command: "serve", mode: "test" }) : base;',
    "const { projects, ...test } = loaded.test ?? {};",
    "const matches = (dir, file, globs) => (globs ?? []).some((glob) => path.matchesGlob(path.relative(dir, file), glob));",
    "const narrow = (project) => {",
    '  const dir = path.resolve(root, project.test?.root ?? "");',
    "  const include = tests.filter((file) => matches(dir, file, project.test?.include) && !matches(dir, file, project.test?.exclude));",
    "  return { ...project, test: { ...project.test, include: include.map((file) => path.relative(dir, file)) } };",
    "};",
    `const inner = ${owner === "." ? "[]" : "(projects ?? [])"}`,
    '  .filter((project) => typeof project === "object" && !project.test?.browser?.enabled)',
    "  .map(narrow)",
    "  .filter((project) => project.test.include.length > 0);",
    "export default {",
    "  ...loaded,",
    "  root,",
    "  test: inner.length > 0",
    "    ? { ...test, projects: inner }",
    "    : { ...test, include: tests.map((file) => path.relative(root, file)) },",
    "};",
    "",
  ].join("\n");
}

function strykerConfig(planned, { cwd, out, name, tests }) {
  return {
    plugins: [
      pathToFileURL(require.resolve("@stryker-mutator/vitest-runner", { paths: [cwd] })).href,
    ],
    testRunner: "vitest",
    vitest: { configFile: path.join(out, `${name}.vitest.config.mjs`), related: false },
    inPlace: true,
    coverageAnalysis: "perTest",
    mutate: planned.code.flatMap((entry) =>
      ranges(entry.lines).map(([start, end]) => `${globSafe(entry.file)}:${start}-${end}`),
    ),
    mutator: { excludedMutations: NOT_COUNTED },
    ignorePatterns: [
      "/**",
      ...[...planned.code.map((entry) => entry.file), ...tests].map(
        (file) => `!/${globSafe(file)}`,
      ),
    ],
    disableTypeChecks: false,
    allowEmpty: true,
    reporters: ["json", "progress-append-only"],
    jsonReporter: { fileName: path.join(out, `${name}.report.json`) },
    tempDirName: path.join(out, `${name}.tmp`),
    cleanTempDir: true,
    fileLogLevel: "off",
  };
}

function trimReport(report, planned) {
  const wanted = new Set(planned.code.map((entry) => entry.file));
  const tried = Object.values(report?.files ?? {})
    .flatMap((entry) => entry.mutants ?? [])
    .filter((mutant) => mutant.status !== "Ignored");
  const ranNothing = !tried.some((mutant) => Array.isArray(mutant.coveredBy));
  const files = {};
  for (const [file, entry] of Object.entries(report?.files ?? {})) {
    if (!wanted.has(file)) continue;
    files[file] = {
      language: entry.language,
      mutants: (entry.mutants ?? [])
        .filter((mutant) => mutant.status !== "Ignored")
        .map((mutant) => ({
          id: String(mutant.id),
          mutatorName: mutant.mutatorName,
          replacement: String(mutant.replacement ?? "").slice(0, 200),
          status: ranNothing && mutant.status === "Survived" ? "NoCoverage" : mutant.status,
          location: {
            start: { line: mutant.location.start.line, column: mutant.location.start.column },
            end: { line: mutant.location.end.line, column: mutant.location.end.column },
          },
        })),
    };
  }
  return { schemaVersion: String(report?.schemaVersion ?? ""), files };
}

function run(command, args, { cwd, deadline, log }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      output += chunk;
      fs.appendFileSync(log, chunk);
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => collect(`${error.message}\n`));
    let force;
    const stop = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        force = setTimeout(killGroup, 30_000);
      },
      Math.max(0, deadline - Date.now()),
    );
    child.on("close", (code) => {
      clearTimeout(stop);
      clearTimeout(force);
      killGroup();
      resolve({ code, output, timedOut });
    });
  });
}

function testsPassed(file, tests, cwd) {
  if (!fs.existsSync(file)) return false;
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const results = new Map(
    report.testResults.map((result) => [
      path.relative(cwd, result.name).split(path.sep).join("/"),
      result,
    ]),
  );
  return (
    report.success === true &&
    tests.every((test) => {
      const result = results.get(test);
      return result && result.assertionResults.length > 0 && result.status === "passed";
    })
  );
}

function restore(cwd, before, planned) {
  const status = () => git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status() === before) return true;
  const dirty = new Set(before.split("\n").map((line) => line.slice(3)));
  const code = planned.code.map((entry) => entry.file).filter((file) => !dirty.has(file));
  if (code.length > 0) git(cwd, ["checkout", "--", ...code]);
  for (const name of fs.readdirSync(cwd)) {
    if (/^stryker-setup-\d+\.js$/.test(name) && !dirty.has(name)) fs.rmSync(path.join(cwd, name));
  }
  return status() === before;
}

function planMeasurement(cwd, { first, base, head }) {
  return planStrength({
    firstMessage: git(cwd, ["log", "-1", "--format=%B", first]),
    commit: head,
    files: parseGitDiff(
      git(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", `${base}...${head}`]),
    ),
    repoFiles: git(cwd, ["ls-tree", "-r", "--name-only", head]).split("\n").filter(Boolean),
  });
}

async function measure({ cwd, first, base, head, out, minutes = MINUTES }) {
  const deadline = Date.now() + minutes * 60_000;
  fs.mkdirSync(out, { recursive: true });
  const log = path.join(out, "run.log");
  const planned = planMeasurement(cwd, { first, base, head });
  const measurement = { version: 1, head, tests: planned.run ? planned.tests : [] };
  const finish = (extra) => {
    const done = { ...measurement, ...extra };
    fs.writeFileSync(path.join(out, "measurement.json"), `${JSON.stringify(done)}\n`);
    return { planned, measurement: done };
  };
  if (!planned.run) return finish({});

  const before = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (planned.tests.some((test) => test.startsWith("apps/desktop/"))) {
    await run("vp", ["run", "--filter", "@t3tools/desktop", "ensure:electron"], {
      cwd,
      deadline,
      log,
    });
  }
  const testsFile = path.join(out, "tests.json");
  const tested = await run(
    "vp",
    ["test", "run", "--reporter=json", `--outputFile=${testsFile}`, ...planned.tests],
    { cwd, deadline, log },
  );
  if (tested.timedOut) return finish({ testsPassed: true, outOfTime: { tried: 0, total: 0 } });
  if (!testsPassed(testsFile, planned.tests, cwd)) return finish({ testsPassed: false });

  const groups = new Map();
  for (const test of planned.tests) {
    const owner = ownerOf(cwd, test);
    groups.set(owner, [...(groups.get(owner) ?? []), test]);
  }
  const stryker = path.join(
    path.dirname(require.resolve("@stryker-mutator/core/package.json", { paths: [cwd] })),
    "bin/stryker.js",
  );
  const reports = [];
  const done = { tried: 0, total: 0 };
  let clean = true;
  let started = 0;
  for (const [owner, tests] of groups) {
    const name = `run-${started++}`;
    fs.writeFileSync(path.join(out, `${name}.vitest.config.mjs`), vitestConfig(cwd, owner, tests));
    const configFile = path.join(out, `${name}.stryker.json`);
    fs.writeFileSync(
      configFile,
      `${JSON.stringify(strykerConfig(planned, { cwd, out, name, tests }), null, 2)}\n`,
    );
    const mutated = await run(process.execPath, [stryker, "run", configFile], {
      cwd,
      deadline,
      log,
    });
    clean = restore(cwd, before, planned) && clean;
    const progress = [...mutated.output.matchAll(/(\d+)\/(\d+) tested/g)].at(-1);
    const each = Number(progress?.[2] ?? /with (\d+) mutant/.exec(mutated.output)?.[1] ?? 0);
    if (mutated.timedOut) {
      return finish({
        testsPassed: true,
        clean,
        outOfTime: {
          tried: done.tried + Number(progress?.[1] ?? 0),
          total: done.total + each * (groups.size - started + 1),
        },
      });
    }
    if (mutated.code !== 0) console.error(mutated.output.split("\n").slice(-40).join("\n"));
    done.tried += each;
    done.total += each;
    const reportFile = path.join(out, `${name}.report.json`);
    if (fs.existsSync(reportFile)) {
      reports.push(trimReport(JSON.parse(fs.readFileSync(reportFile, "utf8")), planned));
    }
  }
  return finish({ testsPassed: true, clean, reports });
}

function verdictOf(planned, measurement) {
  return judgeStrength({
    plan: planned,
    testsPassed: measurement.testsPassed,
    reports: measurement.reports,
    outOfTime: measurement.outOfTime,
  });
}

function writeSummary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  if (
    command === "measure" &&
    flag("--first") &&
    flag("--base") &&
    flag("--head") &&
    flag("--out")
  ) {
    const cwd = flag("--cwd") ?? process.cwd();
    const { planned, measurement } = await measure({
      cwd,
      first: flag("--first"),
      base: flag("--base"),
      head: flag("--head"),
      out: path.resolve(flag("--out")),
      minutes: flag("--minutes") ? Number(flag("--minutes")) : MINUTES,
    });
    writeSummary(
      renderStrength(verdictOf(planned, measurement), { required: isStrengthRequired() }),
    );
    if (measurement.clean === false) {
      console.error("The run left files in the repository changed.");
      process.exit(1);
    }
    return;
  }
  console.error(
    [
      "Usage:",
      "  node .github/scripts/test-strength.cjs measure --first <sha> --base <sha> --head <sha> --out <dir> [--cwd <repo>] [--minutes 5]",
      "",
      "measure plans the breaks from the diff between where the head left the base branch and the head, runs the chosen tests, runs Stryker on the changed lines, and writes measurement.json to the out directory.",
    ].join("\n"),
  );
  process.exit(2);
}

module.exports = {
  BREAK_WORDING,
  LABELS,
  planStrength,
  planMeasurement,
  judgeStrength,
  renderStrength,
  isStrengthRequired,
  strengthReasons,
  strengthLabelChanges,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
