import { parseRawTable } from "../core/ticket.ts";
import { announcements, queueAnnouncement } from "./announce.ts";
import { renderComment, shownPulls, statusLine, workingComment, type PullState, type UnitOutcomeReport, type UnitReport } from "./comment.ts";
import { planUnits, type PrUnit } from "./plan.ts";
import { redoDecision, redoReply, type PullRedo } from "./pulls.ts";
import { bodyHash, decide, isIgnored, lastAttempt, recordAttempt, recordFeedback, recordShown, shownInComment, type Decision, type State } from "./state.ts";
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
  pulls?: PullRedo[];
  state: State;
  local: boolean;
}

export interface AttemptDeps {
  org: string;
  fetch(): Promise<string>;
  prStatus(url: string): Promise<PullState>;
  workUnit(unit: PrUnit, headSha: string, review: ReviewFindings | null, redo: PullRedo | null): Promise<UnitResult>;
  postComment(body: string): Promise<void>;
  mergeComment?(reports: UnitReport[], fresh: string, status: string): Promise<void>;
  markWorking?(fresh: string): Promise<void>;
  refreshComment?(pulls: PullState[], status: string): Promise<void>;
  reply?(pull: PullRedo, body: string): Promise<void>;
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

async function work(unit: PrUnit, headSha: string, imageTicket: boolean, redo: PullRedo | null, deps: AttemptDeps): Promise<{ result: UnitResult; review: ReviewFindings | null }> {
  if (imageTicket) return { result: none("image tickets are not attempted yet"), review: null };
  if (unit.kind === "image") return { result: none(REBUILD), review: null };
  if (unit.ecosystem === null) return { result: none("unsupported ecosystem: unknown lockfile type"), review: null };
  let review: ReviewFindings | null = null;
  try {
    review = deps.findings ? await deps.findings(unit) : null;
    return { result: await deps.workUnit(unit, headSha, review, redo), review };
  } catch (error) {
    return { result: none(`unexpected failure: ${(error as Error).message}`), review };
  }
}

async function refreshed(state: State, ticket: number, prs: PullState[], deps: AttemptDeps): Promise<State> {
  const shown = shownPulls(prs);
  if (prs.length === 0 || !deps.refreshComment || shownInComment(state, ticket) === shown) return state;
  await deps.refreshComment(prs, statusLine(prs));
  const next = recordShown(state, ticket, shown);
  deps.saveState?.(next);
  return next;
}

export async function runAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult> {
  const { ticket, state } = input;
  const hash = bodyHash(ticket.body);
  const last = lastAttempt(state, ticket.number);
  const prs: PullState[] = [];
  if (!input.local && last) for (const url of last.prUrls) prs.push(await deps.prStatus(url));
  const pulls = input.pulls ?? [];
  const ignored = isIgnored(state, ticket.number);
  const ticketDecision = decide(last, { bodyHash: hash, force: input.force, prs, ignored });
  const redoOnly = pulls.length > 0 && !ignored && (input.local || !ticketDecision.attempt);
  const decision = redoOnly ? redoDecision(pulls) : ticketDecision;
  if (!decision.attempt && !input.local) return { skipped: true, decision, headSha: null, reports: [], state: await refreshed(state, ticket.number, prs, deps) };

  deps.started?.(decision);
  if (!input.local && deps.markWorking) {
    await deps.markWorking(workingComment(hash));
    if (shownInComment(state, ticket.number) !== null) deps.saveState?.(recordShown(state, ticket.number, null));
  }
  const planned = planUnits(parseRawTable(ticket.body), deps.org);
  const redoOf = (unit: PrUnit) => pulls.find((pull) => pull.branch === unit.branch) ?? null;
  const units = redoOnly ? planned.filter((unit) => redoOf(unit)) : planned;
  const reports: UnitReportDetail[] = [];
  let headSha: string;
  const release = deps.lock ? await deps.lock() : null;
  try {
    headSha = await deps.fetch();
    for (const unit of units) {
      if (deps.shouldStop?.()) throw new ShutdownRequested();
      const { result, review } = await work(unit, headSha, ticket.key !== ticket.repo, redoOf(unit), deps);
      reports.push({ label: labelOf(unit), outcome: result.outcome, unit, result, review });
    }
  } finally {
    await release?.();
  }
  if (input.local) return { skipped: false, decision, headSha, reports, state };

  const urls = reports.flatMap((report) => (report.outcome.kind === "pr" ? [report.outcome.url] : []));
  const revised = reports.flatMap((report) => (report.review ? [report.review.url] : []));
  const kept = last ? [...new Set([...last.prUrls, ...urls])] : [];
  const attempted = redoOnly
    ? last
      ? recordAttempt(state, ticket.number, { ...last, outcome: kept.length > 0 ? "pr-opened" : last.outcome, prUrls: kept })
      : state
    : recordAttempt(state, ticket.number, {
        bodyHash: hash,
        headSha,
        attemptedAt: deps.now().toISOString(),
        outcome: urls.length > 0 ? "pr-opened" : "gave-up",
        prUrls: urls,
      });
  const pullStates = (lastAttempt(attempted, ticket.number)?.prUrls ?? []).map((url): PullState => {
    const outcome = reports.find((report) => report.outcome.kind === "pr" && report.outcome.url === url)?.outcome;
    return outcome?.kind === "pr" ? { url, state: "open", draft: outcome.draft } : (prs.find((pr) => pr.url === url) ?? { url, state: "open", draft: false });
  });
  const status = statusLine(pullStates);
  const recorded = recordShown(recordFeedback(attempted, ticket.number, revised), ticket.number, redoOnly ? null : shownPulls(pullStates));
  const next = deps.announce ? queueAnnouncement(recorded, ticket.number, announcements(reports), deps.now()) : recorded;
  try {
    const fresh = renderComment(hash, reports, status);
    if (redoOnly && deps.mergeComment) await deps.mergeComment(reports, fresh, status);
    else await deps.postComment(fresh);
    for (const pull of pulls) {
      const report = reports.find((item) => item.unit.branch === pull.branch);
      if (pull.reason === "review" && report?.review && report.outcome.kind === "pr") continue;
      await deps.reply?.(pull, redoReply(pull, headSha, report?.outcome ?? null));
    }
  } finally {
    deps.saveState?.(next);
  }
  return { skipped: false, decision, headSha, reports, state: next };
}
