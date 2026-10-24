import { compareText, fixesFor } from "../core/findings.ts";
import type { TicketRow } from "../core/ticket.ts";
import type { Enrichment, Finding, Severity } from "../core/types.ts";
import { ecosystemFor, type EcosystemName } from "./ecosystems/ecosystem.ts";

export interface PlannedFix {
  package: string;
  installed: string;
  target: string[];
  severity: Severity;
  rows: TicketRow[];
}

export interface PrUnit {
  kind: "lockfile" | "major";
  source: string;
  ecosystem: EcosystemName | null;
  branch: string;
  fixes: PlannedFix[];
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function refSafe(text: string): string {
  return slug(text).replace(/\.lock$/, "-lock");
}

function findingOf(row: TicketRow): Finding {
  return {
    origin: "dependabot",
    repo: null,
    cve: row.cve,
    severity: row.severity,
    ecosystem: ecosystemFor(row.source)?.findingEcosystem ?? null,
    package: row.package,
    installed: row.installed,
    fixedIn: row.fixedIn,
    source: row.source,
    relationship: null,
    scope: null,
    imageKey: null,
  };
}

export function planUnits(rows: TicketRow[], org: string): PrUnit[] {
  const rowByFinding = new Map<Finding, TicketRow>();
  const findings = rows.map((row) => {
    const finding = findingOf(row);
    rowByFinding.set(finding, row);
    return finding;
  });
  const enrichment: Enrichment = {
    epss: new Map(rows.flatMap((row) => (row.epssPercent === null ? [] : [[row.cve, row.epssPercent / 100] as [string, number]]))),
    kev: new Set(rows.filter((row) => row.kev).map((row) => row.cve)),
  };
  const planned = fixesFor(findings, enrichment, org).map((fix) => ({
    major: fix.majorUpgrade === true,
    source: fix.source,
    fix: {
      package: fix.package,
      installed: fix.installed,
      target: fix.target,
      severity: fix.severity,
      rows: fix.findings.map((finding) => rowByFinding.get(finding)!),
    } satisfies PlannedFix,
  }));

  const lockfileUnits = [...new Set(planned.filter((item) => !item.major).map((item) => item.source))]
    .sort(compareText)
    .map((source): PrUnit => ({
      kind: "lockfile",
      source,
      ecosystem: ecosystemFor(source)?.name ?? null,
      branch: `proseco/${refSafe(source)}`,
      fixes: planned.filter((item) => !item.major && item.source === source).map((item) => item.fix),
    }));

  const majors = planned.filter((item) => item.major);
  const base = (item: (typeof majors)[number]) => refSafe(`${item.fix.package}-${item.fix.target[0]}`);
  const majorUnits = majors.map((item): PrUnit => {
    const shared = majors.filter((other) => base(other) === base(item)).length > 1;
    const name = shared ? `${base(item)}-${refSafe(item.source)}-${refSafe(item.fix.installed)}` : base(item);
    return {
      kind: "major",
      source: item.source,
      ecosystem: ecosystemFor(item.source)?.name ?? null,
      branch: `proseco/${name}`,
      fixes: [item.fix],
    };
  });
  return [...lockfileUnits, ...majorUnits];
}
