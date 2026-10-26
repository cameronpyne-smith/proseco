import { packageKey } from "../core/versions.ts";
import { checkLockfile, type CheckedFix, type PackageCheck } from "./check.ts";
import type { Ecosystem, LockfileChange } from "./ecosystems/ecosystem.ts";

const MAX_CHANGES = 60;

export function changesOf(ecosystem: Ecosystem, before: string, after: string): LockfileChange[] {
  if (ecosystem.changes) return ecosystem.changes(before, after);
  const was = ecosystem.installedVersions(before);
  const now = ecosystem.installedVersions(after);
  const changes: LockfileChange[] = [];
  for (const name of new Set([...was.keys(), ...now.keys()])) {
    const from = was.get(name)?.join(", ") ?? null;
    const to = now.get(name)?.join(", ") ?? null;
    if (from !== to) changes.push({ path: name, name, from, to });
  }
  return changes;
}

function describe(change: LockfileChange): string {
  if (change.from === null) return `+ ${change.path} ${change.to}`;
  if (change.to === null) return `- ${change.path} ${change.from}`;
  return `~ ${change.path} ${change.from} → ${change.to}`;
}

export function lockfileStatus(ecosystem: Ecosystem, lockfile: string, fixes: CheckedFix[], before: string, after: string, filter?: string): string {
  const key = (name: string) => packageKey(ecosystem.findingEcosystem, name);
  const wanted = filter ? key(filter) : null;
  const checks = checkLockfile(ecosystem, after, fixes).filter((check) => wanted === null || key(check.package) === wanted);
  const target = (check: PackageCheck) => fixes.find((fix) => fix.package === check.package && (check.from === undefined || fix.installed === check.from))?.target.join(" or ") ?? "unknown";
  const lines = [`Lockfile status, read by the host from your current ${lockfile}:`, "", "Fix checks:"];
  if (checks.length === 0) lines.push(filter ? `- no fix for ${filter} in this unit` : "- none");
  for (const check of checks) {
    const copies = ecosystem.copiesOf?.(after, check.package).filter((copy) => check.installed.includes(copy.version)) ?? [];
    const where = copies.length > 0 ? copies.map((copy) => `${copy.version} at ${copy.where}`).join("; ") : check.installed.join(", ") || "none";
    lines.push(`- ${check.package}: ${check.ok ? "ok" : "FAILING"}, ${check.reason}. Target: ${target(check)}. Copies: ${where}`);
  }
  const fixNames = new Set(fixes.map((fix) => key(fix.package)));
  const all = changesOf(ecosystem, before, after).filter((change) => wanted === null || key(change.name) === wanted);
  const added = all.filter((change) => change.from === null).length;
  const removed = all.filter((change) => change.to === null).length;
  const sorted = [...all].sort((a, b) => Number(fixNames.has(key(b.name))) - Number(fixNames.has(key(a.name))) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  lines.push("", `Changes against the default branch: ${all.length} (${added} added, ${removed} removed, ${all.length - added - removed} changed)${all.length > 0 ? ", the fix packages first" : ""}:`);
  if (all.length === 0) lines.push("- none");
  lines.push(...sorted.slice(0, MAX_CHANGES).map(describe));
  if (sorted.length > MAX_CHANGES) lines.push(`... and ${sorted.length - MAX_CHANGES} more`);
  return lines.join("\n");
}
