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
  readonly shortened?: true;
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
  readonly inHistory: boolean;
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

export function checkOutcome(input: {
  readonly result: LaneResult;
  readonly required: boolean;
  readonly event: string;
}): { readonly fails: boolean; readonly reasons: Array<LaneReason> };

export function summarize(
  result: LaneResult,
  options?: {
    readonly maxFiles?: number;
    readonly required?: boolean;
    readonly event?: string;
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
}): Array<LaneReason>;

export function resolveRepairs(
  api: {
    get(path: string, params?: Readonly<Record<string, string | number>>): Promise<unknown>;
  },
  repoPath: string,
  pr: {
    readonly body: string | null;
    readonly base: { readonly ref: string; readonly sha: string };
    readonly head: { readonly sha: string };
  },
): Promise<Array<ResolvedRepair>>;

type GithubCall = (
  params: Readonly<Record<string, unknown>>,
) => Promise<{ readonly data: unknown }>;

interface LanePullRequest extends PullRequestHead {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state?: string;
  readonly changed_files: number;
  readonly base: { readonly ref: string; readonly sha: string };
}

interface LaneSummary {
  addRaw(text: string): LaneSummary;
  write(): Promise<unknown>;
}

export function syncPullRequest(input: {
  readonly github: {
    readonly rest: {
      readonly pulls: Readonly<Record<"get" | "list" | "listFiles", GithubCall>>;
      readonly issues: Readonly<
        Record<
          | "addLabels"
          | "createComment"
          | "createLabel"
          | "getLabel"
          | "listLabelsOnIssue"
          | "removeLabel"
          | "updateComment",
          GithubCall
        >
      >;
      readonly actions: Readonly<
        Record<"downloadArtifact" | "listWorkflowRunArtifacts" | "listWorkflowRuns", GithubCall>
      >;
    };
    paginate(
      route: string | GithubCall,
      params: Readonly<Record<string, unknown>>,
    ): Promise<ReadonlyArray<unknown>>;
    request(
      route: string,
      params?: Readonly<Record<string, unknown>>,
    ): Promise<{ readonly data: unknown }>;
  };
  readonly context: {
    readonly eventName: string;
    readonly repo: { readonly owner: string; readonly repo: string };
    readonly payload: {
      readonly pull_request?: LanePullRequest;
      readonly workflow_run?: BlindChecksRun & { readonly event: string };
      readonly repository?: { readonly default_branch: string };
    };
  };
  readonly core: {
    info(message: string): void;
    setFailed(message: string): void;
    readonly summary: LaneSummary;
  };
}): Promise<LaneResult | null>;

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
