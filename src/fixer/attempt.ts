import { parseRawTable } from "../core/ticket.ts";
import { announcements, queueAnnouncement } from "./announce.ts";
import { renderComment, type UnitOutcomeReport, type UnitReport } from "./comment.ts";
import { planUnits, type PrUnit } from "./plan.ts";
import { bodyHash, decide, feedbackRounds, isIgnored, lastAttempt, recordAttempt, recordFeedback, type Decision, type PullRequestStatus, type State } from "./state.ts";
import type { LoopStats, TraceEntry } from "./agent/loop.ts";
import type { Release } from "./lock.ts";
import type { ReviewFindings } from "./reviewer.ts";

export interface UnitResult {
  outcome: UnitOutcomeReport;
  checkout?: string;
  stats?: LoopStats;
  trace?: TraceEntry[];
  transcript?: string;
}

export interface AttemptInput {
  ticket: { number: number; key: string; repo: string; body: string };
  force: boolean;
  state: State;
  local: boolean;
}

export interface AttemptDeps {
  org: string;
  fetch(): Promise<string>;
  prStatus(url: string): Promise<PullRequestStatus>;
  workUnit(unit: PrUnit, headSha: string, review: ReviewFindings | null): Promise<UnitResult>;
  postComment(body: string): Promise<void>;
  saveState?(state: State): void;
  started?(decision: Decision): void;
  shouldStop?(): boolean;
  announce?: boolean;
  findings?(unit: PrUnit): Promise<ReviewFindings | null>;
  lock?(): Promise<Release>;
  now(): Date;
}

export class ShutdownRequested extends Error {
  constructor() {
    super("shutdown requested before the next unit");
  }
}

export interface UnitReportDetail extends UnitReport {
  unit: PrUnit;
  result: UnitResult;
  review: ReviewFindings | null;
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
  if (unit.kind === "image") return `\`${unit.source}\` (image)`;
  return `\`${unit.source}\``;
}

const REBUILD =
  "these findings are in the built image, not in a file in this repository. Rebuild and push the image, after merging any pull request above, so it picks up the patched packages from its base image; if the Dockerfile pins the base image to a digest or a patch version, bump it first";

function none(reason: string): UnitResult {
  return { outcome: { kind: "none", reason } };
}

async function work(unit: PrUnit, headSha: string, imageTicket: boolean, deps: AttemptDeps): Promise<{ result: UnitResult; review: ReviewFindings | null }> {
  if (imageTicket) return { result: none("image tickets are not attempted yet"), review: null };
  if (unit.kind === "image") return { result: none(REBUILD), review: null };
  if (unit.ecosystem === null) return { result: none("unsupported ecosystem: unknown lockfile type"), review: null };
  let review: ReviewFindings | null = null;
  try {
    review = deps.findings ? await deps.findings(unit) : null;
    return { result: await deps.workUnit(unit, headSha, review), review };
  } catch (error) {
    return { result: none(`unexpected failure: ${(error as Error).message}`), review };
  }
}

export async function runAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult> {
  const { ticket, state } = input;
  const hash = bodyHash(ticket.body);
  const last = lastAttempt(state, ticket.number);
  const prs: PullRequestStatus[] = [];
  if (!input.local && last) for (const url of last.prUrls) prs.push(await deps.prStatus(url));
  const decision = decide(last, { bodyHash: hash, force: input.force, prs, ignored: isIgnored(state, ticket.number), feedback: feedbackRounds(state, ticket.number) });
  if (!decision.attempt && !input.local) return { skipped: true, decision, headSha: null, reports: [], state };

  deps.started?.(decision);
  const units = planUnits(parseRawTable(ticket.body), deps.org);
  const reports: UnitReportDetail[] = [];
  let headSha: string;
  const release = deps.lock ? await deps.lock() : null;
  try {
    headSha = await deps.fetch();
    for (const unit of units) {
      if (deps.shouldStop?.()) throw new ShutdownRequested();
      const { result, review } = await work(unit, headSha, ticket.key !== ticket.repo, deps);
      reports.push({ label: labelOf(unit), outcome: result.outcome, unit, result, review });
    }
  } finally {
    await release?.();
  }
  if (input.local) return { skipped: false, decision, headSha, reports, state };

  const urls = reports.flatMap((report) => (report.outcome.kind === "pr" ? [report.outcome.url] : []));
  const revised = reports.flatMap((report) => (report.review ? [report.review.url] : []));
  const recorded = recordFeedback(
    recordAttempt(state, ticket.number, {
      bodyHash: hash,
      headSha,
      attemptedAt: deps.now().toISOString(),
      outcome: urls.length > 0 ? "pr-opened" : "gave-up",
      prUrls: urls,
    }),
    ticket.number,
    revised,
  );
  const next = deps.announce ? queueAnnouncement(recorded, ticket.number, announcements(reports), deps.now()) : recorded;
  try {
    await deps.postComment(renderComment(hash, reports));
  } finally {
    deps.saveState?.(next);
  }
  return { skipped: false, decision, headSha, reports, state: next };
}
