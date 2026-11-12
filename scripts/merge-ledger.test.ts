// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildLedger, writerModel } from "./merge-ledger.ts";

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
  return { dir, commit, cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
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

      expect(bySha.get(parser)).toMatchObject({
        pr: 2,
        model: "Claude Opus 5.5",
        area: "src",
        size: 3,
      });
      expect(ledger.totals).toMatchObject({ merges: 11, matureMerges: 11, matureEscapes: 3 });
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
