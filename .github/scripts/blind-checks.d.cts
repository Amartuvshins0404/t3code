import type { ChangedFile } from "./merge-lane.cjs";

export interface PlannedFile {
  readonly file: string;
  readonly added: boolean;
  readonly tests: ReadonlyArray<string>;
}

export type Plan =
  | { readonly run: false; readonly note: string }
  | {
      readonly run: true;
      readonly base: string;
      readonly files: ReadonlyArray<PlannedFile>;
      readonly support: ReadonlyArray<string>;
    };

export interface TestResult {
  readonly name: string;
  readonly message?: string;
  readonly assertionResults: ReadonlyArray<{ readonly title: string; readonly status: string }>;
}

export interface ProofRow {
  readonly file: string;
  readonly without: string;
  readonly withCode: string;
  readonly problems: ReadonlyArray<string>;
}

export function planProof(input: {
  readonly commits: ReadonlyArray<{
    readonly sha: string;
    readonly message: string;
    readonly files: ReadonlyArray<ChangedFile>;
  }>;
  readonly base: string;
  readonly read: (at: "base" | "head", file: string) => string | null;
}): Plan;

export function pullRequestCommits(
  cwd: string,
  base: string,
  head: string,
): Array<{ sha: string; message: string; files: Array<ChangedFile> }>;

export function judge(
  planned: { readonly commit?: string; readonly files: ReadonlyArray<PlannedFile> },
  before: ReadonlyMap<string, TestResult>,
  after: ReadonlyMap<string, TestResult>,
): { readonly ok: boolean; readonly rows: ReadonlyArray<ProofRow> };

export function namePattern(name: string): RegExp;
