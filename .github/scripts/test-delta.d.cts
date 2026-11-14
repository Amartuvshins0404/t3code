export interface TestDelta {
  readonly kinds: { readonly browser: number; readonly server: number; readonly unit: number };
  readonly net: number;
  readonly newBrowserFiles: ReadonlyArray<string>;
}

export const MARKER: string;
export const TEST_CASE: RegExp;

export function countTestDelta(diff: string): TestDelta;

export function hideMarkers(text: unknown): string;

export function render(delta: TestDelta): string | null;
