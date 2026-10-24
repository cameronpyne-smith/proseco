import { dirname } from "node:path/posix";
import type { TicketRow } from "../core/ticket.ts";
import type { Advisory } from "./advisories.ts";
import { ecosystemFor } from "./ecosystems/ecosystem.ts";
import { planUnits, type PrUnit } from "./plan.ts";
import { bodyHash, decide, type Attempt, type Decision } from "./state.ts";

export interface DryRunInput {
  ticket: { number: number; repo: string; body: string; force: boolean; commandCommentId: number | null };
  rows: TicketRow[];
  org: string;
  headSha: string;
  last: Attempt | undefined;
  readFile(path: string): Promise<string | null>;
  advisory(cve: string, pkg: string): Promise<Advisory | null>;
}

export interface DryRunReport {
  ticket: { number: number; repo: string; bodyHash: string; force: boolean; commandCommentId: number | null };
  headSha: string;
  openPullRequests: "not checked";
  decision: Decision;
  units: {
    kind: PrUnit["kind"];
    branch: string;
    source: string;
    ecosystem: string | null;
    lockfile: "read" | "missing at head" | "unsupported ecosystem";
    toolchain: string | null;
    fixes: {
      package: string;
      installed: string;
      target: string[];
      severity: string;
      chain: string[] | null;
      rows: { cve: string; severity: string; fixedIn: string | null; advisory: Advisory | null }[];
    }[];
  }[];
}

function sibling(lockfile: string, file: string): string {
  const directory = dirname(lockfile);
  return directory === "." ? file : `${directory}/${file}`;
}

export async function dryRunReport(input: DryRunInput): Promise<DryRunReport> {
  const hash = bodyHash(input.ticket.body);
  const units: DryRunReport["units"] = [];
  for (const unit of planUnits(input.rows, input.org)) {
    const ecosystem = ecosystemFor(unit.source);
    const lockfile = ecosystem ? await input.readFile(unit.source) : null;
    let toolchain: string | null = null;
    if (ecosystem) {
      const files: Record<string, string> = {};
      for (const file of ecosystem.toolchainFiles) {
        const beside = sibling(unit.source, file);
        const text = (await input.readFile(beside)) ?? (beside === file ? null : await input.readFile(file));
        if (text !== null) files[file] = text;
      }
      toolchain = ecosystem.toolchainVersion(files);
    }
    const fixes: DryRunReport["units"][number]["fixes"] = [];
    for (const fix of unit.fixes) {
      const rows = [];
      for (const row of fix.rows) {
        rows.push({ cve: row.cve, severity: row.severity, fixedIn: row.fixedIn, advisory: await input.advisory(row.cve, row.package) });
      }
      fixes.push({
        package: fix.package,
        installed: fix.installed,
        target: fix.target,
        severity: fix.severity,
        chain: ecosystem && lockfile !== null ? ecosystem.parentChain(lockfile, fix.package, fix.installed) : null,
        rows,
      });
    }
    units.push({
      kind: unit.kind,
      branch: unit.branch,
      source: unit.source,
      ecosystem: ecosystem?.name ?? null,
      lockfile: !ecosystem ? "unsupported ecosystem" : lockfile === null ? "missing at head" : "read",
      toolchain,
      fixes,
    });
  }
  return {
    ticket: { number: input.ticket.number, repo: input.ticket.repo, bodyHash: hash, force: input.ticket.force, commandCommentId: input.ticket.commandCommentId },
    headSha: input.headSha,
    openPullRequests: "not checked",
    decision: decide(input.last, { bodyHash: hash, force: input.ticket.force, prs: [] }),
    units,
  };
}
