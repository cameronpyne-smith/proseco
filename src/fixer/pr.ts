import { compareVersions, isMajorUpgrade } from "../core/versions.ts";
import type { PackageCheck } from "./check.ts";
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
  releases: ReleaseNotes | null;
  codeChanged: boolean;
  forcedMajors: ForcedMajor[];
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
    ...testSection(input.tests),
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

function ranSection(tests: TestOutcome): string[] {
  const output = tests.tail.trim() === "" ? [] : ["", "<details>", "<summary>Output</summary>", "", fence(tailOf(tests.tail)), "", "</details>"];
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
    ...ranSection(input.tests),
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
