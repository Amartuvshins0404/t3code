// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildLedger, scoreLedger, writerModel } from "./merge-ledger.ts";
import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  keptEscape,
  sortDisagreements,
  sortLinks,
  type Disagreement,
  type Escape,
  type Link,
} from "./merge-ledger.ts";

const DAY = 86_400;
const START = Date.parse("2026-01-01T12:00:00Z") / 1000;

function makeRepo() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "merge-ledger-"));
  const run = (args: ReadonlyArray<string>, at = START) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Dev",
        GIT_AUTHOR_EMAIL: "dev@example.com",
        GIT_COMMITTER_NAME: "Dev",
        GIT_COMMITTER_EMAIL: "dev@example.com",
        GIT_AUTHOR_DATE: `@${at} +0000`,
        GIT_COMMITTER_DATE: `@${at} +0000`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  run(["init", "-q", "-b", "main"]);
  const commit = (message: string, day: number, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, path), text);
    }
    run(["add", "-A"]);
    run(["commit", "-q", "-m", message], START + day * DAY);
    return run(["rev-parse", "HEAD"]);
  };
  return {
    dir,
    run,
    commit,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

const lines = (...values: ReadonlyArray<string>) => `${values.join("\n")}\n`;

describe("merge ledger", () => {
  it("links fixes to the recent changes whose lines they repair, and reverts to what they undo", async () => {
    const repo = makeRepo();
    try {
      const old = repo.commit("feat: old code (#1)", -60, { "src/old.ts": lines("a", "b", "c") });
      const parser = repo.commit(
        "feat: add parser (#2)\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
        0,
        {
          "src/parse.ts": lines(
            "export function parse(input) {",
            "  return input.split(',');",
            "}",
          ),
          "src/parse.test.ts": lines('it("parses", () => {});'),
        },
      );
      const widget = repo.commit("feat: add widget (#3)", 1, {
        "src/widget.ts": lines("export const size = 1;", "export const color = 'red';"),
        "src/widget.test.ts": lines('it("sizes", () => {});'),
      });
      const fix = repo.commit("fix: parser handles empty input (#4)", 2, {
        "src/parse.ts": lines(
          "export function parse(input) {",
          "  return input ? input.split(',') : [];",
          "}",
        ),
      });
      const oldFix = repo.commit("fix: old code uses b2 (#5)", 3, {
        "src/old.ts": lines("a", "b2", "c"),
      });
      const testFix = repo.commit("fix: widget test name (#6)", 3, {
        "src/widget.test.ts": lines('it("has a size", () => {});'),
      });
      const spacing = repo.commit("fix: widget spacing (#7)", 3, {
        "src/widget.ts": lines("export const size  =  1;", "export const color = 'red';"),
      });
      const risky = repo.commit("feat: risky toggle (#8)", 4, {
        "src/risky.ts": lines("export const on = true;"),
      });
      NodeFS.rmSync(NodePath.join(repo.dir, "src/risky.ts"));
      const revert = repo.commit(
        `Revert "feat: risky toggle (#8)"\n\nThis reverts commit ${risky}.`,
        5,
        {},
      );
      const banner = repo.commit("feat: banner (#9)", 6, {
        "src/banner.ts": lines("export const banner = 'hi';"),
      });
      NodeFS.rmSync(NodePath.join(repo.dir, "src/banner.ts"));
      const unnamedRevert = repo.commit("revert(web): take the banner back out (#10)", 30, {});
      repo.commit("feat: config (#11)", -60, {
        "src/config.ts": lines("export const a = 1;", "export const b = 2;", "export const c = 3;"),
      });
      const tweak = repo.commit("feat: tweak config (#12)", 31, {
        "src/config.ts": lines("export const a = 1;", "export const b = 2;", "export const c = 4;"),
      });
      const configFix = repo.commit("fix: config values (#13)", 32, {
        "src/config.ts": lines("export const a = 5;", "export const b = 6;", "export const c = 7;"),
      });
      const notes = repo.commit("feat: notes (#14)", 31, {
        "src/notes.ts": lines("// keep in sync with the server", "export const notes = 1;"),
      });
      const notesFix = repo.commit("fix: notes comment (#15)", 32, {
        "src/notes.ts": lines("// keep in sync with the relay", "export const notes = 1;"),
      });
      const pad = (width: string) => [
        "export function formatDuration(totalSeconds: number) {",
        "  const minutes = Math.floor(totalSeconds / 60).toString();",
        `  const seconds = (totalSeconds % 60).toString().padStart(${width}, "0");`,
        "  return `${minutes}:${seconds}`;",
        "}",
      ];
      const formatter = repo.commit("feat: duration formatter (#16)", 33, {
        "src/format.ts": lines("export const unit = 's';", ...pad("1")),
      });
      const move = repo.commit("refactor: move the formatter into text (#17)", 34, {
        "src/format.ts": lines("export const unit = 's';"),
        "src/text.ts": lines("export const separator = ':';", ...pad("1")),
      });
      const padFix = repo.commit("fix: durations pad seconds to two digits (#18)", 35, {
        "src/text.ts": lines("export const separator = ':';", ...pad("2")),
      });
      const secondPadFix = repo.commit("fix: negative durations round toward zero (#19)", 36, {
        "src/text.ts": lines(
          "export const separator = ':';",
          ...pad("2").map((line) => line.replace("Math.floor", "Math.trunc")),
        ),
      });
      const slug = repo.commit("feat: slugs (#20)", 37, {
        "src/slug.ts": lines("export function slug(text) {", "  return text.toLowerCase();", "}"),
      });
      const guardFix = repo.commit(
        `fix: slugs of empty titles (#21)\n\nRepairs: ${slug.slice(0, 10)}`,
        38,
        {
          "src/slug.ts": lines(
            "export function slug(text) {",
            "  if (!text) return '';",
            "  return text.toLowerCase();",
            "}",
          ),
        },
      );
      const oldSlugFix = repo.commit(
        "fix: slugs keep dashes (#22)\n\nRepairs: none, older than 14 days",
        39,
        {
          "src/slug.ts": lines(
            "export function slug(text) {",
            "  if (!text) return '';",
            "  return text.toLowerCase().replace(/ /g, '-');",
            "}",
          ),
        },
      );

      const ledger = await buildLedger({
        cwd: repo.dir,
        branch: "main",
        since: "2025-10-01",
        until: "2026-03-01",
        windowDays: 14,
        packageDirs: [],
      });
      const bySha = new Map(ledger.changes.map((change) => [change.sha, change]));

      expect(bySha.get(parser)?.escape).toMatchObject({ kind: "fix", by: fix, days: 2 });
      expect(bySha.get(old)?.escape).toBeNull();
      expect(bySha.get(widget)?.escape).toBeNull();
      expect(bySha.get(risky)?.escape).toMatchObject({ kind: "revert", by: revert, days: 1 });
      expect(bySha.get(banner)?.escape).toMatchObject({
        kind: "revert",
        by: unnamedRevert,
        days: 24,
      });
      for (const sha of [fix, oldFix, testFix, spacing, revert, unnamedRevert]) {
        expect(bySha.get(sha)?.escape).toBeNull();
      }
      expect(bySha.get(tweak)?.escape).toBeNull();
      expect(bySha.get(notes)?.escape).toBeNull();
      expect(bySha.get(move)?.escape).toBeNull();
      expect(bySha.get(formatter)?.escape).toMatchObject({ kind: "fix", by: padFix, days: 2 });
      expect(
        ledger.links.filter((link) => link.change === formatter).map((link) => link.by),
      ).toEqual(expect.arrayContaining([padFix, secondPadFix]));
      for (const sha of [configFix, notesFix, oldSlugFix]) {
        expect(ledger.links.some((link) => link.by === sha)).toBe(false);
      }
      expect(bySha.get(slug)?.escape).toMatchObject({ kind: "fix", by: guardFix, days: 1 });
      expect(ledger.links.filter((link) => link.by === guardFix)).toMatchObject([
        { change: slug, source: "repairs" },
      ]);
      expect(ledger.disagreements).toEqual([
        {
          fix: guardFix,
          subject: "fix: slugs of empty titles (#21)",
          declared: [slug],
          notListed: [],
          blamed: [],
        },
        {
          fix: oldSlugFix,
          subject: "fix: slugs keep dashes (#22)",
          declared: [],
          notListed: [],
          blamed: [slug],
        },
      ]);

      expect(
        scoreLedger(ledger, [
          { fix, kind: "repair-recent", culprits: [parser] },
          { fix: padFix, kind: "repair-recent", culprits: [formatter] },
          { fix: secondPadFix, kind: "not-repair", culprits: [] },
          { fix: configFix, kind: "repair-old", culprits: [] },
          { fix: notesFix, kind: "unsure", culprits: [] },
          { fix: "0".repeat(40), kind: "repair-recent", culprits: [old] },
        ]),
      ).toEqual({
        scored: 4,
        unsure: 1,
        outsideRange: 1,
        culpritsBeforeRange: 0,
        linksMade: 3,
        linksRight: 2,
        labelledLinks: 2,
        labelledLinksFound: 2,
        labelledRecent: 2,
        ledgerRecent: 3,
        recentFound: 2,
      });

      expect(bySha.get(parser)).toMatchObject({
        pr: 2,
        model: "Claude Opus 5.5",
        area: "src",
        size: 3,
      });
      expect(ledger.totals).toMatchObject({ merges: 23, matureMerges: 23, matureEscapes: 5 });
    } finally {
      repo.cleanup();
    }
  });

  it("records whether each merged pull request was checked blind", async () => {
    const repo = makeRepo();
    try {
      repo.commit("feat: base (#1)", 0, { "src/base.ts": lines("export const base = 1;") });
      const merge = (branch: string, number: number, day: number, work: () => void) => {
        repo.run(["switch", "-q", "-c", branch, "main"]);
        work();
        repo.run(["switch", "-q", "main"]);
        repo.run(
          [
            "merge",
            "-q",
            "--no-ff",
            "-m",
            `Merge pull request #${number} from dev/${branch}\n\nfeat: ${branch}`,
            branch,
          ],
          START + day * DAY,
        );
        return repo.run(["rev-parse", "HEAD"]);
      };
      const checks = (name: string, day: number) =>
        repo.commit(`test: checks for ${name}\n\nBlind-checks: written from the request`, day, {
          [`src/${name}.test.ts`]: lines(`it("${name} works", () => {});`),
        });
      const blind = merge("blind", 2, 2, () => {
        checks("blind", 1);
        repo.commit("feat: blind", 1, { "src/blind.ts": lines("export const blind = 1;") });
      });
      const revised = merge("revised", 3, 3, () => {
        checks("revised", 2);
        repo.commit("feat: revised", 2, { "src/revised.ts": lines("export const revised = 1;") });
        repo.commit("feat: make it pass", 2, {
          "src/revised.test.ts": lines('it("passes", () => {});'),
        });
      });
      const none = merge("none", 4, 4, () => {
        repo.run(
          [
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "chore: start\n\nBlind-checks: none, copy text only",
          ],
          START + 3 * DAY,
        );
        repo.commit("feat: copy", 3, { "src/copy.ts": lines("export const copy = 'Hi';") });
      });
      const unchecked = merge("unchecked", 5, 5, () => {
        repo.commit("feat: unchecked", 4, { "src/unchecked.ts": lines("export const u = 1;") });
      });

      const ledger = await buildLedger({
        cwd: repo.dir,
        branch: "main",
        since: "2025-12-01",
        until: "2026-03-01",
        packageDirs: [],
      });
      const checksOf = new Map(ledger.changes.map((change) => [change.sha, change.checks]));
      expect([blind, revised, none, unchecked].map((sha) => checksOf.get(sha))).toEqual([
        "checked blind",
        "checks revised",
        "none needed",
        "no checks",
      ]);
      expect(ledger.byChecks.map((row) => row.key).sort()).toEqual([
        "checked blind",
        "checks revised",
        "no checks",
        "none needed",
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("reads the writer model from trailers or the repo's last-line convention", () => {
    expect(writerModel("Body\n\nCo-authored-by: GPT-6.1 Sol <noreply@openai.com>")).toBe(
      "GPT 6.1 Sol",
    );
    expect(writerModel("Body\n\nModel: GPT 5.5 Sol. Harness: Codex.")).toBe("GPT 5.5 Sol");
    expect(writerModel("Fixes the thing.\n\nClaude Opus 5.5 in Claude Code")).toBe(
      "Claude Opus 5.5 in Claude Code",
    );
    expect(writerModel("Fixes the thing.\n\nCo-authored-by: Ada <ada@example.com>")).toBeNull();
  });
});

const LATER = [
  { sha: "e".repeat(40), kind: "fix", days: 1 },
  { sha: "b".repeat(40), kind: "revert", days: 3 },
  { sha: "a".repeat(40), kind: "fix", days: 2 },
  { sha: "f".repeat(40), kind: "revert", days: 0.5 },
  { sha: "c".repeat(40), kind: "fix", days: 1 },
  { sha: "d".repeat(40), kind: "revert", days: 3 },
] as const;
const LATER_SHAS = LATER.map((commit) => commit.sha);
const laterOf = (sha: string) => LATER.find((commit) => commit.sha === sha) ?? LATER[0];
const SEED = { arbitrary: { seed: 20261113 } };

const escapeBy = (sha: string): Escape => {
  const commit = laterOf(sha);
  return {
    kind: commit.kind,
    by: commit.sha,
    bySubject: `${commit.kind}: ${sha[0]}`,
    days: commit.days,
  };
};
const linkOf = (by: string, change: string): Link => ({
  kind: laterOf(by).kind,
  source: laterOf(by).kind === "fix" && by < change ? "repairs" : "blame",
  by,
  change,
  days: laterOf(by).days,
});
const disagreementOf = (fix: string): Disagreement => ({
  fix,
  subject: `fix: ${fix[0]}`,
  declared: [LATER_SHAS[0]],
  notListed: [],
  blamed: LATER_SHAS.filter((sha) => sha < fix),
});
const shuffled = <T>(items: ReadonlyArray<T>, keys: ReadonlyArray<number>) =>
  items
    .map((item, index) => ({ item, index, key: keys[index] ?? 0 }))
    .sort((a, b) => a.key - b.key || b.index - a.index)
    .map((entry) => entry.item);
const asText = (items: ReadonlyArray<unknown>) => items.map((item) => JSON.stringify(item)).sort();
const keys = Schema.Array(Schema.Literals([0, 1, 2, 3, 4, 5]));

describe("merge ledger report is the same every run", () => {
  it("keeps no escape when no later commit counts as one", () => {
    expect(keptEscape([])).toBeNull();
  });

  effectIt.prop(
    "keeps a revert over a fix, then the closest, then the first commit id, whatever order they arrive in",
    { drawn: Schema.NonEmptyArray(Schema.Literals(LATER_SHAS)), keys },
    ({ drawn, keys }) => {
      const candidates = drawn.map(escapeBy);
      const reverts = candidates.filter((candidate) => candidate.kind === "revert");
      const pool = reverts.length > 0 ? reverts : candidates;
      const closest = Math.min(...pool.map((candidate) => candidate.days));
      const first = pool
        .filter((candidate) => candidate.days === closest)
        .map((candidate) => candidate.by)
        .sort()[0];
      expect(keptEscape(candidates)).toEqual(escapeBy(first!));
      expect(keptEscape(shuffled(candidates, keys))).toEqual(escapeBy(first!));
    },
    SEED,
  );

  effectIt.prop(
    "lists fix-to-change links in one order whatever order they arrive in",
    {
      pairs: Schema.Array(
        Schema.Struct({ by: Schema.Literals(LATER_SHAS), change: Schema.Literals(LATER_SHAS) }),
      ),
      keys,
    },
    ({ pairs, keys }) => {
      const links = pairs.map((pair) => linkOf(pair.by, pair.change));
      const sorted = sortLinks(links);
      expect(asText(sorted)).toEqual(asText(links));
      expect(sortLinks(shuffled(links, keys))).toEqual(sorted);
      expect(sortLinks([...links].reverse())).toEqual(sorted);
    },
    SEED,
  );

  effectIt.prop(
    "lists disagreements in one order whatever order they arrive in, even for fixes made in the same second",
    { fixes: Schema.Array(Schema.Literals(LATER_SHAS)), keys },
    ({ fixes, keys }) => {
      const disagreements = [...new Set(fixes)].map(disagreementOf);
      const timeOf = (fix: string) => Math.ceil(laterOf(fix).days);
      const sorted = sortDisagreements(disagreements, timeOf);
      expect(asText(sorted)).toEqual(asText(disagreements));
      expect(sortDisagreements(shuffled(disagreements, keys), timeOf)).toEqual(sorted);
      expect(sortDisagreements([...disagreements].reverse(), timeOf)).toEqual(sorted);
    },
    SEED,
  );
});
