export interface PlannedFile {
  readonly file: string;
  readonly added: boolean;
  readonly tests: ReadonlyArray<string>;
}

export type Plan =
  | { readonly run: false; readonly note: string }
  | { readonly run: true; readonly commit: string; readonly files: ReadonlyArray<PlannedFile> };

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

export function plan(cwd: string, commit: string): Plan;

export function judge(
  planned: { readonly commit: string; readonly files: ReadonlyArray<PlannedFile> },
  before: ReadonlyMap<string, TestResult>,
  after: ReadonlyMap<string, TestResult>,
): { readonly ok: boolean; readonly rows: ReadonlyArray<ProofRow> };

export function namePattern(name: string): RegExp;
