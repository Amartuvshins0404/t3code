const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { TEST_FILE, checksMarker, parseGitDiff, testNames } = require("./merge-lane.cjs");

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function plan(cwd, commit) {
  const marker = checksMarker(git(cwd, ["log", "-1", "--format=%B", commit]));
  if (!marker) {
    return { run: false, note: "No checks commit came first, so there is nothing to prove." };
  }
  if (marker.kind === "none") {
    return {
      run: false,
      note: `The first commit says no test is needed: ${marker.reason || "(no reason given)"}.`,
    };
  }
  const parent = /^parent ([0-9a-f]{40})$/m.exec(git(cwd, ["cat-file", "-p", commit]))?.[1];
  const diff = git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-M",
    "-U3",
    parent ?? EMPTY_TREE,
    commit,
  ]);
  const files = parseGitDiff(diff)
    .filter((file) => file.status !== "removed" && TEST_FILE.test(file.filename))
    .map((file) => ({
      file: file.filename,
      added: file.status === "added",
      tests: testNames(file.patch),
    }));
  if (files.length === 0) {
    return { run: false, note: "The checks commit has no test file to run." };
  }
  return { run: true, commit, files };
}

function namePattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\$[\w.]+|%[sdifjoc#%]/g, ".+")}$`);
}

function readReport(file, cwd) {
  if (!fs.existsSync(file)) return new Map();
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Map(
    report.testResults.map((result) => [
      path.relative(cwd, result.name).split(path.sep).join("/"),
      result,
    ]),
  );
}

const firstLine = (text) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "no error message";

const listed = (tests) => tests.map((test) => `"${test.title}"`).join(", ");

function judgeFile(entry, before, after) {
  const problems = [];
  let without;
  if (!before) {
    without = "did not run";
    problems.push("It did not run without the code.");
  } else if (before.assertionResults.length === 0) {
    without = `could not load: ${firstLine(before.message)}`;
    if (after && after.assertionResults.length === 0) {
      problems.push("It cannot load with the code either, so the test setup is broken.");
    }
  } else {
    const all = before.assertionResults;
    const matched = entry.added
      ? all
      : all.filter((test) => entry.tests.some((name) => namePattern(name).test(test.title)));
    if (matched.length > 0) {
      const held = matched.filter((test) => test.status !== "failed");
      without = `${matched.length - held.length} of ${matched.length} new tests failed`;
      if (held.length > 0) {
        problems.push(`These new tests did not fail without the code: ${listed(held)}.`);
      }
    } else {
      const failed = all.filter((test) => test.status === "failed");
      without = `the new tests could not be told apart by name; ${failed.length} of ${all.length} tests failed`;
      if (failed.length === 0) problems.push("No test in it failed without the code.");
    }
  }

  let withCode;
  if (!after) {
    withCode = "did not run";
    problems.push("It did not run with the code.");
  } else if (after.assertionResults.length === 0) {
    withCode = `could not load: ${firstLine(after.message)}`;
    if (before && before.assertionResults.length > 0) {
      problems.push("It loads without the code but not with it.");
    } else if (!problems.some((problem) => problem.includes("setup is broken"))) {
      problems.push("It cannot load with the code.");
    }
  } else {
    const notPassed = after.assertionResults.filter((test) => test.status !== "passed");
    withCode = `${after.assertionResults.length - notPassed.length} of ${after.assertionResults.length} passed`;
    if (notPassed.length > 0) {
      problems.push(`These tests did not pass with the code: ${listed(notPassed)}.`);
    }
  }
  return { file: entry.file, without, withCode, problems };
}

function judge(planned, before, after) {
  const rows = planned.files.map((entry) =>
    judgeFile(entry, before.get(entry.file), after.get(entry.file)),
  );
  return { ok: rows.every((row) => row.problems.length === 0), rows };
}

function render(planned, verdict, required) {
  const lines = [
    `### Blind checks: ${verdict.ok ? "proven" : "not proven"}`,
    "",
    `The checks commit \`${planned.commit.slice(0, 10)}\` was run without the code, then with it. Every new test has to fail without the code and pass with it.`,
    "",
    "| Test file | Without the code | With the code |",
    "| --- | --- | --- |",
    ...verdict.rows.map((row) => `| \`${row.file}\` | ${row.without} | ${row.withCode} |`),
  ];
  const problems = verdict.rows.flatMap((row) =>
    row.problems.map((problem) => `- \`${row.file}\`: ${problem}`),
  );
  if (problems.length > 0) lines.push("", "What is wrong:", ...problems);
  lines.push(
    "",
    "A file that cannot load without the code counts as failing only when it loads and passes with the code.",
    "",
    verdict.ok || !required
      ? "This check is a report only while BLIND_CHECKS_MODE is not `required`."
      : "BLIND_CHECKS_MODE is `required`, so this check fails.",
  );
  return lines.join("\n");
}

function writeSummary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const cwd = flag("--cwd") ?? process.cwd();
  const dir = flag("--dir");
  if (command === "plan" && flag("--commit") && dir) {
    const planned = plan(cwd, flag("--commit"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), `${JSON.stringify(planned, null, 2)}\n`);
    if (planned.run) {
      fs.writeFileSync(
        path.join(dir, "files.txt"),
        `${planned.files.map((entry) => entry.file).join("\n")}\n`,
      );
    } else {
      writeSummary(`### Blind checks: skipped\n\n${planned.note}`);
    }
    const outputs = [
      `run=${planned.run}`,
      `browser=${planned.run && planned.files.some((entry) => entry.file.includes(".browser.test."))}`,
      `desktop=${planned.run && planned.files.some((entry) => entry.file.startsWith("apps/desktop/"))}`,
      `checks=${planned.run ? planned.commit : ""}`,
    ];
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
    else console.log(outputs.join("\n"));
    return;
  }
  if (command === "judge" && dir) {
    const planned = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    const verdict = judge(
      planned,
      readReport(path.join(dir, "before.json"), cwd),
      readReport(path.join(dir, "after.json"), cwd),
    );
    const required = process.env.BLIND_CHECKS_MODE === "required";
    writeSummary(render(planned, verdict, required));
    if (!verdict.ok && required) process.exit(1);
    return;
  }
  console.error(
    [
      "Usage:",
      "  node .github/scripts/blind-checks.cjs plan --commit <sha> --dir <dir> [--cwd <repo>]",
      "  node .github/scripts/blind-checks.cjs judge --dir <dir> [--cwd <repo>]",
      "",
      "plan reads the first commit of a pull request and lists the test files its checks added or changed.",
      "judge reads before.json and after.json, the vitest JSON reports of those files without and with the code.",
    ].join("\n"),
  );
  process.exit(2);
}

module.exports = { plan, judge, namePattern };

if (require.main === module) main();
