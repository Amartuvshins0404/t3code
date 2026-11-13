const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readWorkspace } = require("./ci-changes.cjs");
const { countTestDelta, hideMarkers, TEST_CASE } = require("./test-delta.cjs");

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
      /^\.github\/scripts\/(merge-(lane|ledger)|blind-checks|test-strength)/,
      /^\.github\/workflows\/(merge-lane|blind-checks)\.ya?ml$/,
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

const CHECKS_RULES = {
  "checks-missing": {
    lane: "red",
    why: "Not checked blind: the first commit is not a checks commit and does not say why no test is needed",
  },
  "checks-not-tests": {
    lane: "red",
    why: "The checks commit must add or change test files and nothing else",
  },
  "checks-none-invalid": {
    lane: "red",
    why: "The first commit says no test is needed, but it is not an empty commit with a reason",
  },
  "request-missing": {
    lane: "red",
    why: "The pull request text has no ## Request section to judge the checks against",
  },
  "checks-rewritten": { lane: "red", why: "The locked checks commit was rewritten or removed" },
  "checks-revised": { lane: "red", why: "The checks were revised after they were locked" },
  "checks-touched": { lane: "red", why: "A test file changed after the checks were locked" },
  "repairs-missing": {
    lane: "red",
    why: "A fix with no Repairs: line naming the change it repairs",
  },
  "repairs-unknown": {
    lane: "red",
    why: "A Repairs: target is not a change on the base branch",
  },
  "repairs-not-older": {
    lane: "red",
    why: "A Repairs: target is not in the history this fix was built on",
  },
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_SUPPORT = [
  TEST_FILE,
  /(^|\/)(test|tests|__tests__|testkit|testing|testUtils|fixtures|__snapshots__|integration)\//,
  /\.(testkit|fixture|testFixtures)\.[cm]?[jt]sx?$/,
  /\.snap$/,
];
const FIX_TITLE = /^fix(\([^)]*\))?!?:/i;
const CHECKS_TRAILER = /^Blind-checks:[ \t]*(.*?)[ \t]*$/im;
const REPAIRS_LINE = /^[ \t]*Repairs:[ \t]*(.*?)[ \t]*$/im;
const REQUEST_SECTION = /^##[ \t]+Request[ \t]*$([\s\S]*?)(?=^##?[ \t]|$(?![\s\S]))/im;
const TEST_NAME =
  /^\s*(?:it|test)(?:\.\w+)*(?:<[^>]*>)?\s*\((?:[^"'`()]*\)\s*\()?\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const NAMELESS_TEST = "a test whose name is not on its first line";
const LOCK_MARKER = "<!-- merge-lane-lock";
const STRENGTH_MARKER = "<!-- test-strength -->";
const GITHUB_COMMENT_BYTES = 65_536;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_MEASUREMENT_BYTES = 4 * 1024 * 1024;
const STRENGTH_LABEL_LOOK = {
  "strength:strong": {
    color: "1f883d",
    description: "The tests noticed every break in the changed code",
  },
  "strength:weak": {
    color: "d1242f",
    description: "The tests missed some breaks in the changed code",
  },
  "strength:unmeasured": { color: "cfd3d7", description: "Test strength was not measured" },
};
const LANE_BOT = "github-actions[bot]";
const SCRIPT_FILE = /(?:^|\/)scripts\//;
const REQUIRED_SUPPRESSIONS = [
  { line: /^\s*\/\/ oxlint-disable-next-line t3code\/no-unreasoned-state-sync -- \S/ },
  {
    line: /^\s*\/\/ @effect-diagnostics nodeBuiltinImport:off\s*$/,
    files: [TEST_FILE, SCRIPT_FILE],
  },
];
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

function isRequiredSuppression(line, name) {
  return REQUIRED_SUPPRESSIONS.some(
    (allowed) =>
      allowed.line.test(line) &&
      (allowed.files === undefined || allowed.files.some((pattern) => pattern.test(name))),
  );
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
    const silences = (line) =>
      CONTENT_RULES.suppression.added.test(line) && !isRequiredSuppression(line, name);
    if (added.some(silences)) hit(CONTENT_RULES.suppression, "suppression", name);
    if (added.some((line) => CONTENT_RULES["test-skip"].added.test(line)))
      hit(CONTENT_RULES["test-skip"], "test-skip", name);
    if (TEST_FILE.test(name) || wasTest) {
      const delta = testCaseDelta(file);
      testNet += delta;
      if (delta < 0) shrunkTests.push(name);
    }
  }
  if (testNet < 0) {
    for (const name of shrunkTests) hit(CONTENT_RULES["fewer-tests"], "fewer-tests", name);
  }

  return withReasons({ lane: "green", reasons: [] }, [...hits.values()]);
}

const RULE_ORDER = [
  ...PATH_RULES.map((rule) => rule.id),
  UNKNOWN_RULE.id,
  ...Object.keys(CONTENT_RULES),
  ...Object.keys(CHECKS_RULES),
  "test-strength",
];

function withReasons(result, extra) {
  const reasons = [...result.reasons, ...extra].sort(
    (a, b) =>
      laneRank(b.lane) - laneRank(a.lane) ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );
  const lane = reasons.reduce((current, reason) => higher(current, reason.lane), result.lane);
  return { lane, reasons };
}

const isTestSupport = (file) => TEST_SUPPORT.some((pattern) => pattern.test(file));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function normalizeText(text) {
  return (text ?? "").replace(/\r\n?/g, "\n");
}

function checksMarker(message) {
  const match = CHECKS_TRAILER.exec(normalizeText(message));
  if (!match) return null;
  const none = /^none\b[ \t]*,?[ \t]*(.*)$/i.exec(match[1]);
  return none ? { kind: "none", reason: none[1].trim() } : { kind: "checks", note: match[1] };
}

function hasRequest(body) {
  const match = REQUEST_SECTION.exec(normalizeText(body));
  return Boolean(match && match[1].trim());
}

function parseRepairs(text) {
  const match = REPAIRS_LINE.exec(normalizeText(text));
  if (!match || !match[1]) return null;
  if (/^none,[ \t]*older than 14 days\.?$/i.test(match[1])) return { none: true, targets: [] };
  const targets = match[1]
    .split(/[\s,`]+/)
    .filter(Boolean)
    .map((ref) => {
      const pr = /^#(\d+)$|^(\d{1,6})$/.exec(ref);
      if (pr) return { kind: "pr", ref, number: Number(pr[1] ?? pr[2]) };
      if (/^[0-9a-f]{7,40}$/i.test(ref)) return { kind: "commit", ref: ref.toLowerCase() };
      return { kind: "unknown", ref };
    });
  return { none: false, targets };
}

function testNames(patch) {
  return addedLines(patch ?? "")
    .filter((line) => TEST_CASE.test(line))
    .map((line) => TEST_NAME.exec(line)?.[2] ?? NAMELESS_TEST);
}

function patchKey(file) {
  if (typeof file.patch !== "string") return `blob:${file.sha ?? "none"}`;
  const changed = file.patch
    .split("\n")
    .filter((line) => /^[-+]/.test(line))
    .join("\n");
  return sha256(`${file.previous_filename ?? ""}\n${changed}`);
}

function testEntry(file) {
  return {
    file: file.filename,
    status: file.status,
    key: patchKey(file),
    tests: TEST_FILE.test(file.filename) ? testNames(file.patch) : [],
  };
}

function lockOf(commit, marker, files) {
  const entries = files.map(testEntry).sort((a, b) => a.file.localeCompare(b.file));
  const fingerprint = sha256(
    JSON.stringify([marker, entries.map((entry) => [entry.file, entry.status, entry.key])]),
  );
  return {
    commit: commit.sha,
    fingerprint,
    kind: marker.kind,
    ...(marker.kind === "none" ? { reason: marker.reason } : {}),
    files: entries,
  };
}

function compareTests(locked, now) {
  const before = new Map(locked.map((entry) => [entry.file, entry]));
  const after = new Map(now.map((entry) => [entry.file, entry]));
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  return files.flatMap((file) => {
    const was = before.get(file);
    const is = after.get(file);
    if (was && is && was.key === is.key) return [];
    return [{ file, before: was ? was.tests : null, after: is ? is.tests : null }];
  });
}

function reason(id, files = []) {
  const rule = CHECKS_RULES[id];
  return { rule: id, lane: rule.lane, why: rule.why, files };
}

function judgeChecks({ lane, body, commits, firstFiles, prFiles, lock }) {
  const none = { state: null, reasons: [], lock: null, changes: [] };
  if (lane === "green") return none;
  const first = commits[0];
  const marker = first ? checksMarker(first.message) : null;
  if (!marker && !lock) {
    return {
      ...none,
      state: "no checks",
      reasons: lane === "amber" ? [reason("checks-missing")] : [],
    };
  }
  const reasons = [];
  if (!hasRequest(body)) reasons.push(reason("request-missing"));
  const current = marker ? lockOf(first, marker, firstFiles) : null;
  const rewritten = Boolean(lock && lock.fingerprint !== current?.fingerprint);
  const saved =
    lock?.shortened && current && !rewritten
      ? { ...current, commit: lock.commit }
      : (lock ?? current);
  if (rewritten) reasons.push(reason("checks-rewritten"));

  if (marker?.kind === "none") {
    if (!marker.reason || firstFiles.length > 0) {
      reasons.push(
        reason(
          "checks-none-invalid",
          firstFiles.map((file) => file.filename),
        ),
      );
    }
  }
  if (marker?.kind === "checks") {
    const notTests = firstFiles
      .filter(
        (file) =>
          !isTestSupport(file.filename) ||
          (file.previous_filename && !isTestSupport(file.previous_filename)),
      )
      .map((file) => file.filename);
    if (notTests.length > 0 || !firstFiles.some((file) => TEST_FILE.test(file.filename))) {
      reasons.push(reason("checks-not-tests", notTests));
    }
  }

  const revisions = commits.slice(1).filter((commit) => checksMarker(commit.message));
  if (revisions.length > 0) {
    reasons.push(
      reason(
        "checks-revised",
        revisions.map((commit) => commit.sha.slice(0, 10)),
      ),
    );
  }
  const nowTests = prFiles.filter(
    (file) =>
      file.status !== "removed" &&
      (isTestSupport(file.filename) ||
        (file.previous_filename && isTestSupport(file.previous_filename))),
  );
  const nowEntries = nowTests.map(testEntry);
  const lockedTests = (entry) => entry.files.filter((file) => isTestSupport(file.file));
  const touched =
    current && current.kind === "checks"
      ? compareTests(lockedTests(current), nowEntries).map((change) => change.file)
      : [];
  if (touched.length > 0 && revisions.length === 0) {
    reasons.push(reason("checks-touched", touched));
  }

  const revised = rewritten || revisions.length > 0 || touched.length > 0;
  return {
    state: revised ? "checks revised" : saved.kind === "none" ? "none needed" : "checked blind",
    reasons,
    lock: saved,
    changes:
      revised && saved.kind === "checks" && !saved.shortened
        ? compareTests(lockedTests(saved), nowEntries)
        : [],
  };
}

function judgeRepairs({ title, body, resolved }) {
  if (!FIX_TITLE.test(title ?? "")) return [];
  const parsed = parseRepairs(body);
  if (!parsed || (!parsed.none && parsed.targets.length === 0)) return [reason("repairs-missing")];
  const unknown = resolved.filter((target) => !target.onBase).map((target) => target.ref);
  const newer = resolved
    .filter((target) => target.onBase && !target.inHistory)
    .map((target) => target.ref);
  return [
    ...(unknown.length > 0 ? [reason("repairs-unknown", unknown)] : []),
    ...(newer.length > 0 ? [reason("repairs-not-older", newer)] : []),
  ];
}

const PLAIN_TEXT = /^[A-Za-z0-9 .,:;'"()/+=?!-]*$/;
const LINK_LIKE = /:\/\/|www\.|[0-9a-f]{7}|gh-\d/i;

function codeSpan(text) {
  const flat = hideMarkers(text).replace(/\r\n?|\n/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(flat) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const isPlain = (text) => PLAIN_TEXT.test(text) && !LINK_LIKE.test(text);
const asText = (text) => (isPlain(text) ? text : codeSpan(text));
const quoted = (names) =>
  names.map((name) => (isPlain(name) ? `"${name}"` : codeSpan(name))).join(", ");

function describeChange(change) {
  const name = codeSpan(change.file);
  if (!TEST_FILE.test(change.file)) {
    if (change.after === null)
      return `- ${name}: a test helper the checks changed, now back as it was before.`;
    if (change.before === null) return `- ${name}: a test helper changed after the lock.`;
    return `- ${name}: a test helper in the locked checks, changed again after the lock.`;
  }
  if (change.after === null) {
    return `- ${name}: in the locked checks with ${change.before.length} tests, now deleted or put back as it was before.`;
  }
  if (change.before === null) {
    return `- ${name}: not in the locked checks; it now adds ${change.after.length} tests: ${quoted(change.after)}.`;
  }
  const gone = change.before.filter((test) => !change.after.includes(test));
  const added = change.after.filter((test) => !change.before.includes(test));
  if (gone.length === 0 && added.length === 0) {
    return `- ${name}: the same ${change.after.length} test names, but the code inside the tests changed.`;
  }
  return [
    `- ${name}: locked with ${change.before.length} tests, now ${change.after.length}.`,
    gone.length > 0 ? ` Gone: ${quoted(gone)}.` : "",
    added.length > 0 ? ` New: ${quoted(added)}.` : "",
  ].join("");
}

function renderChanges(changes) {
  if (changes.length === 0) return "";
  return [
    "**How the checks changed since they were locked**",
    "",
    ...changes.map(describeChange),
  ].join("\n");
}

const isLock = (value) =>
  typeof value?.commit === "string" &&
  typeof value.fingerprint === "string" &&
  Array.isArray(value.files) &&
  value.files.every((entry) => typeof entry?.file === "string" && Array.isArray(entry.tests));

function readLock(body) {
  const start = body.indexOf(LOCK_MARKER);
  const strength = body.indexOf(STRENGTH_MARKER);
  if (start === -1 || (strength !== -1 && strength < start)) return null;
  const json = body.slice(start + LOCK_MARKER.length);
  try {
    const lock = JSON.parse(json.slice(0, json.indexOf("-->")));
    return isLock(lock) ? lock : null;
  } catch {
    return null;
  }
}

function renderLockComment(lock, checks) {
  const short = lock.commit.slice(0, 10);
  const tests = lock.files.filter((entry) => TEST_FILE.test(entry.file));
  const count = tests.reduce((total, entry) => total + entry.tests.length, 0);
  const broken = checks.reasons.filter((entry) => entry.rule in CHECKS_RULES);
  return [
    `${LOCK_MARKER}${JSON.stringify(lock)
      .replace(/</g, "\\u003c")
      .replace(/--(!?)>/g, "--$1\\u003e")}-->`,
    "### Locked checks",
    "",
    lock.kind === "none"
      ? lock.shortened
        ? `The first commit \`${short}\` says no test is needed. Its reason is left out here to keep the comment within GitHub's size limit.`
        : `The first commit \`${short}\` says no test is needed: ${lock.reason ? asText(lock.reason) : "(no reason given)"}.`
      : lock.shortened
        ? `Locked at commit \`${short}\`.`
        : `Locked at commit \`${short}\`: ${tests.length} test files with ${count} tests.`,
    ...tests.map((entry) => `- ${codeSpan(entry.file)}: ${entry.tests.length} tests`),
    "",
    checks.state === null
      ? "The changed files need no locked checks, so this run did not judge them."
      : broken.length > 0
        ? ["Broken since the lock:", ...broken.map((entry) => `- **${entry.why}**`)].join("\n")
        : "The checks are as they were locked.",
    "",
    lock.shortened
      ? "This lock leaves out the list of locked tests and how they changed, to keep the comment within GitHub's size limit. Its fingerprint still catches a rewritten checks commit."
      : renderChanges(checks.changes),
    "",
    "The lane bot wrote this lock the first time it saw the checks commit, and keeps it. An edit to this comment shows in its edit history.",
  ].join("\n");
}

function renderBotComment({ previous, checks, strength }) {
  const lock = checks.lock ?? readLock(previous ?? "");
  const render = (saved) =>
    [
      ...(saved ? [renderLockComment(saved, checks)] : []),
      ...(strength === null ? [] : [`${STRENGTH_MARKER}\n${strength}`]),
    ].join("\n\n");
  const full = render(lock);
  if (Buffer.byteLength(full) <= GITHUB_COMMENT_BYTES) return full;
  const short = render(lock && { ...lock, files: [], shortened: true });
  if (Buffer.byteLength(short) <= GITHUB_COMMENT_BYTES) return short;
  let cut = Buffer.from(short).subarray(0, GITHUB_COMMENT_BYTES).toString();
  while (Buffer.byteLength(cut) > GITHUB_COMMENT_BYTES) cut = cut.slice(0, -1);
  return cut;
}

function isBotComment(comment) {
  const body = comment.body ?? "";
  return (
    comment.user?.login === LANE_BOT &&
    (body.includes(LOCK_MARKER) || body.includes(STRENGTH_MARKER))
  );
}

function isRequired(env = process.env) {
  return env.BLIND_CHECKS_MODE === "required";
}

function checkOutcome({ result, required, event }) {
  const reasons =
    required && event === "pull_request_target"
      ? result.reasons.filter((entry) => entry.lane === "red" && entry.rule !== "test-strength")
      : [];
  return { fails: reasons.length > 0, reasons };
}

function summarize(result, { maxFiles = 5, required = false, event, changes = [] } = {}) {
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
  if (changes.length > 0) lines.push("", renderChanges(changes));
  lines.push(
    "",
    checkOutcome({ result, required, event }).fails
      ? "The lane rules are switched on, so this check fails until the red reasons above, other than test strength, are fixed. The rules come from the base branch, so this pull request cannot change its own lane."
      : "This lane is a report only. Nothing was merged, blocked or closed. The rules come from the base branch, so this pull request cannot change its own lane.",
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

function ghApi() {
  const withQuery = (path, params) => {
    const query = new URLSearchParams(params).toString();
    return query ? `${path}?${query}` : path;
  };
  return {
    get: async (path, params = {}) => {
      try {
        return JSON.parse(ghJson(["api", withQuery(path, params)]));
      } catch (error) {
        const status = /HTTP (\d{3})/.exec(String(error.stderr ?? ""))?.[1];
        throw Object.assign(new Error(`gh api ${path} failed`), { status: Number(status) });
      }
    },
    all: async (path) =>
      ghJson(["api", "--paginate", withQuery(path, { per_page: 100 }), "--jq", ".[]"])
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function octokitApi(github) {
  return {
    get: async (path, params = {}) => (await github.request(`GET ${path}`, params)).data,
    all: (path) => github.paginate(`GET ${path}`, { per_page: 100 }),
  };
}

async function resolveRepairs(api, repoPath, pr) {
  const parsed = parseRepairs(pr.body);
  if (!parsed) return [];
  const missing = (error) => {
    if (error.status === 404 || error.status === 422) return null;
    throw error;
  };
  const contains = async (sha, head) => {
    if (!sha) return false;
    const compared = await api
      .get(`${repoPath}/compare/${sha}...${head}`, { per_page: 1 })
      .catch(missing);
    return compared?.status === "ahead" || compared?.status === "identical";
  };
  return Promise.all(
    parsed.targets.map(async (target) => {
      if (target.kind === "pr") {
        const found = await api.get(`${repoPath}/pulls/${target.number}`).catch(missing);
        const onBase = Boolean(found?.merged_at && found.base?.ref === pr.base.ref);
        return {
          ref: target.ref,
          onBase,
          inHistory: onBase && (await contains(found.merge_commit_sha, pr.head.sha)),
        };
      }
      if (target.kind !== "commit") return { ref: target.ref, onBase: false, inHistory: false };
      const found = await api.get(`${repoPath}/commits/${target.ref}`).catch(missing);
      if (!found) return { ref: target.ref, onBase: false, inHistory: false };
      const [onBase, inHistory] = await Promise.all([
        contains(found.sha, pr.base.sha),
        contains(found.sha, pr.head.sha),
      ]);
      return { ref: target.ref, onBase, inHistory };
    }),
  );
}

async function judgePullRequest(api, repoPath, pr, listed) {
  const base = classifyPullRequestFiles(listed, pr.changed_files);
  const isFix = FIX_TITLE.test(pr.title ?? "");
  const empty = { state: null, reasons: [], lock: null, changes: [] };
  if (base.lane === "green" && !isFix) return { result: base, checks: empty, lockComment: null };
  const commits = (await api.all(`${repoPath}/pulls/${pr.number}/commits`)).map((entry) => ({
    sha: entry.sha,
    message: entry.commit.message,
  }));
  let checks = empty;
  let lockComment = null;
  if (base.lane !== "green") {
    const comments = await api.all(`${repoPath}/issues/${pr.number}/comments`);
    lockComment =
      comments.find((comment) => isBotComment(comment) && readLock(comment.body) !== null) ?? null;
    const firstFiles =
      commits[0] && checksMarker(commits[0].message)
        ? ((await api.get(`${repoPath}/commits/${commits[0].sha}`)).files ?? [])
        : [];
    checks = judgeChecks({
      lane: base.lane,
      body: pr.body,
      commits,
      firstFiles,
      prFiles: listed,
      lock: lockComment ? readLock(lockComment.body) : null,
    });
  }
  const repairs = isFix
    ? judgeRepairs({
        title: pr.title,
        body: pr.body,
        resolved: await resolveRepairs(api, repoPath, pr),
      })
    : [];
  return { result: withReasons(base, [...checks.reasons, ...repairs]), checks, lockComment };
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
  return { pr, listed, changedFiles: pr.changed_files };
}

async function syncComment(github, { owner, repo, number }, checks, comment, strengthText) {
  const body = renderBotComment({
    previous: comment?.body ?? null,
    checks,
    strength: strengthText,
  });
  if (!comment) {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  } else if (comment.body !== body) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
  }
}

const same = (a, b) => typeof a === "string" && a === b;

function runForPullRequest({ runs, pr }) {
  return (
    runs
      .filter(
        (run) =>
          same(run.head_sha, pr.head.sha) &&
          same(run.head_branch, pr.head.ref) &&
          same(run.head_repository?.full_name, pr.head.repo?.full_name),
      )
      .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0] ?? null
  );
}

function pullRequestForRun({ run, open, defaultBranch }) {
  return (
    open.find((pr) => pr.base.ref === defaultBranch && runForPullRequest({ runs: [run], pr }))
      ?.number ?? null
  );
}

async function pullRequestFor(github, context) {
  if (context.payload.pull_request) return context.payload.pull_request;
  const finished = context.payload.workflow_run;
  if (finished?.event !== "pull_request") return null;
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const open = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    base: defaultBranch,
    per_page: 100,
  });
  const number = pullRequestForRun({ run: finished, open, defaultBranch });
  if (number === null) return null;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return pr.state === "open" && pullRequestForRun({ run: finished, open: [pr], defaultBranch })
    ? pr
    : null;
}

async function readMeasurement(github, { owner, repo }, pr) {
  const sha = pr.head.sha;
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "blind-checks.yml",
    head_sha: sha,
    event: "pull_request",
    per_page: 20,
  });
  const latest = runForPullRequest({ runs: data.workflow_runs, pr });
  if (!latest || latest.status !== "completed") return { state: "pending" };
  const { data: listed } = await github.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: latest.id,
    name: "test-strength",
  });
  const artifact = listed.artifacts.find((entry) => !entry.expired);
  if (!artifact || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) return { state: "missing" };
  const { data: zip } = await github.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strength-"));
  try {
    const file = path.join(dir, "measurement.zip");
    fs.writeFileSync(file, Buffer.from(zip));
    const measurement = JSON.parse(
      execFileSync("unzip", ["-p", file, "measurement.json"], {
        encoding: "utf8",
        maxBuffer: MAX_MEASUREMENT_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return measurement?.head === sha ? { state: "measured", measurement } : { state: "missing" };
  } catch {
    return { state: "missing" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function judgeStrengthOf(github, api, repoPath, ids, pr, listed) {
  const { judgeStrength, planStrength } = require("./test-strength.cjs");
  const found = await readMeasurement(github, ids, pr);
  const measurement = found.state === "measured" ? found.measurement : null;
  const commits = await api.all(`${repoPath}/pulls/${pr.number}/commits`);
  const plan = planStrength({
    firstMessage: commits[0]?.commit?.message ?? null,
    commit: pr.head.sha,
    files: listed,
    repoFiles: Array.isArray(measurement?.tests)
      ? measurement.tests.filter((file) => typeof file === "string").slice(0, 1000)
      : [],
  });
  if (plan.run && !measurement) {
    return {
      result: "not measured",
      reason: found.state,
      tried: 0,
      missed: 0,
      missedLines: 0,
      uncovered: 0,
      examples: [],
    };
  }
  return judgeStrength({
    plan,
    testsPassed: measurement?.testsPassed === true,
    reports: Array.isArray(measurement?.reports) ? measurement.reports : [],
    outOfTime: measurement?.outOfTime || undefined,
  });
}

async function ensureLabel(github, { owner, repo }, name) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name });
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({ owner, repo, name, ...STRENGTH_LABEL_LOOK[name] });
    } catch (created) {
      if (created.status !== 422) throw created;
    }
  }
}

async function syncPullRequest({ github, context, core }) {
  const {
    isStrengthRequired,
    renderStrength,
    strengthLabelChanges,
    strengthReasons,
  } = require("./test-strength.cjs");
  const pr = await pullRequestFor(github, context);
  if (!pr) {
    core.info("No open pull request has this commit as its head, so nothing was written.");
    return null;
  }
  const { owner, repo } = context.repo;
  const api = octokitApi(github);
  const repoPath = `/repos/${owner}/${repo}`;
  const listed = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const judged = await judgePullRequest(api, repoPath, pr, listed);
  const { checks, lockComment } = judged;
  const strength = await judgeStrengthOf(github, api, repoPath, { owner, repo }, pr, listed);
  const strengthRequired = isStrengthRequired();
  const result = withReasons(
    judged.result,
    strengthReasons(strength, { required: strengthRequired }),
  );
  const strengthText = renderStrength(strength, { required: strengthRequired });
  const comment =
    lockComment ?? (await api.all(`${repoPath}/issues/${pr.number}/comments`)).find(isBotComment);
  await syncComment(github, { owner, repo, number: pr.number }, checks, comment, strengthText);
  const wanted = `lane:${result.lane}`;

  const current = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const labels = strengthLabelChanges(
    current.map((label) => label.name),
    strength.result,
  );
  const remove = [
    ...current
      .map((label) => label.name)
      .filter((name) => name.startsWith("lane:") && name !== wanted),
    ...labels.remove,
  ];
  for (const name of remove) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  for (const name of labels.add) await ensureLabel(github, { owner, repo }, name);
  const add = [...(current.some((label) => label.name === wanted) ? [] : [wanted]), ...labels.add];
  if (add.length > 0) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: add });
  }

  core.info(
    `PR #${pr.number}: ${wanted}, strength ${strength.result} (${result.reasons.map((reason) => reason.rule).join(", ")})`,
  );
  const required = isRequired();
  const event = context.eventName;
  await core.summary
    .addRaw(summarize(result, { maxFiles: 10, required, event, changes: checks.changes }))
    .addRaw(`\n\n${strengthText}\n`)
    .write();
  const outcome = checkOutcome({ result, required, event });
  if (outcome.fails) {
    core.setFailed(outcome.reasons.map((entry) => entry.why).join("; "));
  }
  return result;
}

async function main() {
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
        "--pr reads the pull request's files, commits, lock comment and Repairs: targets from the GitHub API, as the Merge Lane workflow does, and changes nothing.",
      ].join("\n"),
    );
    process.exit(2);
  }
  let result;
  let changes = [];
  if (pr) {
    const repo = flag("--repo");
    const fetched = fetchPullRequestFiles(repo, pr);
    const judged = await judgePullRequest(ghApi(), `/repos/${repo}`, fetched.pr, fetched.listed);
    result = judged.result;
    changes = judged.checks.changes;
  } else {
    const files = gitFiles({ cwd, range, worktree: Boolean(worktreeBase) });
    result = classify(files, { packageDirs: readWorkspace().map((pkg) => pkg.dir) });
  }
  console.log(
    args.includes("--json")
      ? JSON.stringify(result, null, 2)
      : summarize(result, {
          required: isRequired(),
          event: process.env.GITHUB_EVENT_NAME,
          changes,
        }),
  );
}

module.exports = {
  LANES,
  LANE_MEANING,
  PATH_RULES,
  CONTENT_RULES,
  CHECKS_RULES,
  TEST_FILE,
  TEST_SUPPORT,
  FIX_TITLE,
  classify,
  checkOutcome,
  summarize,
  parseGitDiff,
  gitFiles,
  isTestSupport,
  checksMarker,
  parseRepairs,
  testNames,
  judgeChecks,
  judgeRepairs,
  resolveRepairs,
  renderChanges,
  renderLockComment,
  readLock,
  renderBotComment,
  pullRequestForRun,
  runForPullRequest,
  syncPullRequest,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
