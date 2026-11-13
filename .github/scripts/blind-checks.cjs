const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { TEST_FILE, checksMarker, gitFiles, isTestSupport } = require("./merge-lane.cjs");

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function planProof({ commits, base, onBase, changed }) {
  const marker = commits[0] ? checksMarker(commits[0].message) : null;
  if (!marker) {
    return { run: false, note: "No checks commit came first, so there is nothing to prove." };
  }
  const touched = new Map();
  const support = new Set();
  for (const commit of commits) {
    const checks = checksMarker(commit.message);
    for (const file of commit.files) {
      const from = file.previous_filename ?? file.filename;
      support.delete(from);
      if (file.status !== "removed" && isTestSupport(file.filename)) support.add(file.filename);
      const names = touched.get(from);
      if (!checks && !names) continue;
      if (file.status === "removed") {
        if (checks) touched.delete(from);
        continue;
      }
      touched.delete(from);
      touched.set(file.filename, [...(names ?? [from]), file.filename]);
    }
  }
  const files = [...touched]
    .filter(([file]) => TEST_FILE.test(file) && changed(file))
    .map(([file, names]) => ({ file, baseFile: names.findLast(onBase) ?? null }));
  if (files.length === 0) {
    return {
      run: false,
      note:
        marker.kind === "none"
          ? `The first commit says no test is needed: ${marker.reason || "(no reason given)"}.`
          : "The checks commit has no changed test file to run.",
    };
  }
  for (const entry of files) support.delete(entry.file);
  return { run: true, base, files, support: [...support] };
}

function pullRequestCommits(cwd, base, head) {
  return git(cwd, ["rev-list", "--reverse", "--topo-order", `${base}..${head}`])
    .split("\n")
    .filter(Boolean)
    .map((sha) => ({
      sha,
      message: git(cwd, ["log", "-1", "--format=%B", sha]),
      files: gitFiles({ cwd, range: sha }),
    }));
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

const nameKey = (test) => JSON.stringify([...(test.ancestorTitles ?? []), test.title]);

const countNames = (tests) => {
  const counts = new Map();
  for (const test of tests) counts.set(nameKey(test), (counts.get(nameKey(test)) ?? 0) + 1);
  return counts;
};

const listed = (keys) => keys.map((key) => `"${JSON.parse(key).join(" > ")}"`).join(", ");

function judgeFile(entry, baseline, before, after) {
  const problems = [];
  let oldTests = [];
  let oldNote = "";
  if (entry.baseFile !== null) {
    if (!baseline) {
      problems.push("Its old tests did not run, so its new tests cannot be told from them.");
    } else if (baseline.assertionResults.length === 0) {
      oldNote = `; the old run could not load (${firstLine(baseline.message)}), so every test counts as new`;
    } else {
      oldTests = baseline.assertionResults.filter(
        (test) => test.status === "passed" || test.status === "failed",
      );
    }
  }

  const unloaded =
    before?.assertionResults.length === 0 &&
    !firstLine(before.message).startsWith("No test suite found");
  let without;
  if (!before) {
    without = "did not run";
    problems.push("It did not run without the code.");
  } else if (unloaded) {
    without = `could not load: ${firstLine(before.message)}${oldNote}`;
    if (after && after.assertionResults.length === 0) {
      problems.push("It cannot load with the code either, so the test setup is broken.");
    }
  } else {
    const old = countNames(oldTests);
    const failed = countNames(before.assertionResults.filter((test) => test.status === "failed"));
    const held = [];
    let fresh = 0;
    let failedFresh = 0;
    for (const [name, count] of countNames(after?.assertionResults ?? [])) {
      const added = count - (old.get(name) ?? 0);
      if (added <= 0) continue;
      fresh += added;
      failedFresh += Math.min(added, failed.get(name) ?? 0);
      if ((failed.get(name) ?? 0) < added) held.push(name);
    }
    without = `${failedFresh} of ${fresh} new tests failed${oldNote}`;
    if (held.length > 0) {
      problems.push(`These new tests did not fail without the code: ${listed(held)}.`);
    }
    const kept = countNames(after?.assertionResults ?? []);
    const gone = [...countNames(before.assertionResults)]
      .filter(([name, count]) => count > (kept.get(name) ?? 0))
      .map(([name]) => name);
    if (gone.length > 0) {
      problems.push(`These tests ran without the code but are gone with it: ${listed(gone)}.`);
    }
    const oldFailed = countNames(oldTests.filter((test) => test.status === "failed"));
    if (![...failed].some(([name, count]) => count > (oldFailed.get(name) ?? 0))) {
      problems.push("Nothing in it failed without the code.");
    }
  }

  let withCode;
  if (!after) {
    withCode = "did not run";
    problems.push("It did not run with the code.");
  } else if (after.assertionResults.length === 0) {
    withCode = `could not load: ${firstLine(after.message)}`;
    if (before && !unloaded) {
      problems.push("It loads without the code but not with it.");
    } else if (!problems.some((problem) => problem.includes("setup is broken"))) {
      problems.push("It cannot load with the code.");
    }
  } else {
    const notPassed = after.assertionResults.filter((test) => test.status !== "passed");
    withCode = `${after.assertionResults.length - notPassed.length} of ${after.assertionResults.length} passed`;
    if (notPassed.length > 0) {
      problems.push(
        `These tests did not pass with the code: ${listed([...new Set(notPassed.map(nameKey))])}.`,
      );
    }
  }
  return { file: entry.file, without, withCode, problems };
}

function judge(planned, { baseline, before, after }) {
  const rows = planned.files.map((entry) =>
    judgeFile(
      entry,
      entry.baseFile === null ? undefined : baseline.get(entry.baseFile),
      before.get(entry.file),
      after.get(entry.file),
    ),
  );
  return { ok: rows.every((row) => row.problems.length === 0), rows };
}

function render(planned, verdict, required) {
  const lines = [
    `### Blind checks: ${verdict.ok ? "proven" : "not proven"}`,
    "",
    `The old checks ran on \`${planned.base.slice(0, 10)}\`, where this pull request left the base branch. Then the checks as they are at the head ran on that code, without the code, and at the head, with the code. A test is new when its name comes up more often with the code than in the old run. Every new test has to fail without the code, and every test has to pass with it.`,
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
  if (command === "plan" && flag("--base") && flag("--head") && dir) {
    const base = flag("--base");
    const head = flag("--head");
    const entryAt = (rev, file) =>
      git(cwd, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", rev, "--", file]);
    const planned = planProof({
      commits: pullRequestCommits(cwd, base, head),
      base,
      onBase: (file) =>
        git(cwd, [
          "--literal-pathspecs",
          "ls-tree",
          "-z",
          "--full-tree",
          "--name-only",
          base,
          "--",
          file,
        ])
          .split("\0")
          .includes(file),
      changed: (file) => {
        const atBase = entryAt(base, file);
        return atBase === "" || atBase !== entryAt(head, file);
      },
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.json"), `${JSON.stringify(planned, null, 2)}\n`);
    if (planned.run) {
      fs.writeFileSync(
        path.join(dir, "files.txt"),
        `${planned.files.map((entry) => entry.file).join("\n")}\n`,
      );
      fs.writeFileSync(
        path.join(dir, "base-files.txt"),
        planned.files.flatMap((entry) => (entry.baseFile ? [`${entry.baseFile}\n`] : [])).join(""),
      );
    } else {
      writeSummary(`### Blind checks: skipped\n\n${planned.note}`);
    }
    const outputs = [
      `run=${planned.run}`,
      `browser=${planned.run && planned.files.some((entry) => entry.file.includes(".browser.test."))}`,
      `desktop=${planned.run && planned.files.some((entry) => entry.file.startsWith("apps/desktop/"))}`,
    ];
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
    else console.log(outputs.join("\n"));
    return;
  }
  if (command === "judge" && dir) {
    const planned = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    const verdict = judge(planned, {
      baseline: readReport(path.join(dir, "baseline.json"), cwd),
      before: readReport(path.join(dir, "before.json"), cwd),
      after: readReport(path.join(dir, "after.json"), cwd),
    });
    const required = process.env.BLIND_CHECKS_MODE === "required";
    writeSummary(render(planned, verdict, required));
    if (!verdict.ok && required) process.exit(1);
    return;
  }
  console.error(
    [
      "Usage:",
      "  node .github/scripts/blind-checks.cjs plan --base <sha> --head <sha> --dir <dir> [--cwd <repo>]",
      "  node .github/scripts/blind-checks.cjs judge --dir <dir> [--cwd <repo>]",
      "",
      "plan reads the pull request's commits since it left the base branch, lists the test files its checks commits added or changed, and where each one was on the base.",
      "judge reads baseline.json, before.json and after.json, the vitest JSON reports of those files as they were on the base, then as they are at the head without and with the code.",
    ].join("\n"),
  );
  process.exit(2);
}

module.exports = { planProof, pullRequestCommits, judge };

if (require.main === module) main();
