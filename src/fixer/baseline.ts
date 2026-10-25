import type { TestOutcome } from "./pr.ts";

export type FailedOutcome = Extract<TestOutcome, { kind: "failed" }>;

export interface TestComparison {
  baseline: FailedOutcome;
  mode: "ids" | "exit" | "cleared";
  fresh: string[];
  existing: string[];
}

export function compareTests(baseline: TestOutcome | null, after: TestOutcome): TestComparison | null {
  if (!baseline || baseline.kind !== "failed") return null;
  if (after.kind !== "failed") return { baseline, mode: "cleared", fresh: [], existing: [] };
  if (after.step === baseline.step && !after.timedOut && !baseline.timedOut && after.failedIds && baseline.failedIds) {
    const before = new Set(baseline.failedIds);
    return { baseline, mode: "ids", fresh: after.failedIds.filter((id) => !before.has(id)), existing: after.failedIds.filter((id) => before.has(id)) };
  }
  return { baseline, mode: "exit", fresh: [], existing: [] };
}

export function isRegression(tests: TestOutcome, comparison: TestComparison | null): boolean {
  if (tests.kind !== "failed") return false;
  if (comparison?.mode === "ids") return comparison.fresh.length > 0;
  return true;
}
