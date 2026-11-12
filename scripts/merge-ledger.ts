// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  checksMarker,
  classify,
  FIX_TITLE,
  isTestSupport,
  parseGitDiff,
  parseRepairs,
  TEST_SUPPORT,
  type ChecksState,
  type Lane,
  type RepairsLine,
} from "../.github/scripts/merge-lane.cjs";

const HELP = `Usage:
  vp run report:merge-ledger [--branch <ref>] [--since <date>] [--until <date>]
                             [--window <days>] [--repo <owner/name>] [--score <labels.json>]
                             [--out <dir>] [--json]

Lists the changes merged to --branch (default HEAD) between --since (default
"30 days ago") and --until (default now), each with its lane, area, size and
writer model, and marks a change escaped when a later commit reverts it, or
when a later fix commit within --window days (default 14) rewrites code it
wrote: at least half of the code lines the fix changes or deletes. A fix whose
PR body or commit message has a Repairs: line is linked to the changes it names
instead, and the report lists where blame disagrees.

--repo reads lane:* labels and PR bodies of merged pull requests with gh; without
it, lanes are recomputed from the lane rules. --score compares the links with a
file of hand-labelled fixes ({ records: [{ fix, kind, culprits }] }). --out
writes merge-ledger.md and merge-ledger.json; otherwise the markdown is printed,
or the JSON with --json.`;

const DAY = 86_400;
const BLAME_CONCURRENCY = 8;
const IGNORED = [
  ...TEST_SUPPORT,
  /^docs\//,
  /\.(mdx?|txt)$/,
  /(^|\/)(pnpm-lock\.yaml|Cargo\.lock|package-lock\.json|yarn\.lock|Podfile\.lock)$/,
  /(\.gen\.|_generated|(^|\/)generated|\.generated\.)/,
  /^\.repos\//,
  /^third-party-licenses/,
];
const MODEL_HINT =
  /claude|opus|sonnet|haiku|fable|gpt|codex|gemini|grok|cursor|composer|kimi|qwen|deepseek|glm|llama|mistral/i;
const CONFIDENCE = [
  "against 60 upstream fixes labelled by hand on 2026-11-12 and kept out of tuning, 4 of the ledger's 13 links were right, and it found 4 of the 8 fixes that repaired a change from the previous 14 days.",
  "Most of the escapes listed below are wrong, and the ledger counts about 1.6 times as many recent repairs as hand reading did (13 against 8).",
  "By hand, 15 of 120 upstream fixes (12.5%) repaired a recent change.",
  "These counts are small: read a rate as rough, and a gap between two rows as real only when it is large and both rows have many mature merges.",
  "Rerun the check with --score after changing a rule; see docs/operations/merge-lanes.md.",
].join(" ");
const NOT_CODE = /^\s*$|^\s*(\/\/|\/\*|\*\/|\*(\s|$)|#(\s|$)|<!--|\{\/\*)/;

export interface LedgerOptions {
  readonly cwd: string;
  readonly branch?: string;
  readonly since?: string;
  readonly until?: string;
  readonly windowDays?: number;
  readonly packageDirs?: ReadonlyArray<string>;
  readonly pullRequests?: ReadonlyMap<string, PullRequestInfo>;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly lane: Lane | null;
  readonly model: string | null;
  readonly repairs: RepairsLine | null;
}

export interface Escape {
  readonly kind: "revert" | "fix";
  readonly by: string;
  readonly bySubject: string;
  readonly days: number;
}

export interface Link {
  readonly kind: Escape["kind"];
  readonly source: "repairs" | "blame";
  readonly by: string;
  readonly change: string;
  readonly days: number;
}

export interface Disagreement {
  readonly fix: string;
  readonly subject: string;
  readonly declared: ReadonlyArray<string>;
  readonly notListed: ReadonlyArray<string>;
  readonly blamed: ReadonlyArray<string>;
}

export interface LedgerChange {
  readonly sha: string;
  readonly time: number;
  readonly subject: string;
  readonly pr: number | null;
  readonly lane: Lane;
  readonly laneSource: "label" | "rules";
  readonly laneRules: ReadonlyArray<string>;
  readonly area: string;
  readonly size: number;
  readonly model: string;
  readonly mature: boolean;
  checks: ChecksState;
  readonly repairs: RepairsLine | null;
  escape: Escape | null;
}

export interface LedgerGroup {
  readonly key: string;
  readonly merges: number;
  readonly matureMerges: number;
  readonly matureEscapes: number;
  readonly escapeRate: number | null;
  readonly escapes: number;
  readonly medianDaysToFix: number | null;
}

export interface Ledger {
  readonly branch: string;
  readonly since: string;
  readonly until: string;
  readonly windowDays: number;
  readonly totals: LedgerGroup;
  readonly byLane: ReadonlyArray<LedgerGroup>;
  readonly byArea: ReadonlyArray<LedgerGroup>;
  readonly byModel: ReadonlyArray<LedgerGroup>;
  readonly byChecks: ReadonlyArray<LedgerGroup>;
  readonly changes: ReadonlyArray<LedgerChange>;
  readonly links: ReadonlyArray<Link>;
  readonly disagreements: ReadonlyArray<Disagreement>;
}

interface Range {
  readonly path: string;
  readonly lines: ReadonlyArray<readonly [number, number]>;
}

interface RawChange {
  readonly change: LedgerChange;
  readonly parents: ReadonlyArray<string>;
  readonly kind: "fix" | "revert" | null;
  readonly removed: ReadonlyArray<Range>;
  readonly revertHints: RevertHints;
}

interface RevertHints {
  readonly sha: string | null;
  readonly subject: string | null;
  readonly prs: ReadonlyArray<number>;
}

const isIgnored = (path: string) => IGNORED.some((pattern) => pattern.test(path));

function gitText(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function gitAsync(cwd: string, args: ReadonlyArray<string>) {
  return new Promise<string | null>((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export function writerModel(body: string): string | null {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const normalize = (name: string) =>
    name
      .replace(/\([^)]*\)/g, "")
      .replace(/\bat \w+ effort\b/i, "")
      .replace(/[-\s]+/g, " ")
      .replace(/[.\s]+$/, "")
      .trim();
  for (const line of lines) {
    const match = /^co-authored-by:\s*(.+?)\s*<([^>]*)>/i.exec(line);
    if (match && (MODEL_HINT.test(match[1]!) || /anthropic|openai/i.test(match[2]!))) {
      return normalize(match[1]!);
    }
  }
  for (const line of lines) {
    const match = /^model:\s*(.+?)(?:[.,;]\s|$)/i.exec(line);
    if (match) return normalize(match[1]!);
  }
  const last = lines.at(-1);
  return last && MODEL_HINT.test(last) && last.length <= 120 ? normalize(last) : null;
}

function prNumber(subject: string) {
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  if (merge) return Number(merge[1]);
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  return squash ? Number(squash[1]) : null;
}

function commitKind(subject: string): RawChange["kind"] {
  if (/^revert\b/i.test(subject)) return "revert";
  if (FIX_TITLE.test(subject)) return "fix";
  return null;
}

function checksOf(marker: ReturnType<typeof checksMarker>): ChecksState {
  if (!marker) return "no checks";
  return marker.kind === "none" ? "none needed" : "checked blind";
}

function memberChecks(cwd: string, from: string, to: string): ChecksState {
  const log = gitText(cwd, [
    "log",
    "--reverse",
    "--first-parent",
    "--format=%x1e%P%x1f%B%x1f",
    "--name-only",
    `${from}..${to}`,
  ]);
  const [first, ...later] = log
    .split("\x1e")
    .filter(Boolean)
    .map((entry) => {
      const [parents = "", message = "", names = ""] = entry.split("\x1f");
      return {
        merge: parents.trim().split(" ").length > 1,
        message,
        files: names.split("\n").filter(Boolean),
      };
    });
  const marker = first ? checksMarker(first.message) : null;
  if (!marker) return "no checks";
  const revised = later.some(
    (commit) =>
      checksMarker(commit.message) !== null ||
      (marker.kind === "checks" && !commit.merge && commit.files.some(isTestSupport)),
  );
  return revised ? "checks revised" : checksOf(marker);
}

function revertHints(subject: string, body: string, own: number | null): RevertHints {
  const sha = /This reverts commit ([0-9a-f]{7,40})/.exec(body)?.[1] ?? null;
  const quoted = /^Revert "(.+)"/.exec(subject)?.[1] ?? null;
  const prs = [...`${subject}\n${body}`.matchAll(/#(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number !== own);
  return { sha, subject: quoted, prs };
}

function removedRanges(files: ReturnType<typeof parseGitDiff>): Array<Range> {
  const ranges: Array<Range> = [];
  for (const file of files) {
    const path = file.previous_filename ?? file.filename;
    if (file.status === "added" || !file.patch || isIgnored(path)) continue;
    const lines: Array<[number, number]> = [];
    let line = 0;
    for (const text of file.patch.split("\n")) {
      const hunk = /^@@ -(\d+)/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (text.startsWith("-")) {
        if (!NOT_CODE.test(text.slice(1))) {
          const last = lines.at(-1);
          if (last && last[1] === line - 1) last[1] = line;
          else lines.push([line, line]);
        }
        line += 1;
      }
    }
    if (lines.length > 0) ranges.push({ path, lines });
  }
  return ranges;
}

function areaOf(files: ReturnType<typeof parseGitDiff>, packageDirs: ReadonlyArray<string>) {
  const counted = files.filter((file) => !isIgnored(file.filename));
  const pool = counted.length > 0 ? counted : files;
  const weights = new Map<string, number>();
  for (const file of pool) {
    const owner = packageDirs
      .filter((dir) => file.filename.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
    const segments = file.filename.split("/");
    const area = owner ?? (segments.length > 1 ? segments[0]! : "(root)");
    weights.set(area, (weights.get(area) ?? 0) + Math.max(1, file.additions + file.deletions));
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "(none)";
}

function epochOf(cwd: string, date: string) {
  const parsed = /--min-age=(\d+)/.exec(gitText(cwd, ["rev-parse", `--until=${date}`]));
  if (!parsed) throw new Error(`git cannot read the date "${date}"`);
  return Number(parsed[1]);
}

async function readChanges(options: Required<LedgerOptions>) {
  const nowTime = epochOf(options.cwd, options.until);
  const child = NodeChildProcess.spawn(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "-c",
      "diff.renameLimit=20000",
      "log",
      "--first-parent",
      "--diff-merges=first-parent",
      "-p",
      "-M",
      "-U0",
      "-w",
      "--no-color",
      "--no-ext-diff",
      "--format=%x1e%H%x1f%P%x1f%ct%x1f%B%x1d",
      `--since=${options.since}`,
      `--until=${options.until}`,
      options.branch,
    ],
    { cwd: options.cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  const raws: Array<RawChange> = [];
  let header: Array<string> | null = null;
  let diff: Array<string> = [];
  let skipping = false;

  const finish = () => {
    if (!header) return;
    const [sha = "", parents = "", time = "0", ...bodyParts] = header.join("\n").split("\x1f");
    const message = bodyParts.join("\x1f").replace(/\x1d[\s\S]*$/, "");
    const firstLine = message.split("\n")[0]!.trim();
    const rest = message.split("\n").slice(1);
    const pr = prNumber(firstLine);
    const titleIndex = rest.findIndex((line) => line.trim() !== "");
    const isMerge = firstLine.startsWith("Merge pull request #") && titleIndex !== -1;
    const subject = isMerge ? rest[titleIndex]!.trim() : firstLine;
    const body = (isMerge ? rest.slice(titleIndex + 1) : rest).join("\n");
    const files = parseGitDiff(diff.join("\n"));
    const info = options.pullRequests?.get(sha);
    const judged = classify(files, { packageDirs: [...options.packageDirs] });
    const kind = commitKind(subject);
    const commitTime = Number(time);
    raws.push({
      change: {
        sha,
        time: commitTime,
        subject,
        pr: info?.number ?? pr,
        lane: info?.lane ?? judged.lane,
        laneSource: info?.lane ? "label" : "rules",
        laneRules: judged.reasons
          .filter((reason) => reason.lane === judged.lane)
          .map((reason) => reason.rule),
        area: areaOf(files, options.packageDirs),
        size: files
          .filter((file) => !isIgnored(file.filename))
          .reduce((total, file) => total + file.additions + file.deletions, 0),
        model: info?.model ?? writerModel(body) ?? "unknown",
        mature: commitTime + options.windowDays * DAY <= nowTime,
        checks: checksOf(checksMarker(body)),
        repairs: info?.repairs ?? parseRepairs(body),
        escape: null,
      },
      parents: parents.split(" ").filter(Boolean),
      kind,
      removed: kind ? removedRanges(files) : [],
      revertHints:
        kind === "revert" ? revertHints(subject, body, pr) : { sha: null, subject: null, prs: [] },
    });
  };

  const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let inHeader = false;
  for await (const line of lines) {
    if (line.startsWith("\x1e")) {
      finish();
      header = [line.slice(1)];
      diff = [];
      inHeader = !line.includes("\x1d");
      continue;
    }
    if (inHeader) {
      header!.push(line);
      if (line.includes("\x1d")) inHeader = false;
      continue;
    }
    if (line.startsWith("diff --git ")) skipping = line.startsWith("diff --git a/.repos/");
    else if (
      skipping &&
      (line.startsWith("@@") || /^[-+ ]/.test(line)) &&
      !/^(---|\+\+\+) /.test(line)
    )
      continue;
    diff.push(line);
  }
  finish();
  await new Promise((resolve) => child.once("close", resolve));
  return raws;
}

async function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
) {
  const results: Array<R> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

async function blamedCommits(cwd: string, rev: string, sinceTime: number, range: Range) {
  const args = ["blame", "-w", "-M", "-C", "--porcelain", `--since=@${sinceTime}`];
  for (const [start, end] of range.lines) args.push("-L", `${start},${end}`);
  const output = await gitAsync(cwd, [...args, rev, "--", range.path]);
  const counts = new Map<string, number>();
  let total = 0;
  if (!output) return { counts, total };
  const boundary = new Set<string>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) {
      current = header[1]!;
      counts.set(current, (counts.get(current) ?? 0) + 1);
      total += 1;
    } else if (line === "boundary" && current) boundary.add(current);
  }
  for (const sha of boundary) counts.delete(sha);
  return { counts, total };
}

function group(key: string, changes: ReadonlyArray<LedgerChange>): LedgerGroup {
  const mature = changes.filter((change) => change.mature);
  const matureEscapes = mature.filter((change) => change.escape).length;
  const days = changes
    .flatMap((change) => (change.escape ? [change.escape.days] : []))
    .sort((a, b) => a - b);
  const middle = Math.floor(days.length / 2);
  return {
    key,
    merges: changes.length,
    matureMerges: mature.length,
    matureEscapes,
    escapeRate: mature.length > 0 ? matureEscapes / mature.length : null,
    escapes: changes.filter((change) => change.escape).length,
    medianDaysToFix:
      days.length === 0
        ? null
        : Math.round(
            (days.length % 2 ? days[middle]! : (days[middle - 1]! + days[middle]!) / 2) * 10,
          ) / 10,
  };
}

function groupBy(changes: ReadonlyArray<LedgerChange>, keyOf: (change: LedgerChange) => string) {
  const groups = new Map<string, Array<LedgerChange>>();
  for (const change of changes) {
    const key = keyOf(change);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.entries()]
    .map(([key, members]) => group(key, members))
    .sort((a, b) => b.matureEscapes - a.matureEscapes || b.merges - a.merges);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function keptEscape(candidates: ReadonlyArray<Escape>): Escape | null {
  return (
    [...candidates].sort(
      (a, b) =>
        Number(b.kind === "revert") - Number(a.kind === "revert") ||
        a.days - b.days ||
        byText(a.by, b.by),
    )[0] ?? null
  );
}

export function sortLinks(links: ReadonlyArray<Link>): Array<Link> {
  return [...links].sort(
    (a, b) =>
      byText(a.by, b.by) ||
      byText(a.change, b.change) ||
      byText(a.kind, b.kind) ||
      byText(a.source, b.source) ||
      a.days - b.days,
  );
}

export function sortDisagreements(
  disagreements: ReadonlyArray<Disagreement>,
  timeOf: (fix: string) => number,
): Array<Disagreement> {
  return [...disagreements].sort((a, b) => timeOf(a.fix) - timeOf(b.fix) || byText(a.fix, b.fix));
}

export async function buildLedger(input: LedgerOptions): Promise<Ledger> {
  const options = {
    branch: "HEAD",
    since: "30 days ago",
    until: "now",
    windowDays: 14,
    packageDirs: readWorkspace().map((pkg) => pkg.dir),
    pullRequests: new Map<string, PullRequestInfo>(),
    ...input,
  };
  const raws = await readChanges(options);
  const owner = new Map<string, RawChange>(raws.map((raw) => [raw.change.sha, raw]));
  for (const raw of raws) {
    if (raw.parents.length < 2) continue;
    const members = gitText(options.cwd, ["rev-list", `${raw.parents[0]}..${raw.change.sha}`])
      .split("\n")
      .filter(Boolean);
    for (const member of members) if (!owner.has(member)) owner.set(member, raw);
    raw.change.checks = memberChecks(options.cwd, raw.parents[0]!, raw.parents[1]!);
  }
  const ownerOf = (sha: string) => {
    const exact = owner.get(sha);
    if (exact || sha.length === 40) return exact;
    for (const [full, raw] of owner) if (full.startsWith(sha)) return raw;
    return undefined;
  };
  const bySubject = new Map(
    raws.map((raw) => [raw.change.subject.replace(/\s*\(#\d+\)\s*$/, ""), raw]),
  );
  const byPr = new Map(
    raws.flatMap((raw) => (raw.change.pr === null ? [] : [[raw.change.pr, raw] as const])),
  );
  const sinceTime = raws.reduce(
    (min, raw) => Math.min(min, raw.change.time),
    Number.POSITIVE_INFINITY,
  );

  const links: Array<Link> = [];
  const disagreements: Array<Disagreement> = [];
  const candidates = new Map<RawChange, Array<Escape>>();
  const mark = (
    target: RawChange | undefined,
    by: RawChange,
    kind: Escape["kind"],
    source: Link["source"] = "blame",
  ) => {
    if (!target || target === by || target.change.time > by.change.time) return;
    const exact = (by.change.time - target.change.time) / DAY;
    if (kind === "fix" && exact > options.windowDays) return;
    const days = Math.round(exact * 10) / 10;
    links.push({ kind, source, by: by.change.sha, change: target.change.sha, days });
    candidates.set(target, [
      ...(candidates.get(target) ?? []),
      { kind, by: by.change.sha, bySubject: by.change.subject, days },
    ]);
  };

  const jobs = raws.filter((raw) => raw.kind !== null && raw.parents.length > 0);
  await mapLimit(jobs, BLAME_CONCURRENCY, async (raw) => {
    if (raw.kind === "revert") {
      const hinted =
        (raw.revertHints.sha ? ownerOf(raw.revertHints.sha) : undefined) ??
        (raw.revertHints.subject
          ? bySubject.get(raw.revertHints.subject.replace(/\s*\(#\d+\)\s*$/, ""))
          : undefined);
      if (hinted) {
        mark(hinted, raw, "revert");
        return;
      }
    }
    const blameSince =
      raw.kind === "fix"
        ? raw.change.time - options.windowDays * DAY
        : Number.isFinite(sinceTime)
          ? sinceTime
          : 0;
    const totals = new Map<RawChange, number>();
    let blamed = 0;
    for (const range of raw.removed) {
      const { counts, total } = await blamedCommits(
        options.cwd,
        raw.parents[0]!,
        blameSince,
        range,
      );
      blamed += total;
      for (const [sha, count] of counts) {
        const target = ownerOf(sha);
        if (target) totals.set(target, (totals.get(target) ?? 0) + count);
      }
    }
    if (raw.kind === "fix") {
      const byBlame = [...totals]
        .filter(([target, count]) => count * 2 >= blamed && target !== raw)
        .map(([target]) => target);
      const declared = raw.change.repairs;
      if (!declared) {
        for (const target of byBlame) mark(target, raw, "fix");
        return;
      }
      const resolved = declared.targets.map((target) => ({
        ref: target.ref,
        raw:
          target.kind === "commit"
            ? ownerOf(target.ref)
            : target.kind === "pr" && target.number !== undefined
              ? byPr.get(target.number)
              : undefined,
      }));
      for (const target of resolved) mark(target.raw, raw, "fix", "repairs");
      const named = new Set(resolved.flatMap((target) => (target.raw ? [target.raw] : [])));
      const notListed = resolved.filter((target) => !target.raw).map((target) => target.ref);
      const same =
        notListed.length === 0 &&
        named.size === byBlame.length &&
        byBlame.every((target) => named.has(target));
      if (!same) {
        disagreements.push({
          fix: raw.change.sha,
          subject: raw.change.subject,
          declared: [...named].map((target) => target.change.sha),
          notListed,
          blamed: byBlame.map((target) => target.change.sha),
        });
      }
    } else {
      const [top] = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      mark(
        top?.[0] ?? raw.revertHints.prs.map((number) => byPr.get(number)).find(Boolean),
        raw,
        "revert",
      );
    }
  });

  for (const [target, escapes] of candidates) target.change.escape = keptEscape(escapes);
  const changes = raws.map((raw) => raw.change);
  return {
    branch: options.branch,
    since: options.since,
    until: options.until,
    windowDays: options.windowDays,
    totals: group("all", changes),
    byLane: groupBy(changes, (change) => change.lane),
    byArea: groupBy(changes, (change) => change.area),
    byModel: groupBy(changes, (change) => change.model),
    byChecks: groupBy(changes, (change) => change.checks),
    changes,
    links: sortLinks(links),
    disagreements: sortDisagreements(disagreements, (fix) => owner.get(fix)?.change.time ?? 0),
  };
}

export interface LabelRecord {
  readonly fix: string;
  readonly kind: "repair-recent" | "repair-old" | "not-repair" | "unsure";
  readonly culprits: ReadonlyArray<string>;
}

export interface LedgerScore {
  readonly scored: number;
  readonly unsure: number;
  readonly outsideRange: number;
  readonly culpritsBeforeRange: number;
  readonly linksMade: number;
  readonly linksRight: number;
  readonly labelledLinks: number;
  readonly labelledLinksFound: number;
  readonly labelledRecent: number;
  readonly ledgerRecent: number;
  readonly recentFound: number;
}

export function scoreLedger(ledger: Ledger, records: ReadonlyArray<LabelRecord>): LedgerScore {
  const listed = new Set(ledger.changes.map((change) => change.sha));
  const linksBy = new Map<string, Set<string>>();
  for (const link of ledger.links) {
    linksBy.set(link.by, (linksBy.get(link.by) ?? new Set()).add(link.change));
  }
  const inRange = records.filter((record) => listed.has(record.fix));
  const scored = inRange.filter((record) => record.kind !== "unsure");
  const recent = scored.filter((record) => record.kind === "repair-recent");
  const linked = (record: LabelRecord) => linksBy.get(record.fix) ?? new Set<string>();
  const right = (record: LabelRecord) => record.culprits.filter((sha) => linked(record).has(sha));
  return {
    scored: scored.length,
    unsure: inRange.length - scored.length,
    outsideRange: records.length - inRange.length,
    culpritsBeforeRange: recent
      .flatMap((record) => record.culprits)
      .filter((sha) => !listed.has(sha)).length,
    linksMade: scored.reduce((total, record) => total + linked(record).size, 0),
    linksRight: scored.reduce((total, record) => total + right(record).length, 0),
    labelledLinks: recent.reduce((total, record) => total + record.culprits.length, 0),
    labelledLinksFound: recent.reduce((total, record) => total + right(record).length, 0),
    labelledRecent: recent.length,
    ledgerRecent: scored.filter((record) => linked(record).size > 0).length,
    recentFound: recent.filter((record) => right(record).length > 0).length,
  };
}

function outOf(part: number, whole: number) {
  return `${part} of ${whole}${whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : ""}`;
}

export function renderScore(score: LedgerScore) {
  return [
    "### Score against hand labels",
    "",
    `${score.scored} labelled fixes scored; ${score.unsure} marked unsure and ${score.outsideRange} outside this run's range were skipped.`,
    "",
    `- Links right (precision): ${outOf(score.linksRight, score.linksMade)}.`,
    `- Labelled links found (recall): ${outOf(score.labelledLinksFound, score.labelledLinks)}.`,
    `- Recent repairs found: ${outOf(score.recentFound, score.labelledRecent)} labelled repair-recent fixes have a right link.`,
    `- Recent repairs counted: the ledger links ${score.ledgerRecent} of these fixes to a recent change; hand reading says ${score.labelledRecent}.`,
    score.culpritsBeforeRange > 0
      ? `- ${score.culpritsBeforeRange} labelled culprits merged before --since and could not be found; run with an earlier --since.`
      : "",
    "",
  ].join("\n");
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function table(title: string, groups: ReadonlyArray<LedgerGroup>, limit = groups.length) {
  return [
    `### ${title}`,
    "",
    "| | Merges | Mature | Escaped (mature) | Escape rate | Median days to fix |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...groups
      .slice(0, limit)
      .map(
        (row) =>
          `| ${row.key} | ${row.merges} | ${row.matureMerges} | ${row.matureEscapes} | ${percent(row.escapeRate)} | ${row.medianDaysToFix ?? "n/a"} |`,
      ),
    "",
  ].join("\n");
}

export function renderMarkdown(ledger: Ledger) {
  const total = ledger.totals;
  const share = ledger.byLane
    .map((row) => `${row.key} ${percent(row.merges / Math.max(1, total.merges))}`)
    .join(", ");
  const leaking = [...ledger.byArea]
    .filter((row) => row.matureMerges >= 10)
    .sort((a, b) => (b.escapeRate ?? 0) - (a.escapeRate ?? 0));
  const escapes = ledger.changes.filter((change) => change.escape);
  const oldest = Math.min(...ledger.changes.map((change) => change.time));
  const fixes = ledger.changes.filter(
    (change) =>
      commitKind(change.subject) === "fix" && change.time - oldest >= ledger.windowDays * DAY,
  );
  const linked = new Set(ledger.links.filter((link) => link.kind === "fix").map((link) => link.by));
  const repairing = fixes.filter((change) => linked.has(change.sha)).length;
  const declaring = ledger.changes.filter(
    (change) => commitKind(change.subject) === "fix" && change.repairs,
  ).length;
  const short = (shas: ReadonlyArray<string>) =>
    shas.length > 0 ? shas.map((sha) => sha.slice(0, 10)).join(", ") : "nothing";
  return [
    `## Merge ledger: ${ledger.branch}, ${ledger.since} to ${ledger.until}`,
    "",
    `${total.merges} merged changes. Lane share: ${share}.`,
    `${total.matureMerges} are older than the ${ledger.windowDays}-day fix window; ${total.matureEscapes} of those escaped (${percent(total.escapeRate)}). Median days to the fix or revert: ${total.medianDaysToFix ?? "n/a"}.`,
    `${repairing} of the ${fixes.length} fix commits with ${ledger.windowDays} days of listed history behind them (${percent(fixes.length ? repairing / fixes.length : null)}) are linked to a change from those days.`,
    `${declaring} fixes name what they repair in a Repairs: line, and those links come from the line. Blame links the rest. ${ledger.disagreements.length} Repairs: lines disagree with blame.`,
    "",
    "Escape rates count only mature changes, whose fix window has fully passed.",
    "",
    `**How sure:** ${CONFIDENCE}`,
    "",
    table("By lane", ledger.byLane),
    table("Leakiest areas (10+ mature merges)", leaking, 5),
    table("By area", ledger.byArea, 25),
    table("By writer model", ledger.byModel, 15),
    table("By checks", ledger.byChecks),
    "### Repairs: line against blame",
    "",
    ...(ledger.disagreements.length === 0
      ? ["Every Repairs: line in this range agrees with blame."]
      : ledger.disagreements
          .slice(0, 20)
          .map(
            (entry) =>
              `- ${entry.fix.slice(0, 10)} ${entry.subject}: the line names ${short(entry.declared)}${entry.notListed.length > 0 ? ` (not in this range: ${entry.notListed.join(", ")})` : ""}; blame names ${short(entry.blamed)}`,
          )),
    "",
    "### Escapes",
    "",
    ...escapes
      .slice(0, 50)
      .map(
        (change) =>
          `- ${change.sha.slice(0, 10)} ${change.subject} (${change.lane}, ${change.area}, ${change.checks}): ${change.escape!.kind} ${change.escape!.by.slice(0, 10)} after ${change.escape!.days} days`,
      ),
    escapes.length > 50 ? `- and ${escapes.length - 50} more in the JSON` : "",
  ].join("\n");
}

function pullRequestsFromGitHub(repo: string, base: string) {
  const output = NodeChildProcess.execFileSync(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "merged",
      "--base",
      base,
      "--limit",
      "1000",
      "--json",
      "number,labels,body,mergeCommit",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const rows = JSON.parse(output) as Array<{
    number: number;
    labels: Array<{ name: string }>;
    body: string;
    mergeCommit: { oid: string } | null;
  }>;
  const map = new Map<string, PullRequestInfo>();
  for (const row of rows) {
    if (!row.mergeCommit) continue;
    const label = row.labels.find((entry) => /^lane:(green|amber|red)$/.test(entry.name));
    const last = row.body.trim().split("\n").at(-1)?.trim() ?? "";
    map.set(row.mergeCommit.oid, {
      number: row.number,
      lane: label ? (label.name.slice(5) as Lane) : null,
      model: writerModel(row.body) ?? (last && last.length <= 120 ? last : null),
      repairs: parseRepairs(row.body),
    });
  }
  return map;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const cwd = flag("--cwd") ?? NodePath.resolve(import.meta.dirname, "..");
  const branch = flag("--branch") ?? "HEAD";
  const repo = flag("--repo");
  const ledger = await buildLedger({
    cwd,
    branch,
    since: flag("--since") ?? "30 days ago",
    until: flag("--until") ?? "now",
    windowDays: Number(flag("--window") ?? 14),
    pullRequests: repo ? pullRequestsFromGitHub(repo, branch.replace(/^[^/]+\//, "")) : new Map(),
  });
  const labels = flag("--score");
  const score = labels
    ? scoreLedger(
        ledger,
        (JSON.parse(NodeFS.readFileSync(labels, "utf8")) as { records: Array<LabelRecord> })
          .records,
      )
    : null;
  const markdown = [renderMarkdown(ledger), score ? renderScore(score) : ""].join("\n");
  const out = flag("--out");
  if (out) {
    NodeFS.mkdirSync(out, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(out, "merge-ledger.md"), `${markdown}\n`);
    NodeFS.writeFileSync(
      NodePath.join(out, "merge-ledger.json"),
      `${JSON.stringify(score ? { ...ledger, score } : ledger, null, 2)}\n`,
    );
    console.log(`Wrote ${NodePath.join(out, "merge-ledger.md")} and merge-ledger.json`);
  } else {
    console.log(args.includes("--json") ? JSON.stringify(ledger, null, 2) : markdown);
  }
}
