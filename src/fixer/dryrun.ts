import { dirname } from "node:path/posix";
import type { TicketRow } from "../core/ticket.ts";
import type { Advisory } from "./advisories.ts";
import { alreadyFixed, checkedFix, type CheckedFix } from "./check.ts";
import { ecosystemFor, type Ecosystem } from "./ecosystems/ecosystem.ts";
import { planUnits, type PrUnit } from "./plan.ts";
import { redoDecision, type PullRedo } from "./pulls.ts";
import { bodyHash, decide, type Attempt, type Decision } from "./state.ts";

export interface DryRunInput {
  ticket: { number: number; repo: string; body: string; force: boolean; ignored: boolean; commandCommentId: number | null };
  rows: TicketRow[];
  pulls: PullRedo[];
  org: string;
  headSha: string;
  last: Attempt | undefined;
  readFile(path: string): Promise<string | null>;
  advisory(cve: string, pkg: string, installed?: string): Promise<Advisory | null>;
}

export interface DryRunReport {
  ticket: { number: number; repo: string; bodyHash: string; force: boolean; ignored: boolean; commandCommentId: number | null };
  headSha: string;
  openPullRequests: "not checked";
  redo: { url: string; branch: string; reason: PullRedo["reason"]; requester: string | null; note: string | null }[];
  decision: Decision;
  units: {
    kind: PrUnit["kind"];
    branch: string;
    source: string;
    ecosystem: string | null;
    lockfile: "read" | "already fixed at head" | "missing at head" | "unsupported ecosystem" | "not a lockfile: rebuild the image";
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

export async function declaredToolchain(ecosystem: Ecosystem, lockfile: string, readFile: (path: string) => Promise<string | null>): Promise<string | null> {
  const files: Record<string, string> = {};
  for (const file of ecosystem.toolchainFiles) {
    const beside = sibling(lockfile, file);
    const text = (await readFile(beside)) ?? (beside === file ? null : await readFile(file));
    if (text !== null) files[file] = text;
  }
  return ecosystem.toolchainVersion(files);
}

export async function dryRunReport(input: DryRunInput): Promise<DryRunReport> {
  const hash = bodyHash(input.ticket.body);
  const units: DryRunReport["units"] = [];
  for (const unit of planUnits(input.rows, input.org)) {
    const ecosystem = ecosystemFor(unit.source);
    const lockfile = ecosystem ? await input.readFile(unit.source) : null;
    const toolchain = ecosystem ? await declaredToolchain(ecosystem, unit.source, input.readFile) : null;
    const fixes: DryRunReport["units"][number]["fixes"] = [];
    const checked: CheckedFix[] = [];
    for (const fix of unit.fixes) {
      const rows = [];
      for (const row of fix.rows) {
        rows.push({ cve: row.cve, severity: row.severity, fixedIn: row.fixedIn, advisory: await input.advisory(row.cve, row.package, row.installed) });
      }
      checked.push(checkedFix(fix, rows.map((row) => row.advisory)));
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
      lockfile: unit.kind === "image" ? "not a lockfile: rebuild the image" : !ecosystem ? "unsupported ecosystem" : lockfile === null ? "missing at head" : !ecosystem.unsupported(lockfile) && alreadyFixed(ecosystem, lockfile, checked) ? "already fixed at head" : "read",
      toolchain,
      fixes,
    });
  }
  const decision = decide(input.last, { bodyHash: hash, force: input.ticket.force, prs: [], ignored: input.ticket.ignored });
  const redoOnly = input.pulls.length > 0 && !input.ticket.ignored && !decision.attempt;
  return {
    ticket: { number: input.ticket.number, repo: input.ticket.repo, bodyHash: hash, force: input.ticket.force, ignored: input.ticket.ignored, commandCommentId: input.ticket.commandCommentId },
    headSha: input.headSha,
    openPullRequests: "not checked",
    redo: input.pulls.map((pull) => ({ url: pull.url, branch: pull.branch, reason: pull.reason, requester: pull.requester, note: pull.note })),
    decision: redoOnly ? redoDecision(input.pulls) : decision,
    units: redoOnly ? units.filter((unit) => input.pulls.some((pull) => pull.branch === unit.branch)) : units,
  };
}
