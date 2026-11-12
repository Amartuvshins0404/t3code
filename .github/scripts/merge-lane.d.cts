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

export type ChecksState = "checked blind" | "no checks" | "checks revised" | "none needed";

export type ChecksMarker =
  | { readonly kind: "checks"; readonly note: string }
  | { readonly kind: "none"; readonly reason: string };

export interface RepairTarget {
  readonly kind: "commit" | "pr" | "unknown";
  readonly ref: string;
  readonly number?: number;
}

export interface RepairsLine {
  readonly none: boolean;
  readonly targets: ReadonlyArray<RepairTarget>;
}

export interface CommitInfo {
  readonly sha: string;
  readonly message: string;
  readonly time?: number;
}

export interface LockedFile {
  readonly file: string;
  readonly status: string;
  readonly key: string;
  readonly tests: ReadonlyArray<string>;
}

export interface ChecksLock {
  readonly commit: string;
  readonly fingerprint: string;
  readonly kind: ChecksMarker["kind"];
  readonly reason?: string;
  readonly files: ReadonlyArray<LockedFile>;
}

export interface TestChange {
  readonly file: string;
  readonly before: ReadonlyArray<string> | null;
  readonly after: ReadonlyArray<string> | null;
}

export interface ChecksVerdict {
  readonly state: ChecksState | null;
  readonly reasons: ReadonlyArray<LaneReason>;
  readonly lock: ChecksLock | null;
  readonly changes: ReadonlyArray<TestChange>;
}

export interface ResolvedRepair {
  readonly ref: string;
  readonly onBase: boolean;
  readonly time: number | null;
}

export interface ApiFile extends ChangedFile {
  readonly sha?: string | null;
}

export const LANES: ReadonlyArray<Lane>;
export const TEST_FILE: RegExp;
export const TEST_SUPPORT: ReadonlyArray<RegExp>;
export const FIX_TITLE: RegExp;

export function classify(
  files: ReadonlyArray<ChangedFile>,
  options?: { readonly packageDirs?: ReadonlyArray<string>; readonly fileListComplete?: boolean },
): LaneResult;

export function summarize(
  result: LaneResult,
  options?: {
    readonly maxFiles?: number;
    readonly required?: boolean;
    readonly changes?: ReadonlyArray<TestChange>;
  },
): string;

export function isTestSupport(file: string): boolean;
export function checksMarker(message: string | null | undefined): ChecksMarker | null;
export function parseRepairs(text: string | null | undefined): RepairsLine | null;
export function testNames(patch: string | null | undefined): Array<string>;

export function judgeChecks(input: {
  readonly lane: Lane;
  readonly body: string | null;
  readonly commits: ReadonlyArray<CommitInfo>;
  readonly firstFiles: ReadonlyArray<ApiFile>;
  readonly prFiles: ReadonlyArray<ApiFile>;
  readonly lock: ChecksLock | null;
}): ChecksVerdict;

export function judgeRepairs(input: {
  readonly title: string;
  readonly body: string | null;
  readonly resolved: ReadonlyArray<ResolvedRepair>;
  readonly fixTime: number;
}): Array<LaneReason>;

export function renderChanges(changes: ReadonlyArray<TestChange>): string;
export function renderLockComment(lock: ChecksLock, checks: ChecksVerdict): string;
export function readLock(body: string): ChecksLock | null;
export function renderBotComment(input: {
  readonly previous: string | null;
  readonly checks: ChecksVerdict;
  readonly strength: string | null;
}): string;
export interface BlindChecksRun {
  readonly head_sha: string;
  readonly head_branch?: string | null;
  readonly head_repository?: { readonly full_name: string } | null;
  readonly pull_requests?: ReadonlyArray<{ readonly number: number }> | null;
}

export interface PullRequestHead {
  readonly head: {
    readonly sha: string;
    readonly ref?: string;
    readonly repo?: { readonly full_name: string } | null;
  };
}

export function runForPullRequest<
  Run extends BlindChecksRun & { readonly run_number: number; readonly run_attempt: number },
>(input: { readonly runs: ReadonlyArray<Run>; readonly pr: PullRequestHead }): Run | null;

export function pullRequestForRun(input: {
  readonly run: BlindChecksRun;
  readonly open: ReadonlyArray<
    PullRequestHead & { readonly number: number; readonly base: { readonly ref: string } }
  >;
  readonly defaultBranch: string;
}): number | null;

export function parseGitDiff(text: string): Array<ParsedFile>;

export function gitFiles(options: {
  readonly cwd?: string;
  readonly range: string;
  readonly worktree?: boolean;
}): Array<ParsedFile>;
