// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildLedger, scoreLedger, writerModel } from "./merge-ledger.ts";

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

  it("follows the documented rules at their edges", async () => {
    const repo = makeRepo();
    const remove = (path: string) => NodeFS.rmSync(NodePath.join(repo.dir, path));
    const old = Array.from({ length: 20 }, (_, index) => `export const o${index + 1} = 0;`);
    try {
      repo.commit("feat: old edge (#1)", -40, { "src/edge.ts": lines(...old) });
      repo.commit("feat: early (#2)", -5, { "src/early.ts": lines("e1", "e2") });
      repo.commit("chore: start (#3)", -1, { "src/start.ts": lines("s") });
      const wide = repo.commit("feat: wide (#4)", 0, { "src/wide.ts": lines("w1", "w2") });

      const edged = [...old];
      edged.splice(11, 3, "r12", 'const header = "@@ -1 +1 @@";', "r14");
      const edge = repo.commit("feat: edge (#5)", 1, { "src/edge.ts": lines(...edged) });
      const fixed = [...edged];
      fixed.splice(11, 3, "f12", "f13", "f14");
      fixed[17] = "f18";
      const edgeFix = repo.commit("fix: edge (#6)", 2, { "src/edge.ts": lines(...fixed) });
      const earlyFix = repo.commit("fix: early (#7)\n\nRepairs: none, older than 14 days", 3, {
        "src/early.ts": lines("e1 fixed", "e2"),
      });

      const tieA = repo.commit("feat: tie a (#8)", 3, { "src/tie.ts": lines("a", "b0") });
      const tieB = repo.commit("feat: tie b (#9)", 4, { "src/tie.ts": lines("a", "b") });
      const tieFix = repo.commit("fix: tie (#10)", 5, { "src/tie.ts": lines("a2", "b2") });

      const pr = repo.commit("feat: pr (#11)", 6, { "src/pr.ts": lines("p1") });
      const prFix = repo.commit("fix: pr (#12)\n\nRepairs: #11", 7, { "src/pr.ts": lines("p2") });
      fixed[0] = "f1";
      const unknownFix = repo.commit("fix: ghost (#13)\n\nRepairs: deadbeef00", 8, {
        "src/edge.ts": lines(...fixed),
      });

      const partX = repo.commit("feat: part x (#14)", 9, { "src/part.ts": lines("x") });
      const partZ = repo.commit("feat: part z (#15)", 10, { "src/part.ts": lines("x", "z") });
      const partY = repo.commit("feat: part y (#16)", 10, { "src/py.ts": lines("y") });
      const partFix = repo.commit("fix: part (#17)\n\nRepairs: #14, #16", 11, {
        "src/part.ts": lines("x2", "z2"),
      });

      const aged = repo.commit("feat: aged (#18)", 12, { "src/aged.ts": lines("g") });
      repo.commit("feat: limit (#19)", 13, { "src/limit.ts": lines("l1", "l2") });
      const unlimit = repo.commit("feat: unlimit (#20)", 14, { "src/limit.ts": lines("l1") });
      const relimit = repo.commit(
        `revert: bring back the limit\n\nThis reverts commit ${unlimit}.`,
        15,
        { "src/limit.ts": lines("l1", "l2") },
      );
      const stale = repo.commit("feat: stale (#21)", 15, { "src/stale.ts": lines("s") });
      const cap = repo.commit("feat: cap (#22)", 16, { "src/limit.ts": lines("l1") });
      const uncap = repo.commit("revert: restore the cap (#23)\n\nUndoes #22.", 17, {
        "src/limit.ts": lines("l1", "l2"),
      });

      const wideRecent = repo.commit("feat: wide recent (#24)", 18, {
        "src/wide.ts": lines("w1", "w2", "w3"),
      });
      const most = repo.commit("feat: most (#25)", 19, { "src/many.ts": lines("m1", "m2") });
      const least = repo.commit("feat: least (#26)", 19, {
        "src/many.ts": lines("b1", "m1", "m2"),
      });
      const wideFix = repo.commit("fix: wide (#27)\n\nRepairs: #24", 20, {
        "src/wide.ts": lines("w1x", "w2x", "w3x"),
      });
      remove("src/many.ts");
      const unmany = repo.commit("revert(web): drop many (#28)", 21, {});

      const flag = repo.commit("feat: flag (#29)", 22, {
        "src/flag.ts": lines("on"),
        "assets/flag.png": "\0\x01",
      });
      const flagFix = repo.commit("fix: flag (#30)", 23, {
        "src/flag.ts": lines("on2"),
        "assets/flag.png": "\0\x02",
      });
      remove("src/flag.ts");
      remove("assets/flag.png");
      const unflag = repo.commit(
        `Revert "feat: flag (#29)"\n\nThis reverts commit ${flag}.`,
        25,
        {},
      );
      const agedFix = repo.commit("fix: aged (#31)\n\nRepairs: #18", 26, {
        "src/note.ts": lines("n"),
      });
      const staleFix = repo.commit("fix: stale (#32)\n\nRepairs: #21", 30, {
        "src/stale-note.ts": lines("n"),
      });
      const selfFix = repo.commit("fix: self (#33)\n\nRepairs: #33", 31, {
        "src/self.ts": lines("n"),
      });
      const earlyClaim = repo.commit("fix: early claim (#34)\n\nRepairs: #35", 32, {
        "src/claim.ts": lines("n"),
      });
      const later = repo.commit("feat: later (#35)", 33, { "src/later.ts": lines("n") });

      const ledger = await buildLedger({
        cwd: repo.dir,
        branch: "main",
        since: "2025-12-30",
        until: "2026-03-01",
        windowDays: 14,
        packageDirs: [],
      });
      const escapeOf = (sha: string) => ledger.changes.find((change) => change.sha === sha)?.escape;
      const linkedBy = (sha: string) =>
        ledger.links
          .filter((link) => link.by === sha)
          .map((link) => link.change)
          .sort();

      expect(escapeOf(edge)).toMatchObject({ kind: "fix", by: edgeFix, days: 1 });
      expect(linkedBy(tieFix)).toEqual([tieA, tieB].sort());
      expect(linkedBy(prFix)).toEqual([pr]);
      expect(escapeOf(aged)).toMatchObject({ kind: "fix", by: agedFix, days: 14 });
      expect(escapeOf(stale)).toBeNull();
      expect(linkedBy(earlyFix)).toEqual([]);
      expect(escapeOf(unlimit)).toMatchObject({ kind: "revert", by: relimit });
      expect(escapeOf(cap)).toMatchObject({ kind: "revert", by: uncap });
      expect(escapeOf(most)).toMatchObject({ kind: "revert", by: unmany });
      expect(escapeOf(least)).toBeNull();
      expect(escapeOf(flag)).toMatchObject({ kind: "revert", by: unflag });
      expect(linkedBy(flagFix)).toEqual([flag]);
      expect(escapeOf(wide)).toBeNull();
      expect(ledger.disagreements).toEqual([
        {
          fix: unknownFix,
          subject: "fix: ghost (#13)",
          declared: [],
          notListed: ["deadbeef00"],
          blamed: [],
        },
        {
          fix: partFix,
          subject: "fix: part (#17)",
          declared: [partX, partY],
          notListed: [],
          blamed: [partX, partZ],
        },
        {
          fix: wideFix,
          subject: "fix: wide (#27)",
          declared: [wideRecent],
          notListed: [],
          blamed: [],
        },
        { fix: agedFix, subject: "fix: aged (#31)", declared: [aged], notListed: [], blamed: [] },
        {
          fix: staleFix,
          subject: "fix: stale (#32)",
          declared: [stale],
          notListed: [],
          blamed: [],
        },
        {
          fix: selfFix,
          subject: "fix: self (#33)",
          declared: [selfFix],
          notListed: [],
          blamed: [],
        },
        {
          fix: earlyClaim,
          subject: "fix: early claim (#34)",
          declared: [later],
          notListed: [],
          blamed: [],
        },
      ]);
      expect(linkedBy(selfFix)).toEqual([]);
      expect(linkedBy(earlyClaim)).toEqual([]);
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
      const memberFix = repo.commit("fix: blind value (#6)", 6, {
        "src/blind.ts": lines("export const blind = 2;"),
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
      expect(ledger.changes.find((change) => change.sha === blind)?.escape).toMatchObject({
        kind: "fix",
        by: memberFix,
      });
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
