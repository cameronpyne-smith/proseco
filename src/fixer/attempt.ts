import { parseRawTable } from "../core/ticket.ts";
import { renderComment, type UnitOutcomeReport, type UnitReport } from "./comment.ts";
import { planUnits, type PrUnit } from "./plan.ts";
import { bodyHash, decide, lastAttempt, recordAttempt, type Decision, type PullRequestStatus, type State } from "./state.ts";
import type { LoopStats, TraceEntry } from "./agent/loop.ts";

export interface UnitResult {
  outcome: UnitOutcomeReport;
  checkout?: string;
  stats?: LoopStats;
  trace?: TraceEntry[];
}

export interface AttemptInput {
  ticket: { number: number; repo: string; body: string };
  force: boolean;
  state: State;
  local: boolean;
}

export interface AttemptDeps {
  org: string;
  fetch(): Promise<string>;
  prStatus(url: string): Promise<PullRequestStatus>;
  workUnit(unit: PrUnit, headSha: string): Promise<UnitResult>;
  postComment(body: string): Promise<void>;
  saveState?(state: State): void;
  now(): Date;
}

export interface UnitReportDetail extends UnitReport {
  unit: PrUnit;
  result: UnitResult;
}

export interface AttemptResult {
  skipped: boolean;
  decision: Decision;
  headSha: string | null;
  reports: UnitReportDetail[];
  state: State;
}

function labelOf(unit: PrUnit): string {
  if (unit.kind === "major") return `\`${unit.source}\` (${unit.fixes.map((fix) => fix.package).join(", ")}, major upgrade)`;
  return `\`${unit.source}\``;
}

function none(reason: string): UnitResult {
  return { outcome: { kind: "none", reason } };
}

async function work(unit: PrUnit, headSha: string, deps: AttemptDeps): Promise<UnitResult> {
  if (unit.kind === "major") return none("major upgrades are not attempted yet");
  if (unit.ecosystem !== "npm") return none(`unsupported ecosystem: ${unit.ecosystem ?? "unknown lockfile type"}`);
  try {
    return await deps.workUnit(unit, headSha);
  } catch (error) {
    return none(`unexpected failure: ${(error as Error).message}`);
  }
}

export async function runAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult> {
  const { ticket, state } = input;
  const hash = bodyHash(ticket.body);
  const last = lastAttempt(state, ticket.number);
  const prs: PullRequestStatus[] = [];
  if (!input.local && last) for (const url of last.prUrls) prs.push(await deps.prStatus(url));
  const decision = decide(last, { bodyHash: hash, force: input.force, prs });
  if (!decision.attempt && !input.local) return { skipped: true, decision, headSha: null, reports: [], state };

  const units = planUnits(parseRawTable(ticket.body), deps.org);
  const headSha = await deps.fetch();
  const reports: UnitReportDetail[] = [];
  for (const unit of units) {
    const result = await work(unit, headSha, deps);
    reports.push({ label: labelOf(unit), outcome: result.outcome, unit, result });
  }
  if (input.local) return { skipped: false, decision, headSha, reports, state };

  const urls = reports.flatMap((report) => (report.outcome.kind === "pr" ? [report.outcome.url] : []));
  const next = recordAttempt(state, ticket.number, {
    bodyHash: hash,
    headSha,
    attemptedAt: deps.now().toISOString(),
    outcome: urls.length > 0 ? "pr-opened" : "gave-up",
    prUrls: urls,
  });
  try {
    await deps.postComment(renderComment(hash, reports));
  } finally {
    deps.saveState?.(next);
  }
  return { skipped: false, decision, headSha, reports, state: next };
}
