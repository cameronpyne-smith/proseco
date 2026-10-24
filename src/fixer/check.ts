import { compareVersions, packageKey } from "../core/versions.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";

export interface CheckedFix {
  package: string;
  target: string[];
}

export interface PackageCheck {
  package: string;
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

function checkOne(installedVersions: Map<string, string[]>, ecosystemName: string, fix: CheckedFix): PackageCheck {
  const installed = installedVersions.get(packageKey(ecosystemName, fix.package)) ?? [];
  const fail = (reason: string): PackageCheck => ({ package: fix.package, installed, ok: false, reason });
  if (fix.target.length === 0) return fail("the ticket names no target version");
  const target = lowest(fix.target);
  if (target === null) return fail(`cannot compare the target versions ${fix.target.join(", ")}`);
  if (installed.length === 0) return { package: fix.package, installed, ok: true, reason: "absent from the lockfile" };
  for (const version of installed) {
    const order = compareVersions(version, target);
    if (order === null) return fail(`cannot compare installed ${version} with ${target}`);
    if (order < 0) return fail(`installed ${version} is below ${target}`);
  }
  return { package: fix.package, installed, ok: true, reason: `installed ${installed.join(", ")} is at or above ${target}` };
}

export function checkLockfile(ecosystem: Pick<Ecosystem, "installedVersions" | "findingEcosystem">, lockfileText: string, fixes: CheckedFix[]): PackageCheck[] {
  const installed = ecosystem.installedVersions(lockfileText);
  return fixes.map((fix) => checkOne(installed, ecosystem.findingEcosystem, fix));
}

export function checkPassed(results: PackageCheck[]): boolean {
  return results.every((result) => result.ok);
}
