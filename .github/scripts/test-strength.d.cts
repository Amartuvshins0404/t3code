import type { ChangedFile, LaneReason } from "./merge-lane.cjs";

export type StrengthResult = "strong" | "weak" | "not measured";

export type StrengthReason =
  | "no-checks"
  | "none-needed"
  | "no-code"
  | "browser-only"
  | "tests-failed"
  | "no-breaks"
  | "out-of-time"
  | "pending"
  | "missing";

export type BreakKind =
  | "ConditionalExpression"
  | "EqualityOperator"
  | "LogicalOperator"
  | "MethodExpression"
  | "Regex"
  | "BooleanLiteral"
  | "ArithmeticOperator"
  | "UnaryOperator"
  | "OptionalChaining"
  | "UpdateOperator"
  | "AssignmentOperator";

export interface CodeLines {
  readonly file: string;
  readonly lines: ReadonlyArray<number>;
}

export type StrengthPlan =
  | { readonly run: false; readonly reason: StrengthReason; readonly note?: string }
  | {
      readonly run: true;
      readonly commit: string;
      readonly code: ReadonlyArray<CodeLines>;
      readonly tests: ReadonlyArray<string>;
      readonly measured: number;
      readonly total: number;
    };

export interface StrykerPosition {
  readonly line: number;
  readonly column: number;
}

export interface StrykerReport {
  readonly schemaVersion: string;
  readonly files: Readonly<
    Record<
      string,
      {
        readonly language: string;
        readonly mutants: ReadonlyArray<{
          readonly id: string;
          readonly mutatorName: string;
          readonly replacement?: string;
          readonly status: string;
          readonly location: { readonly start: StrykerPosition; readonly end: StrykerPosition };
        }>;
      }
    >
  >;
}

export interface StrengthExample {
  readonly file: string;
  readonly line: number;
  readonly kind: BreakKind;
  readonly ran: boolean;
}

export interface StrengthVerdict {
  readonly result: StrengthResult;
  readonly reason?: StrengthReason;
  readonly note?: string;
  readonly tried: number;
  readonly missed: number;
  readonly missedLines: number;
  readonly uncovered: number;
  readonly examples: ReadonlyArray<StrengthExample>;
  readonly measured?: number;
  readonly total?: number;
  readonly outOfTime?: { readonly tried: number; readonly total: number };
}

export const BREAK_WORDING: Readonly<Record<BreakKind, string>>;
export const LABELS: Readonly<Record<StrengthResult, string>>;

export function planStrength(input: {
  readonly firstMessage: string | null;
  readonly commit: string;
  readonly files: ReadonlyArray<ChangedFile>;
  readonly repoFiles: ReadonlyArray<string>;
}): StrengthPlan;

export function planMeasurement(
  cwd: string,
  range: { readonly first: string; readonly base: string; readonly head: string },
): StrengthPlan;

export function judgeStrength(input: {
  readonly plan: StrengthPlan;
  readonly testsPassed?: boolean;
  readonly reports?: ReadonlyArray<StrykerReport>;
  readonly outOfTime?: { readonly tried: number; readonly total: number };
}): StrengthVerdict;

export function renderStrength(
  verdict: StrengthVerdict,
  options: { readonly required: boolean },
): string;

export function isStrengthRequired(env?: Readonly<Record<string, string | undefined>>): boolean;

export function strengthReasons(
  verdict: StrengthVerdict,
  options: { readonly required: boolean },
): Array<LaneReason>;

export function strengthLabelChanges(
  currentLabels: ReadonlyArray<string>,
  result: StrengthResult,
): { readonly add: Array<string>; readonly remove: Array<string> };
