import type { PackageCheck } from "./check.ts";

const MAX_DISCARDED = 20;
const MAX_TAIL_CHARS = 4000;

export interface PrFix {
  package: string;
  installed: string;
  target: string[];
  rows: { cve: string; severity: string }[];
}

export type TestOutcome =
  | { kind: "passed"; tail: string }
  | { kind: "no-tests"; tail: string }
  | { kind: "failed"; step: "npm ci" | "npm test"; exitCode: number; timedOut: boolean; tail: string };

export interface PrBodyInput {
  org: string;
  ticketsRepo: string;
  ticket: number;
  lockfile: string;
  fixes: PrFix[];
  summary: string;
  checks: PackageCheck[];
  tests: TestOutcome;
  discarded: string[];
}

export function commitMessage(lockfile: string, fixes: PrFix[]): string {
  const [only] = fixes;
  if (fixes.length === 1 && only) return `Bump ${only.package} to ${only.target.join(" or ")}`;
  return `Fix ${fixes.length} vulnerable packages in ${lockfile}`;
}

export function summariseDiscarded(paths: string[]): string[] {
  const collapsed = paths.map((path) => {
    const index = path.split("/").indexOf("node_modules");
    return index === -1 ? path : `${path.split("/").slice(0, index + 1).join("/")}/`;
  });
  return [...new Set(collapsed)];
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_TAIL_CHARS ? trimmed : `…${trimmed.slice(-MAX_TAIL_CHARS)}`;
}

function testSection(tests: TestOutcome): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
  switch (tests.kind) {
    case "passed":
      return ["- `npm ci` and `npm test` passed in the sandbox.", ...output];
    case "no-tests":
      return ["- `npm ci` passed in the sandbox; the project has no test script, so nothing else was run.", ...output];
    case "failed":
      return [
        `- Draft: \`${tests.step}\` ${tests.timedOut ? "timed out" : `failed with exit code ${tests.exitCode}`} in the sandbox. A person needs to look before this can merge.`,
        ...output,
      ];
  }
}

export function renderPrBody(input: PrBodyInput): string {
  const rows = input.fixes.map((fix) => {
    const findings = fix.rows.map((row) => `${row.cve} (${row.severity})`).join("<br>");
    return `| \`${cell(fix.package)}\` | ${cell(`${fix.installed} → ${fix.target.join(" or ")}`)} | ${findings} |`;
  });
  const lines = [
    `Updates vulnerable packages in \`${input.lockfile}\`.`,
    "",
    "| Package | Change | Findings |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "### Summary",
    "",
    input.summary.trim() === "" ? "_No claim in the agent's summary is supported by the diff._" : input.summary.trim(),
    "",
    "### Checks",
    "",
    ...input.checks.map((check) => `- Lockfile: ${check.package}: ${check.reason}.`),
    ...testSection(input.tests),
  ];
  if (input.discarded.length > 0) {
    const shown = input.discarded.slice(0, MAX_DISCARDED);
    lines.push("", "### Changes not committed", "", "The agent also changed these paths. They are outside the lockfile's manifest and lockfiles, so they were discarded and are not part of this pull request:", "", ...shown.map((path) => `- \`${path}\``));
    if (input.discarded.length > MAX_DISCARDED) lines.push("", `and ${input.discarded.length - MAX_DISCARDED} more`);
  }
  lines.push("", `Part of ${input.org}/${input.ticketsRepo}#${input.ticket}`, "");
  return lines.join("\n");
}
