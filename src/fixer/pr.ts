import { compareVersions, isMajorUpgrade } from "../core/versions.ts";
import { failureExcerpt } from "./excerpt.ts";
import { isRegression, type TestComparison } from "./baseline.ts";
import type { PackageCheck } from "./check.ts";
import type { Verification } from "./ecosystems/ecosystem.ts";
import type { ForcedMajor } from "./majors.ts";
import { versionOf, type ReleaseNote, type ReleaseNotes } from "./releases.ts";

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
  | { kind: "failed"; step: string; exitCode: number; timedOut: boolean; tail: string; failedIds?: string[] };

export interface PrBodyInput {
  org: string;
  ticketsRepo: string;
  ticket: number;
  lockfile: string;
  fixes: PrFix[];
  summary: string;
  checks: PackageCheck[];
  tests: TestOutcome;
  comparison?: TestComparison | null;
  verification?: Verification | null;
  discarded: string[];
}

export interface MajorPrBodyInput {
  org: string;
  ticketsRepo: string;
  ticket: number;
  lockfile: string;
  fix: PrFix;
  releases: ReleaseNotes | null;
  codeChanged: boolean;
  forcedMajors: ForcedMajor[];
  highRisk?: string[];
  summary: string;
  checks: PackageCheck[];
  tests: TestOutcome;
  comparison?: TestComparison | null;
  verification?: Verification | null;
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
  return failureExcerpt(text, MAX_TAIL_CHARS);
}

function discardedSection(discarded: string[], reason: string): string[] {
  if (discarded.length === 0) return [];
  const lines = ["", "### Changes not committed", "", `The agent also changed these paths. ${reason}`, "", ...discarded.slice(0, MAX_DISCARDED).map((path) => `- \`${path}\``)];
  if (discarded.length > MAX_DISCARDED) lines.push("", `and ${discarded.length - MAX_DISCARDED} more`);
  return lines;
}

function changeOf(fix: PrFix, checks: PackageCheck[]): string {
  const target = fix.target.join(" or ");
  const now = (checks.find((check) => check.package === fix.package && check.from === fix.installed) ?? checks.find((check) => check.package === fix.package && check.from === undefined))?.installed ?? [];
  if (now.length === 0) return `${fix.installed} → ${target}`;
  const reached = now.join(", ");
  return reached === target ? `${fix.installed} → ${reached}` : `${fix.installed} → ${reached} (fix needs ${target})`;
}

function packageRow(fix: PrFix, checks: PackageCheck[]): string {
  const findings = fix.rows.map((row) => `${row.cve} (${row.severity})`).join("<br>");
  return `| \`${cell(fix.package)}\` | ${cell(changeOf(fix, checks))} | ${findings} |`;
}

const MAX_IDS = 30;

function idList(ids: string[]): string[] {
  return [...ids.slice(0, MAX_IDS).map((id) => `  - \`${id}\``), ...(ids.length > MAX_IDS ? [`  - and ${ids.length - MAX_IDS} more`] : [])];
}

function baselineOutput(comparison: TestComparison): string[] {
  const tail = comparison.baseline.tail.trim();
  return tail === "" ? [] : ["", "<details>", "<summary>Output on the default branch</summary>", "", fence(tailOf(tail)), "", "</details>"];
}

function failedAgainstBaseline(tests: Extract<TestOutcome, { kind: "failed" }>, comparison: TestComparison, output: string[], draftPrefix: string): string[] {
  const what = `\`${tests.step}\` ${tests.timedOut ? "timed out" : `failed with exit code ${tests.exitCode}`}`;
  if (comparison.mode === "ids") {
    const known = comparison.existing.length === 0 ? [] : [`- ${comparison.existing.length} failing test${comparison.existing.length === 1 ? "" : "s"} also fail${comparison.existing.length === 1 ? "s" : ""} on the default branch, so this change did not cause ${comparison.existing.length === 1 ? "it" : "them"}:`, ...idList(comparison.existing)];
    if (comparison.fresh.length === 0) return [`- ${what} in the sandbox, but every failing test also fails on the default branch.`, ...known, ...output];
    return [`- ${draftPrefix}${what} in the sandbox with ${comparison.fresh.length} new failing test${comparison.fresh.length === 1 ? "" : "s"}, which pass on the default branch:`, ...idList(comparison.fresh), ...known, ...output];
  }
  const before = comparison.baseline;
  if (before.step !== tests.step) {
    return [`- ${draftPrefix}${what} in the sandbox. On the default branch the run got as far as \`${before.step}\`, which failed with exit code ${before.exitCode}.`, ...output, ...baselineOutput(comparison)];
  }
  return [
    `- ${draftPrefix}${what} in the sandbox, and \`${before.step}\` also ${before.timedOut ? "timed out" : `fails with exit code ${before.exitCode}`} on the default branch. The failing tests could not be compared one by one, so a person needs to check that this change adds no new failure.`,
    ...output,
    ...baselineOutput(comparison),
  ];
}

function clearedLine(comparison: TestComparison | null | undefined): string[] {
  return comparison?.mode === "cleared" ? [`- \`${comparison.baseline.step}\` fails on the default branch in the sandbox but passes with this change.`] : [];
}

function testSection(tests: TestOutcome, comparison?: TestComparison | null): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
  if (tests.kind === "failed" && comparison && comparison.mode !== "cleared") {
    return failedAgainstBaseline(tests, comparison, output, isRegression(tests, comparison) ? "Draft: " : "");
  }
  return [...clearedLine(comparison), ...testSectionPlain(tests, output)];
}

function testSectionPlain(tests: TestOutcome, output: string[]): string[] {
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
  const rows = input.fixes.map((fix) => packageRow(fix, input.checks));
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
    ...verificationLines(input.verification),
    ...testSection(input.tests, input.comparison),
  ];
  lines.push(...discardedSection(input.discarded, "They are outside the lockfile's manifest and lockfiles, so they were discarded and are not part of this pull request:"));
  lines.push("", `Part of ${input.org}/${input.ticketsRepo}#${input.ticket}`, "");
  return lines.join("\n");
}

export function breakingReleases(pkg: string, installed: string, releases: ReleaseNote[]): ReleaseNote[] {
  const stable = releases
    .map((release) => ({ release, version: versionOf(release.tag, pkg) }))
    .filter(({ version }) => /^\d+(\.\d+)*$/.test(version))
    .sort((a, b) => compareVersions(a.version, b.version) ?? 0);
  const picked: ReleaseNote[] = [];
  let previous = installed;
  for (const { release, version } of stable) {
    if (isMajorUpgrade(previous, [version]) || /breaking/i.test(`${release.name}\n${release.body}`)) picked.push(release);
    previous = version;
  }
  return picked.reverse();
}

function releasesSection(fix: PrFix, notes: ReleaseNotes | null): string[] {
  if (!notes || notes.releases.length === 0 || !notes.repository) return ["_No release notes were found for this version range._"];
  const base = `https://github.com/${notes.repository}/releases`;
  const picked = breakingReleases(fix.package, fix.installed, notes.releases);
  const count = notes.releases.length;
  return [
    `The agent was given the notes of ${count} release${count === 1 ? "" : "s"} of \`${notes.repository}\` after ${fix.installed}, up to ${fix.target.join(" or ")}. ${
      picked.length === 0 ? "None of them starts a new major version or mentions breaking changes." : "These start a new major version or mention breaking changes:"
    }`,
    ...(picked.length === 0 ? [] : ["", ...picked.map((release) => `- [\`${release.tag}\`](${base}/tag/${encodeURIComponent(release.tag)})`)]),
    "",
    `All release notes: ${base}`,
  ];
}

function verificationLines(verification: Verification | null | undefined): string[] {
  if (!verification) return [];
  return [verification.outcome === "ok" ? `- Resolver check: ${verification.text}.` : `- Draft: the lockfile was not verified against the resolver: ${verification.text}. A person needs to check it before this can merge.`];
}

function highRiskSection(paths: string[]): string[] {
  if (paths.length === 0) return [];
  return [
    "### High-risk paths changed",
    "",
    "The agent changed files that run code outside the dependency upgrade itself (build, container, CI or script files, or `scripts` in a manifest). Read these changes first:",
    "",
    ...paths.slice(0, MAX_DISCARDED).map((path) => `- \`${path}\``),
    ...(paths.length > MAX_DISCARDED ? [`- and ${paths.length - MAX_DISCARDED} more`] : []),
    "",
  ];
}

function forcedMajorsSection(forced: ForcedMajor[]): string[] {
  if (forced.length === 0) return [];
  return [
    "### Other major upgrades",
    "",
    "These direct dependencies also crossed a major version because of this upgrade. Their breaking changes must be checked too, not only those of the upgraded package:",
    "",
    ...forced.map((item) => `- \`${item.package}\` ${item.from} → ${item.to}${item.repository ? ` ([releases](https://github.com/${item.repository}/releases))` : ""}`),
    "",
  ];
}

function ranSection(tests: TestOutcome, comparison?: TestComparison | null): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
  if (tests.kind === "failed" && comparison && comparison.mode !== "cleared") return failedAgainstBaseline(tests, comparison, output, "");
  return [...clearedLine(comparison), ...ranSectionPlain(tests, output)];
}

function ranSectionPlain(tests: TestOutcome, output: string[]): string[] {
  const commands = tests.kind === "failed" ? "" : tests.commands.map((command) => `\`${command}\``).join(" and ");
  switch (tests.kind) {
    case "passed":
      return [`- ${commands} ran in the sandbox and exited 0.`, ...output];
    case "no-tests":
      return [
        `- ${commands} ran in the sandbox and exited 0; the project has no tests the fixer can run, so nothing else ran.`,
        "- **Untested:** nothing here shows that the upgraded code works. A build that passes can still fail when the code runs, so a person must run the project before this can merge.",
        ...output,
      ];
    case "failed":
      return [`- \`${tests.step}\` ${tests.timedOut ? "timed out" : `failed with exit code ${tests.exitCode}`} in the sandbox.`, ...output];
  }
}

export function renderMajorPrBody(input: MajorPrBodyInput): string {
  const target = input.fix.target.join(" or ");
  const lines = [
    `Upgrades \`${input.fix.package}\` across a major version in \`${input.lockfile}\`.`,
    "",
    ...highRiskSection(input.highRisk ?? []),
    "| Package | Change | Findings |",
    "| --- | --- | --- |",
    packageRow(input.fix, input.checks),
    "",
    "### Breaking changes considered",
    "",
    ...releasesSection(input.fix, input.releases),
    "",
    ...forcedMajorsSection(input.forcedMajors),
    "### Summary",
    "",
    input.summary.trim() === "" ? "_No claim in the agent's summary is supported by the diff._" : input.summary.trim(),
    "",
    "### Checks",
    "",
    ...input.checks.map((check) => `- Lockfile: ${check.package}: ${check.reason}.`),
    ...verificationLines(input.verification),
    ...ranSection(input.tests, input.comparison),
    ...discardedSection(input.discarded, "They are on the list of paths the fixer never commits (workflows, installed packages, other ecosystems' files, package-manager configuration such as `.npmrc`, new files that a command created rather than the agent, such as build output), so they were discarded and are not part of this pull request:"),
    "",
    "### Why this is a draft",
    "",
    input.codeChanged
      ? `The upgrade from ${input.fix.installed} to ${target} crosses a major version, and the agent changed code to adapt to it. A person must confirm the change is correct and complete before this pull request can merge, whatever the sandbox run reported.`
      : `The upgrade from ${input.fix.installed} to ${target} crosses a major version. The agent changed only the manifest and lockfile, but a person must confirm nothing else needs to change before this pull request can merge, whatever the sandbox run reported.`,
    "",
    `Part of ${input.org}/${input.ticketsRepo}#${input.ticket}`,
    "",
  ];
  return lines.join("\n");
}
