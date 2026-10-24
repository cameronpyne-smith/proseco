import type { PackageCheck } from "./check.ts";

const MAX_DISCARDED = 20;
const MAX_TAIL_CHARS = 4000;
const NOISE = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache"]);

export interface PrFix {
  package: string;
  installed: string;
  target: string[];
  rows: { cve: string; severity: string }[];
}

export type TestOutcome =
  | { kind: "passed"; commands: string[]; tail: string }
  | { kind: "no-tests"; commands: string[]; tail: string }
  | { kind: "failed"; step: string; exitCode: number; timedOut: boolean; tail: string };

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

export interface MajorPrBodyInput {
  org: string;
  ticketsRepo: string;
  ticket: number;
  lockfile: string;
  fix: PrFix;
  releaseTags: string[];
  summary: string;
  checks: PackageCheck[];
  tests: TestOutcome;
  discarded: string[];
}

export function majorTitle(fix: PrFix): string {
  return `Upgrade ${fix.package} to ${fix.target.join(" or ")} (major)`;
}

export function commitMessage(lockfile: string, fixes: PrFix[]): string {
  const [only] = fixes;
  if (fixes.length === 1 && only) return `Bump ${only.package} to ${only.target.join(" or ")}`;
  return `Fix ${fixes.length} vulnerable packages in ${lockfile}`;
}

export function summariseDiscarded(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => !path.split("/").some((part) => NOISE.has(part))))];
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

function discardedSection(discarded: string[], reason: string): string[] {
  if (discarded.length === 0) return [];
  const lines = ["", "### Changes not committed", "", `The agent also changed these paths. ${reason}`, "", ...discarded.slice(0, MAX_DISCARDED).map((path) => `- \`${path}\``)];
  if (discarded.length > MAX_DISCARDED) lines.push("", `and ${discarded.length - MAX_DISCARDED} more`);
  return lines;
}

function packageRow(fix: PrFix): string {
  const findings = fix.rows.map((row) => `${row.cve} (${row.severity})`).join("<br>");
  return `| \`${cell(fix.package)}\` | ${cell(`${fix.installed} → ${fix.target.join(" or ")}`)} | ${findings} |`;
}

function testSection(tests: TestOutcome): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
  switch (tests.kind) {
    case "passed":
      return [`- ${tests.commands.map((command) => `\`${command}\``).join(" and ")} passed in the sandbox.`, ...output];
    case "no-tests":
      return [`- ${tests.commands.map((command) => `\`${command}\``).join(" and ")} passed in the sandbox; the project has no tests the fixer can run, so nothing else was run.`, ...output];
    case "failed":
      return [
        `- Draft: \`${tests.step}\` ${tests.timedOut ? "timed out" : `failed with exit code ${tests.exitCode}`} in the sandbox. A person needs to look before this can merge.`,
        ...output,
      ];
  }
}

export function renderPrBody(input: PrBodyInput): string {
  const rows = input.fixes.map(packageRow);
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
  lines.push(...discardedSection(input.discarded, "They are outside the lockfile's manifest and lockfiles, so they were discarded and are not part of this pull request:"));
  lines.push("", `Part of ${input.org}/${input.ticketsRepo}#${input.ticket}`, "");
  return lines.join("\n");
}

function ranSection(tests: TestOutcome): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
  const commands = tests.kind === "failed" ? "" : tests.commands.map((command) => `\`${command}\``).join(" and ");
  switch (tests.kind) {
    case "passed":
      return [`- ${commands} ran in the sandbox and exited 0.`, ...output];
    case "no-tests":
      return [`- ${commands} ran in the sandbox and exited 0; the project has no tests the fixer can run, so nothing else ran.`, ...output];
    case "failed":
      return [`- \`${tests.step}\` ${tests.timedOut ? "timed out" : `failed with exit code ${tests.exitCode}`} in the sandbox.`, ...output];
  }
}

export function renderMajorPrBody(input: MajorPrBodyInput): string {
  const target = input.fix.target.join(" or ");
  const lines = [
    `Upgrades \`${input.fix.package}\` across a major version in \`${input.lockfile}\`.`,
    "",
    "| Package | Change | Findings |",
    "| --- | --- | --- |",
    packageRow(input.fix),
    "",
    "### Breaking changes considered",
    "",
    ...(input.releaseTags.length === 0 ? ["_No release notes were found for this version range._"] : input.releaseTags.map((tag) => `- \`${tag}\``)),
    "",
    "### Summary",
    "",
    input.summary.trim() === "" ? "_No claim in the agent's summary is supported by the diff._" : input.summary.trim(),
    "",
    "### Checks",
    "",
    ...input.checks.map((check) => `- Lockfile: ${check.package}: ${check.reason}.`),
    ...ranSection(input.tests),
    ...discardedSection(input.discarded, "They are on the list of paths the fixer never commits (workflows, installed packages, other ecosystems' files, package-manager configuration such as `.npmrc`, large new binaries), so they were discarded and are not part of this pull request:"),
    "",
    "### Why this is a draft",
    "",
    `The upgrade from ${input.fix.installed} to ${target} crosses a major version, and the agent changed code to adapt to it. A person must confirm the change is correct and complete before this pull request can merge, whatever the sandbox run reported.`,
    "",
    `Part of ${input.org}/${input.ticketsRepo}#${input.ticket}`,
    "",
  ];
  return lines.join("\n");
}
