import { dirname } from "node:path/posix";
import type { Advisory } from "./advisories.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";
import type { PrUnit } from "./plan.ts";
import type { ReleaseNotes } from "./releases.ts";

export interface RowFacts {
  cve: string;
  severity: string;
  fixedIn: string | null;
  advisory: Advisory | null;
}

export interface FixFacts {
  package: string;
  installed: string;
  target: string[];
  severity: string;
  chain: string[] | null;
  releases: ReleaseNotes | null;
  rows: RowFacts[];
}

export interface UnitFacts {
  kind: PrUnit["kind"];
  lockfile: string;
  directory: string;
  ecosystem: string;
  toolchain: string | null;
  fixes: FixFacts[];
}

export async function buildFacts(
  unit: PrUnit,
  ecosystem: Ecosystem,
  lockfileText: string,
  toolchain: string | null,
  advisory: (cve: string, pkg: string, installed?: string) => Promise<Advisory | null>,
  releases?: (ecosystem: string, pkg: string, installed: string, target: string) => Promise<ReleaseNotes>,
): Promise<UnitFacts> {
  const fixes: FixFacts[] = [];
  for (const fix of unit.fixes) {
    const rows: RowFacts[] = [];
    for (const row of fix.rows) {
      rows.push({ cve: row.cve, severity: row.severity, fixedIn: row.fixedIn, advisory: await advisory(row.cve, row.package, row.installed) });
    }
    fixes.push({
      package: fix.package,
      installed: fix.installed,
      target: fix.target,
      severity: fix.severity,
      chain: ecosystem.parentChain(lockfileText, fix.package, fix.installed),
      releases: unit.kind === "major" && releases && fix.target[0] ? await releases(ecosystem.findingEcosystem, fix.package, fix.installed, fix.target[0]) : null,
      rows,
    });
  }
  return { kind: unit.kind, lockfile: unit.source, directory: dirname(unit.source), ecosystem: ecosystem.name, toolchain, fixes };
}
