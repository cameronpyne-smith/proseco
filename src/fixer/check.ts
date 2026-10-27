import { compareVersions, inRange, isMajorUpgrade, packageKey } from "../core/versions.ts";
import type { Advisory } from "./advisories.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";

export interface CheckedFix {
  package: string;
  target: string[];
  installed?: string;
  vulnerable?: string[] | null;
}

export interface PackageCheck {
  package: string;
  from?: string;
  installed: string[];
  ok: boolean;
  reason: string;
}

function lowest(versions: string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (best === null) best = version;
    else {
      const order = compareVersions(version, best);
      if (order === null) return null;
      if (order < 0) best = version;
    }
  }
  return best;
}

function sameLine(a: string, b: string): boolean {
  return isMajorUpgrade(a, [b]) === false;
}

function highest(versions: string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (best === null) best = version;
    else {
      const order = compareVersions(version, best);
      if (order === null) return null;
      if (order > 0) best = version;
    }
  }
  return best;
}

function belongs(copy: string, fix: CheckedFix): boolean {
  return [...(fix.installed === undefined ? [] : [fix.installed]), ...fix.target].some((version) => sameLine(copy, version));
}

function judge(copy: string, targets: string[], ceiling: string | null): string | null {
  const own = targets.filter((target) => sameLine(copy, target));
  const wanted = lowest(own);
  if (own.length > 0 && wanted === null) return `cannot compare installed ${copy} with ${own.join(", ")}`;
  if (wanted !== null) {
    const order = compareVersions(copy, wanted);
    if (order === null) return `cannot compare installed ${copy} with ${wanted}`;
    if (order >= 0) return null;
  }
  if (ceiling !== null) {
    const order = compareVersions(copy, ceiling);
    if (order === null) return `cannot compare installed ${copy} with ${ceiling}`;
    if (order >= 0) return null;
  }
  return `installed ${copy} is below ${wanted ?? ceiling ?? "the target"}`;
}

function neverVulnerable(copy: string, siblings: CheckedFix[]): boolean {
  if (siblings.length === 0 || siblings.some((sibling) => !sibling.vulnerable || sibling.vulnerable.length === 0)) return false;
  return !siblings.some((sibling) => sibling.vulnerable!.some((range) => inRange(copy, range)));
}

function checkOne(installedVersions: Map<string, string[]>, ecosystemName: string, absentIsFixed: boolean, fix: CheckedFix, siblings: CheckedFix[]): PackageCheck {
  const copies = installedVersions.get(packageKey(ecosystemName, fix.package)) ?? [];
  const from = fix.installed === undefined ? {} : { from: fix.installed };
  const fail = (installed: string[], reason: string): PackageCheck => ({ package: fix.package, ...from, installed, ok: false, reason });
  if (fix.target.length === 0) return fail(copies, "the ticket names no target version");
  const target = lowest(fix.target);
  if (target === null) return fail(copies, `cannot compare the target versions ${fix.target.join(", ")}`);
  if (copies.length === 0) {
    if (!absentIsFixed) return fail(copies, `the pin for ${fix.package} is gone: this file must keep the package pinned with ==`);
    return { package: fix.package, ...from, installed: copies, ok: true, reason: "absent from the lockfile" };
  }
  const claimed = (copy: string) => siblings.some((other) => belongs(copy, other));
  const mine = copies.filter((copy) => belongs(copy, fix) || !claimed(copy));
  const targets = siblings.flatMap((other) => other.target);
  const ceiling = highest(targets);
  for (const copy of mine) {
    if (neverVulnerable(copy, siblings)) continue;
    const problem = judge(copy, targets, ceiling);
    if (problem) return fail(mine, problem);
  }
  const shown = mine.length === 0 ? copies : mine;
  const wanted = lowest(fix.target.filter((item) => shown.every((copy) => sameLine(copy, item)))) ?? target;
  return { package: fix.package, ...from, installed: shown, ok: true, reason: `installed ${shown.join(", ")} is at or above ${wanted}` };
}

export function checkLockfile(ecosystem: Pick<Ecosystem, "installedVersions" | "findingEcosystem"> & { absentIsFixed?: boolean }, lockfileText: string, fixes: CheckedFix[]): PackageCheck[] {
  const installed = ecosystem.installedVersions(lockfileText);
  return fixes.map((fix) => checkOne(installed, ecosystem.findingEcosystem, ecosystem.absentIsFixed ?? true, fix, fixes.filter((other) => packageKey(ecosystem.findingEcosystem, other.package) === packageKey(ecosystem.findingEcosystem, fix.package))));
}

export function checkedFix(fix: { package: string; installed: string; target: string[] }, advisories: (Advisory | null)[]): CheckedFix {
  const ranges = advisories.map((advisory) => advisory?.vulnerableRange ?? null);
  const known = ranges.length > 0 && ranges.every((range) => range !== null);
  return { package: fix.package, installed: fix.installed, target: fix.target, vulnerable: known ? ranges.flatMap((range) => range!.split(" or ")) : null };
}

export function checkPassed(results: PackageCheck[]): boolean {
  return results.every((result) => result.ok);
}

export function alreadyFixed(ecosystem: Parameters<typeof checkLockfile>[0], lockfileText: string, fixes: CheckedFix[]): boolean {
  try {
    return checkPassed(checkLockfile(ecosystem, lockfileText, fixes));
  } catch {
    return false;
  }
}
