import type { Enrichment, Finding, Severity } from "./types.ts";
import { highestVersion, isMajorUpgrade, packageKey } from "./versions.ts";

export const UNMAPPED_KEY = "unmapped";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface Fix {
  package: string;
  installed: string;
  source: string;
  target: string[];
  majorUpgrade: boolean | null;
  relationship: string;
  scope: string;
  severity: Severity;
  epss: number | null;
  kev: boolean;
  findings: Finding[];
  alertsUrl: string | null;
}

export function keyOf(finding: Finding): string {
  return finding.imageKey ?? finding.repo ?? UNMAPPED_KEY;
}

export function qualifies(finding: Finding): boolean {
  return (finding.severity === "critical" || finding.severity === "high") && !!finding.fixedIn;
}

export function groupFindings(findings: Finding[]): Map<string, Finding[]> {
  const seen = new Set<string>();
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!qualifies(finding)) continue;
    const key = keyOf(finding);
    const identity = JSON.stringify([key, finding.cve, finding.package, finding.installed, finding.source]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  return groups;
}

export function epssPercent(finding: Finding, enrichment: Enrichment): number | null {
  const score = enrichment.epss.get(finding.cve);
  return score === undefined ? null : Math.round(score * 1000) / 10;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortFindings(findings: Finding[], enrichment: Enrichment): Finding[] {
  return [...findings].sort((a, b) => {
    const kev = Number(enrichment.kev.has(b.cve)) - Number(enrichment.kev.has(a.cve));
    if (kev !== 0) return kev;
    const epssA = epssPercent(a, enrichment) ?? -1;
    const epssB = epssPercent(b, enrichment) ?? -1;
    if (epssA !== epssB) return epssB - epssA;
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    return (
      compareText(a.cve, b.cve) ||
      compareText(a.package, b.package) ||
      compareText(a.installed, b.installed) ||
      compareText(a.source, b.source)
    );
  });
}

function distinctText(values: (string | null)[]): string {
  const known = [...new Set(values.filter((value): value is string => !!value))].sort(compareText);
  return known.length > 0 ? known.join(", ") : "unknown";
}

function alertsUrl(finding: Finding, org: string): string | null {
  if (finding.origin !== "dependabot" || !finding.repo) return null;
  const query = `is:open package:${finding.package} manifest:${finding.source}`;
  return `https://github.com/${org}/${finding.repo}/security/dependabot?q=${encodeURIComponent(query)}`;
}

export function fixesFor(findings: Finding[], enrichment: Enrichment, org: string): Fix[] {
  const byFix = new Map<string, Finding[]>();
  for (const finding of findings) {
    const identity = JSON.stringify([finding.ecosystem, packageKey(finding.ecosystem, finding.package), finding.installed, finding.source]);
    byFix.set(identity, [...(byFix.get(identity) ?? []), finding]);
  }
  const fixes = [...byFix.values()].map((group): Fix => {
    const sorted = sortFindings(group, enrichment);
    const scores = group.map((finding) => epssPercent(finding, enrichment)).filter((score) => score !== null);
    const target = highestVersion(group.map((finding) => finding.fixedIn ?? "").filter(Boolean));
    const named = [...group].sort((a, b) => compareText(a.package, b.package))[0]!;
    return {
      package: named.package,
      installed: named.installed,
      source: named.source,
      target,
      majorUpgrade: isMajorUpgrade(named.installed, target),
      relationship: distinctText(group.map((finding) => finding.relationship)),
      scope: distinctText(group.map((finding) => finding.scope)),
      severity: group.map((finding) => finding.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0]!,
      epss: scores.length > 0 ? Math.max(...scores) : null,
      kev: group.some((finding) => enrichment.kev.has(finding.cve)),
      findings: sorted,
      alertsUrl: alertsUrl(named, org),
    };
  });
  return fixes.sort(
    (a, b) =>
      Number(b.kev) - Number(a.kev) ||
      (b.epss ?? -1) - (a.epss ?? -1) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareText(a.package, b.package) ||
      compareText(a.installed, b.installed) ||
      compareText(a.source, b.source),
  );
}
