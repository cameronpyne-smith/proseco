import { dirname } from "node:path/posix";
import type { Advisory } from "./advisories.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";
import type { PrUnit } from "./plan.ts";

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
  rows: RowFacts[];
}

export interface UnitFacts {
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
  advisory: (cve: string, pkg: string) => Promise<Advisory | null>,
): Promise<UnitFacts> {
  const fixes: FixFacts[] = [];
  for (const fix of unit.fixes) {
    const rows: RowFacts[] = [];
    for (const row of fix.rows) {
      rows.push({ cve: row.cve, severity: row.severity, fixedIn: row.fixedIn, advisory: await advisory(row.cve, row.package) });
    }
    fixes.push({
      package: fix.package,
      installed: fix.installed,
      target: fix.target,
      severity: fix.severity,
      chain: ecosystem.parentChain(lockfileText, fix.package, fix.installed),
      rows,
    });
  }
  return { lockfile: unit.source, directory: dirname(unit.source), ecosystem: ecosystem.name, toolchain, fixes };
}
