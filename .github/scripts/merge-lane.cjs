const { execFileSync } = require("node:child_process");

const { readWorkspace } = require("./ci-changes.cjs");
const { countTestDelta } = require("./test-delta.cjs");

const LANES = ["green", "amber", "red"];

const LANE_MEANING = {
  green: "merge unseen",
  amber: "merge unseen, watched",
  red: "always the owner's call",
};

const LANE_ICON = { green: "🟢", amber: "🟠", red: "🔴" };

const PATH_RULES = [
  {
    id: "deploy",
    lane: "red",
    why: "Deploys live infrastructure when merged",
    paths: [/^infra\/(auth|relay|deploy)\//, /^\.github\/workflows\/deploy-[^/]+\.ya?ml$/],
  },
  {
    id: "lane-rules",
    lane: "red",
    why: "Changes the lane rules or the merge ledger",
    paths: [
      /^\.github\/scripts\/merge-(lane|ledger)/,
      /^\.github\/workflows\/merge-lane\.ya?ml$/,
      /^scripts\/merge-(lane|ledger)/,
    ],
  },
  {
    id: "ci-release",
    lane: "red",
    why: "Changes CI, releases, signing or publishing",
    paths: [
      /^\.github\//,
      /^packaging\//,
      /^scripts\/(build-|release-|sign-|smoke-|notify-discord-release|resolve-(nightly|previous)-release|update-release-package-versions|merge-update-manifests|generate-release-notes|verify-windows-desktop-artifact|linux-after-pack|prepare-server-compile-cache|apply-web-brand-assets|install\.(sh|ps1)|npm-launcher\/|lib\/)/,
      /^apps\/mobile\/(eas\.json|app\.config\.ts|fingerprint\.config\.js|plugins\/)/,
      /(^|\/)vercel\.(ts|json)$/,
    ],
  },
  {
    id: "build-config",
    lane: "red",
    why: "Changes build or workspace configuration",
    paths: [
      /(^|\/)vite\.config\.[cm]?[jt]s$/,
      /(^|\/)tsconfig[^/]*\.json$/,
      /(^|\/)(babel|metro|astro|graphql)\.config\.[cm]?[jt]s$/,
      /^pnpm-workspace\.yaml$/,
      /^\.pnpmfile\.cjs$/,
      /^(t3|\.task-cache)\.json$/,
      /^\.vite-hooks\//,
      /^\.(gitattributes|gitignore|vercelignore|env\.example)$/,
      /^\.(vscode|devcontainer)\//,
      /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.podspec|Podfile|CMakeLists\.txt|Package\.swift)$/,
    ],
  },
  {
    id: "gates",
    lane: "red",
    why: "Changes a lint, type-check, knip or test gate",
    paths: [
      /^oxlint-plugin-t3code\//,
      /^knip\.jsonc$/,
      /^scripts\/(knip-schemas|check-changed|check-changed-command|test-cached|mobile-native-static-check|e2e\.config)\.ts$/,
      /(^|\/)vitest\.[^/]*config\.[cm]?[jt]s$/,
      /^\.coderabbit\.config\.ts$/,
      /^apps\/mobile\/(detekt\.yml|\.swiftlint\.yml|\.editorconfig)$/,
      /^apps\/web\/test\//,
      /^packages\/shared\/src\/(HostProcess\.ts$|testing\/)/,
      /^apps\/server\/src\/testUtils\//,
      /^evals\//,
    ],
  },
  {
    id: "migrations",
    lane: "red",
    why: "Changes the database schema or its migrations",
    paths: [
      /^apps\/server\/src\/persistence\/(Migrations|databaseMigrationHead|initializeV2Database|reconcileV2PreviewMigration)/,
      /(^|\/)migrations\//,
      /\.sql$/,
    ],
  },
  {
    id: "contracts",
    lane: "red",
    why: "Changes the wire contracts every client and the server share",
    paths: [/^packages\/contracts\//, /^apps\/server\/schema\//],
  },
  {
    id: "auth",
    lane: "red",
    why: "Changes sign-in, permissions or access control",
    paths: [
      /^infra\/auth\//,
      /^apps\/server\/src\/(auth|policy)\//,
      /^apps\/web\/src\/components\/(auth|clerk)\//,
      /^packages\/client-runtime\/src\/(authorization|cloudAuth)\//,
      /^(apps|packages)\/.*\/[^/]*(auth(?!or)|clerk|dpop|pairing|passkey|oauth|credential|secretstore|tokenstore|tokenmanager|tokenbroker|signin|sign-in|permission|access(?!ib))[^/]*$/i,
    ],
  },
  {
    id: "defaults",
    lane: "red",
    why: "Changes product defaults or settings",
    paths: [
      /^apps\/server\/src\/serverSettings\.ts$/,
      /^apps\/desktop\/src\/settings\//,
      /^packages\/client-runtime\/src\/state\/sharedSettings\.ts$/,
      /^packages\/provider-[^/]+\/src\/settings\.ts$/,
      /^apps\/web\/src\/(browser\/browserDefaults|lib\/t3ProjectFileDefaults|hooks\/useSettings)\.ts$/,
    ],
  },
  {
    id: "model-text",
    lane: "red",
    why: "Changes text that AI models read (agent instructions, MCP tools, prompts)",
    paths: [
      /(^|\/)(AGENTS|CLAUDE)\.md$/,
      /^\.(agents|claude|cursor|macroscope)\//,
      /^apps\/server\/src\/provider\/(agentContextBudget\.json|CodexDeveloperInstructions\.ts)$/,
      /^apps\/server\/src\/mcp\/(toolkits\/.*tools\.ts|advertisedJsonSchema\.ts|McpToolExposure\.ts|delegatedTaskModes\.ts)$/,
      /^apps\/server\/src\/textGeneration\//,
      /^packages\/provider-core\/src\/server\/(orchestrationInstructions|textGenerationPrompts)\.ts$/,
      /^packages\/provider-pi\/src\/server\/mcpExtensionSource\.ts$/,
      /^docs\/internals\/testing\.md$/,
    ],
  },
  {
    id: "dependencies",
    lane: "red",
    why: "Changes dependencies, package manifests or vendored code",
    paths: [
      /(^|\/)package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^patches\//,
      /^apps\/mobile\/deps\//,
      /^\.repos\//,
      /(^|\/)Cargo\.(toml|lock)$/,
      /^apps\/mobile\/Brewfile$/,
      /^third-party-licenses/,
    ],
  },
  {
    id: "app-code",
    lane: "amber",
    why: "Ordinary app or package code",
    inPackage: true,
    except: [/\.mdx?$/],
    paths: [/^native\//, /^assets\//],
  },
  {
    id: "docs",
    lane: "green",
    why: "Documentation only",
    paths: [/^docs\//, /\.mdx?$/, /^LICENSE$/],
  },
];

const UNKNOWN_RULE = {
  id: "unknown-path",
  lane: "red",
  why: "Touches a path no lane rule recognizes",
};

const CONTENT_RULES = {
  suppression: {
    lane: "red",
    why: "Adds a comment that silences lint, type or Effect checks",
    added:
      /\b(?:oxlint|eslint)-disable|@ts-(?:ignore|expect-error|nocheck)|biome-ignore|@effect-diagnostics/,
  },
  "test-skip": {
    lane: "red",
    why: "Skips tests or runs only some of them",
    added:
      /\b(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|only|todo|fails|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe)\s*\(/,
  },
  "deleted-test": { lane: "red", why: "Deletes a test file" },
  "fewer-tests": { lane: "red", why: "Leaves fewer test cases than before" },
  "unreadable-diff": {
    lane: "red",
    why: "The diff was too large to read, so a loosened check cannot be ruled out",
  },
  "incomplete-file-list": {
    lane: "red",
    why: "GitHub listed only part of the changed files",
  },
  "no-files": { lane: "red", why: "No changed files to judge" },
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PROSE = /\.(?:mdx?|txt)$/;
const BINARY =
  /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|ttf|otf|woff2?|eot|mp[34]|mov|webm|wav|ogg|m4a|pdf|zip|t?gz|tar|jar|keystore|p12|node|wasm|dylib|so|dll|exe|car|riv|lottie)$/i;

function laneRank(lane) {
  return LANES.indexOf(lane);
}

function higher(a, b) {
  return laneRank(a) >= laneRank(b) ? a : b;
}

function inPackageDir(file, packageDirs) {
  return packageDirs.some((dir) => file.startsWith(`${dir}/`));
}

function pathRulesFor(file, packageDirs) {
  return PATH_RULES.filter((rule) => {
    if (rule.except?.some((pattern) => pattern.test(file))) return false;
    if (rule.inPackage && inPackageDir(file, packageDirs)) return true;
    return rule.paths.some((pattern) => pattern.test(file));
  });
}

function addedLines(patch) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function testCaseDelta(file) {
  const before = file.previous_filename ?? file.filename;
  const diff = [
    `diff --git a/${before} b/${file.filename}`,
    `--- ${file.status === "added" ? "/dev/null" : `a/${before}`}`,
    `+++ ${file.status === "removed" ? "/dev/null" : `b/${file.filename}`}`,
    file.patch,
  ].join("\n");
  return countTestDelta(diff).net;
}

function classify(files, { packageDirs = [], fileListComplete = true } = {}) {
  const hits = new Map();
  const hit = (rule, id, file) => {
    const entry = hits.get(id) ?? { rule: id, lane: rule.lane, why: rule.why, files: [] };
    if (file && !entry.files.includes(file)) entry.files.push(file);
    hits.set(id, entry);
  };

  if (files.length === 0) hit(CONTENT_RULES["no-files"], "no-files");
  if (!fileListComplete) hit(CONTENT_RULES["incomplete-file-list"], "incomplete-file-list");

  let testNet = 0;
  const shrunkTests = [];
  for (const file of files) {
    const name = file.filename;
    const rules = pathRulesFor(name, packageDirs);
    if (rules.length === 0) hit(UNKNOWN_RULE, UNKNOWN_RULE.id, name);
    for (const rule of rules) hit(rule, rule.id, name);

    const wasTest = TEST_FILE.test(file.previous_filename ?? name);
    if (wasTest && (file.status === "removed" || !TEST_FILE.test(name))) {
      hit(CONTENT_RULES["deleted-test"], "deleted-test", file.previous_filename ?? name);
    }

    const hasPatch = typeof file.patch === "string";
    if (!hasPatch) {
      const empty = file.changes === 0;
      if (!empty && !file.binary && !BINARY.test(name)) {
        hit(CONTENT_RULES["unreadable-diff"], "unreadable-diff", name);
      }
      continue;
    }
    if (PROSE.test(name)) continue;

    const added = addedLines(file.patch);
    for (const id of ["suppression", "test-skip"]) {
      if (added.some((line) => CONTENT_RULES[id].added.test(line)))
        hit(CONTENT_RULES[id], id, name);
    }
    if (TEST_FILE.test(name) || wasTest) {
      const delta = testCaseDelta(file);
      testNet += delta;
      if (delta < 0) shrunkTests.push(name);
    }
  }
  if (testNet < 0) {
    for (const name of shrunkTests) hit(CONTENT_RULES["fewer-tests"], "fewer-tests", name);
  }

  const order = [
    ...PATH_RULES.map((rule) => rule.id),
    UNKNOWN_RULE.id,
    ...Object.keys(CONTENT_RULES),
  ];
  const reasons = [...hits.values()].sort(
    (a, b) => laneRank(b.lane) - laneRank(a.lane) || order.indexOf(a.rule) - order.indexOf(b.rule),
  );
  const lane = reasons.reduce((current, reason) => higher(current, reason.lane), "green");
  return { lane, reasons };
}

function summarize(result, { maxFiles = 5 } = {}) {
  const lines = [
    `### Lane: ${LANE_ICON[result.lane]} ${result.lane} (${LANE_MEANING[result.lane]})`,
    "",
  ];
  const deciding = result.reasons.filter((reason) => reason.lane === result.lane);
  const others = result.reasons.filter((reason) => reason.lane !== result.lane);
  const describe = (reason) => {
    const shown = reason.files.slice(0, maxFiles).map((file) => `\`${file}\``);
    const more = reason.files.length - shown.length;
    const files =
      shown.length > 0 ? `: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
    return `- **${reason.why}**${files}`;
  };
  lines.push("Why:", ...deciding.map(describe));
  if (others.length > 0) lines.push("", "Also in this change:", ...others.map(describe));
  lines.push(
    "",
    "This lane is a report only. Nothing was merged, blocked or closed. The rules come from the base branch, so this pull request cannot change its own lane.",
  );
  return lines.join("\n");
}

function parseGitDiff(text) {
  const files = [];
  let file = null;
  let inHunks = false;
  const strip = (value, prefix) => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice(11);
      const middle = rest.indexOf(" b/", Math.floor((rest.length - 3) / 2) - 1);
      const name = middle === -1 ? strip(rest, "a/") : rest.slice(middle + 3);
      file = { filename: name, status: "modified", patch: "", additions: 0, deletions: 0 };
      files.push(file);
      inHunks = false;
      continue;
    }
    if (!file) continue;
    if (!inHunks) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "removed";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.previous_filename = line.slice(12);
      } else if (line.startsWith("rename to ")) file.filename = line.slice(10);
      else if (line.startsWith("--- ") && line !== "--- /dev/null") {
        const before = strip(line.slice(4), "a/");
        if (before !== file.filename) file.previous_filename = before;
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null")
        file.filename = strip(line.slice(4), "b/");
      else if (line.startsWith("Binary files ")) {
        file.binary = true;
        file.patch = null;
      } else if (line.startsWith("@@")) inHunks = true;
      if (!inHunks) continue;
    }
    file.patch += `${file.patch ? "\n" : ""}${line}`;
    if (line.startsWith("+")) file.additions += 1;
    else if (line.startsWith("-")) file.deletions += 1;
  }
  for (const entry of files) {
    if (entry.status === "removed" && entry.previous_filename) {
      entry.filename = entry.previous_filename;
      delete entry.previous_filename;
    }
    if (entry.status === "modified" && entry.previous_filename) delete entry.previous_filename;
    if (entry.patch !== null) entry.changes = entry.additions + entry.deletions;
  }
  return files;
}

function git(cwd, args, options = {}) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
}

function gitFiles({ cwd = process.cwd(), range, worktree = false }) {
  const diffArgs = ["--no-color", "--no-ext-diff", "-M", "-U3"];
  if (!worktree) {
    const args = range.includes("..")
      ? ["diff", ...diffArgs, range]
      : ["show", "--format=", "--diff-merges=first-parent", ...diffArgs, range];
    return parseGitDiff(git(cwd, args));
  }
  const files = parseGitDiff(git(cwd, ["diff", ...diffArgs, range]));
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const name of untracked) {
    let text = "";
    try {
      text = git(cwd, ["diff", "--no-index", ...diffArgs, "--", "/dev/null", name]);
    } catch (error) {
      text = String(error.stdout ?? "");
    }
    for (const file of parseGitDiff(text)) files.push({ ...file, filename: name, status: "added" });
  }
  return files;
}

function classifyPullRequestFiles(listed, changedFiles) {
  const files = listed.map((file) => ({
    filename: file.filename,
    status: file.status,
    previous_filename: file.previous_filename,
    patch: file.patch,
    changes: file.changes,
  }));
  return classify(files, {
    packageDirs: readWorkspace().map((pkg) => pkg.dir),
    fileListComplete: listed.length >= changedFiles,
  });
}

function ghJson(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
}

function fetchPullRequestFiles(repo, number) {
  const pr = JSON.parse(ghJson(["api", `repos/${repo}/pulls/${number}`]));
  const listed = ghJson([
    "api",
    "--paginate",
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    "--jq",
    ".[]",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { listed, changedFiles: pr.changed_files };
}

async function syncPullRequest({ github, context, core }) {
  const pr = context.payload.pull_request;
  const { owner, repo } = context.repo;
  const listed = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const result = classifyPullRequestFiles(listed, pr.changed_files);
  const wanted = `lane:${result.lane}`;

  const current = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  for (const label of current) {
    if (!label.name.startsWith("lane:") || label.name === wanted) continue;
    try {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: pr.number,
        name: label.name,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (!current.some((label) => label.name === wanted)) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [wanted] });
  }

  core.info(
    `PR #${pr.number}: ${wanted} (${result.reasons.map((reason) => reason.rule).join(", ")})`,
  );
  await core.summary.addRaw(summarize(result, { maxFiles: 10 })).write();
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const cwd = flag("--cwd") ?? process.cwd();
  const worktreeBase = flag("--worktree-base");
  const pr = flag("--pr");
  const valueFlags = new Set(["--cwd", "--worktree-base", "--pr", "--repo"]);
  const range =
    worktreeBase ??
    args.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1]));
  if (!range && !pr) {
    console.error(
      [
        "Usage:",
        "  node .github/scripts/merge-lane.cjs <commit | base..head> [--cwd <repo>] [--json]",
        "  node .github/scripts/merge-lane.cjs --worktree-base <ref> [--cwd <repo>] [--json]",
        "  node .github/scripts/merge-lane.cjs --pr <number> --repo <owner/name> [--json]",
        "",
        "--worktree-base judges the working tree of --cwd, untracked files included, against <ref>.",
        "--pr reads the pull request's files from the GitHub API, as the Merge Lane workflow does, and changes nothing.",
      ].join("\n"),
    );
    process.exit(2);
  }
  let result;
  if (pr) {
    const { listed, changedFiles } = fetchPullRequestFiles(flag("--repo"), pr);
    result = classifyPullRequestFiles(listed, changedFiles);
  } else {
    const files = gitFiles({ cwd, range, worktree: Boolean(worktreeBase) });
    result = classify(files, { packageDirs: readWorkspace().map((pkg) => pkg.dir) });
  }
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : summarize(result));
}

module.exports = {
  LANES,
  LANE_MEANING,
  PATH_RULES,
  CONTENT_RULES,
  TEST_FILE,
  classify,
  summarize,
  parseGitDiff,
  gitFiles,
  syncPullRequest,
};

if (require.main === module) main();
