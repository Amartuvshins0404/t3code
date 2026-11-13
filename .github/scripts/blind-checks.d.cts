import type { ChangedFile } from "./merge-lane.cjs";

export interface PlannedFile {
  readonly file: string;
  readonly baseFile: string | null;
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
  readonly assertionResults: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly ancestorTitles?: ReadonlyArray<string>;
  }>;
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
  readonly onBase: (file: string) => boolean;
}): Plan;

export function pullRequestCommits(
  cwd: string,
  base: string,
  head: string,
): Array<{ sha: string; message: string; files: Array<ChangedFile> }>;

export function judge(
  planned: { readonly files: ReadonlyArray<PlannedFile> },
  runs: {
    readonly baseline: ReadonlyMap<string, TestResult>;
    readonly before: ReadonlyMap<string, TestResult>;
    readonly after: ReadonlyMap<string, TestResult>;
  },
): { readonly ok: boolean; readonly rows: ReadonlyArray<ProofRow> };
