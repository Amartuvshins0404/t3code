export type Lane = "green" | "amber" | "red";

export interface ChangedFile {
  readonly filename: string;
  readonly status: string;
  readonly previous_filename?: string;
  readonly patch?: string | null;
  readonly changes?: number;
  readonly binary?: boolean;
}

export interface ParsedFile extends ChangedFile {
  readonly patch: string | null;
  readonly additions: number;
  readonly deletions: number;
}

export interface LaneReason {
  readonly rule: string;
  readonly lane: Lane;
  readonly why: string;
  readonly files: ReadonlyArray<string>;
}

export interface LaneResult {
  readonly lane: Lane;
  readonly reasons: ReadonlyArray<LaneReason>;
}

export const LANES: ReadonlyArray<Lane>;
export const TEST_FILE: RegExp;

export function classify(
  files: ReadonlyArray<ChangedFile>,
  options?: { readonly packageDirs?: ReadonlyArray<string>; readonly fileListComplete?: boolean },
): LaneResult;

export function summarize(result: LaneResult, options?: { readonly maxFiles?: number }): string;

export function parseGitDiff(text: string): Array<ParsedFile>;

export function gitFiles(options: {
  readonly cwd?: string;
  readonly range: string;
  readonly worktree?: boolean;
}): Array<ParsedFile>;
