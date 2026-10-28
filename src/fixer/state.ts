import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PrFacts } from "./comment.ts";

export interface Attempt {
  bodyHash: string;
  headSha: string;
  attemptedAt: string;
  outcome: "pr-opened" | "gave-up";
  prUrls: string[];
}

export interface AnnouncedPr {
  url: string;
  facts: PrFacts;
}

export interface PendingAnnouncement {
  prs: AnnouncedPr[];
  queuedAt: string;
  attempts: number;
  nextAt: string;
  lastError: string | null;
}

export interface TicketState {
  attempt: Attempt | null;
  lastCommentId: number | null;
  ignored?: boolean;
  announcement?: PendingAnnouncement;
  announced?: string[];
  feedback?: Record<string, number>;
  shown?: string;
}

export interface PullState {
  lastCommentId?: number;
  refreshedHead?: string;
}

export interface State {
  version: 1;
  tickets: Record<string, TicketState>;
  pulls?: Record<string, PullState>;
}

export type ReviewVerdict = "ready" | "caution" | "blocked";

export interface PullRequestStatus {
  url: string;
  state: "open" | "merged" | "closed";
}

export interface AttemptQuery {
  bodyHash: string;
  force: boolean;
  prs: PullRequestStatus[];
  ignored?: boolean;
}

export const MAX_FEEDBACK_ROUNDS = 1;

export interface Decision {
  attempt: boolean;
  reason: string;
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function emptyState(): State {
  return { version: 1, tickets: {} };
}

function entry(state: State, ticket: number): TicketState {
  return state.tickets[String(ticket)] ?? { attempt: null, lastCommentId: null };
}

function withEntry(state: State, ticket: number, next: TicketState): State {
  return { ...state, tickets: { ...state.tickets, [String(ticket)]: next } };
}

export function forgetClosedTickets(state: State, open: ReadonlySet<number>): { state: State; forgotten: number[] } {
  const forgotten = Object.entries(state.tickets).flatMap(([number, item]) => (open.has(Number(number)) || item.announcement ? [] : [Number(number)]));
  if (forgotten.length === 0) return { state, forgotten };
  const tickets = Object.fromEntries(Object.entries(state.tickets).filter(([number]) => !forgotten.includes(Number(number))));
  return { state: { ...state, tickets }, forgotten };
}

export function pullState(state: State, url: string): PullState {
  return state.pulls?.[url] ?? {};
}

export function withPull(state: State, url: string, next: PullState): State {
  return { ...state, pulls: { ...state.pulls, [url]: next } };
}

export function withoutPulls(state: State, remove: (url: string) => boolean): State {
  if (!state.pulls) return state;
  const kept = Object.fromEntries(Object.entries(state.pulls).filter(([url]) => !remove(url)));
  return Object.keys(kept).length === Object.keys(state.pulls).length ? state : { ...state, pulls: kept };
}

export function recordAttempt(state: State, ticket: number, attempt: Attempt): State {
  return withEntry(state, ticket, { ...entry(state, ticket), attempt });
}

export function recordComment(state: State, ticket: number, commentId: number): State {
  return withEntry(state, ticket, { ...entry(state, ticket), lastCommentId: commentId });
}

export function recordIgnored(state: State, ticket: number, ignored: boolean): State {
  return withEntry(state, ticket, { ...entry(state, ticket), ignored });
}

export function withAnnouncement(state: State, ticket: number, announcement: PendingAnnouncement | null): State {
  const { announcement: _, ...rest } = entry(state, ticket);
  return withEntry(state, ticket, announcement ? { ...rest, announcement } : rest);
}

export function shownInComment(state: State, ticket: number): string | null {
  return entry(state, ticket).shown ?? null;
}

export function recordShown(state: State, ticket: number, shown: string | null): State {
  const { shown: _, ...rest } = entry(state, ticket);
  return withEntry(state, ticket, shown === null ? rest : { ...rest, shown });
}

export function announcedPrs(state: State, ticket: number): string[] {
  return entry(state, ticket).announced ?? [];
}

export function recordAnnounced(state: State, ticket: number, urls: string[]): State {
  if (urls.length === 0) return state;
  return withEntry(state, ticket, { ...entry(state, ticket), announced: [...new Set([...announcedPrs(state, ticket), ...urls])] });
}

export function pendingAnnouncement(state: State, ticket: number): PendingAnnouncement | undefined {
  return entry(state, ticket).announcement;
}

export function feedbackRounds(state: State, ticket: number): Record<string, number> {
  return entry(state, ticket).feedback ?? {};
}

export function recordFeedback(state: State, ticket: number, urls: string[]): State {
  if (urls.length === 0) return state;
  const feedback = { ...feedbackRounds(state, ticket) };
  for (const url of urls) feedback[url] = (feedback[url] ?? 0) + 1;
  return withEntry(state, ticket, { ...entry(state, ticket), feedback });
}

export function isIgnored(state: State, ticket: number): boolean {
  return entry(state, ticket).ignored === true;
}

export function lastCommentId(state: State, ticket: number): number | null {
  return entry(state, ticket).lastCommentId;
}

export function lastAttempt(state: State, ticket: number): Attempt | undefined {
  return entry(state, ticket).attempt ?? undefined;
}

export function decide(last: Attempt | undefined, query: AttemptQuery): Decision {
  if (query.ignored) return { attempt: false, reason: "ignored by a comment command" };
  if (query.force) return { attempt: true, reason: "a comment command forces a new attempt" };
  if (query.prs.some((pr) => pr.state === "open")) return { attempt: false, reason: "an open pull request exists for the ticket" };
  if (!last) return { attempt: true, reason: "never attempted" };
  if (last.bodyHash === query.bodyHash) return { attempt: false, reason: `already attempted this ticket body (${last.outcome})` };
  const closed = query.prs.some((pr) => pr.state === "closed" && last.prUrls.includes(pr.url));
  if (closed) return { attempt: false, reason: "a pull request from the last attempt was closed without merging; comment the fix command to retry" };
  return { attempt: true, reason: "body changed since the last attempt" };
}

function validFacts(value: unknown): boolean {
  const facts = value as Partial<PrFacts> | null;
  return (
    typeof facts === "object" &&
    facts !== null &&
    typeof facts.title === "string" &&
    typeof facts.major === "boolean" &&
    typeof facts.lockfile === "string" &&
    Array.isArray(facts.packages) &&
    facts.packages.every((pkg) => typeof pkg === "object" && pkg !== null && typeof pkg.name === "string" && typeof pkg.from === "string" && typeof pkg.to === "string")
  );
}

function validAnnouncement(value: unknown): boolean {
  const pending = value as Partial<PendingAnnouncement> | null;
  return (
    typeof pending === "object" &&
    pending !== null &&
    Array.isArray(pending.prs) &&
    pending.prs.every((pr) => typeof pr === "object" && pr !== null && typeof pr.url === "string" && validFacts(pr.facts)) &&
    typeof pending.queuedAt === "string" &&
    Number.isInteger(pending.attempts) &&
    typeof pending.nextAt === "string" &&
    (pending.lastError === null || typeof pending.lastError === "string")
  );
}

function validFeedback(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((rounds) => Number.isInteger(rounds) && (rounds as number) >= 0);
}

function validPulls(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((raw) => {
      const pull = raw as PullState | null;
      return typeof pull === "object" && pull !== null && (pull.lastCommentId === undefined || Number.isInteger(pull.lastCommentId)) && (pull.refreshedHead === undefined || typeof pull.refreshedHead === "string");
    })
  );
}

function validate(value: unknown, file: string): State {
  const fail = (message: string): never => {
    throw new Error(`${file} is not a fixer state file: ${message}`);
  };
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) fail("expected version 1");
  const tickets = (value as { tickets?: unknown }).tickets;
  if (typeof tickets !== "object" || tickets === null || Array.isArray(tickets)) fail("expected a tickets object");
  const pulls = (value as { pulls?: unknown }).pulls;
  if (pulls !== undefined && !validPulls(pulls)) fail("malformed pull requests record");
  for (const [number, raw] of Object.entries(tickets as Record<string, unknown>)) {
    const item = raw as Partial<TicketState> | null;
    if (typeof item !== "object" || item === null) return fail(`ticket ${number} is malformed`);
    if (item.lastCommentId !== null && !Number.isInteger(item.lastCommentId)) fail(`ticket ${number} has a malformed lastCommentId`);
    if (item.ignored !== undefined && typeof item.ignored !== "boolean") fail(`ticket ${number} has a malformed ignored flag`);
    if (item.announcement !== undefined && !validAnnouncement(item.announcement)) fail(`ticket ${number} has a malformed announcement`);
    if (item.announced !== undefined && !(Array.isArray(item.announced) && item.announced.every((url) => typeof url === "string"))) fail(`ticket ${number} has a malformed announced list`);
    if (item.feedback !== undefined && !validFeedback(item.feedback)) fail(`ticket ${number} has a malformed feedback record`);
    if (item.shown !== undefined && typeof item.shown !== "string") fail(`ticket ${number} has a malformed shown record`);
    const attempt = item.attempt;
    if (attempt === null) continue;
    const valid =
      typeof attempt === "object" &&
      typeof attempt.bodyHash === "string" &&
      typeof attempt.headSha === "string" &&
      typeof attempt.attemptedAt === "string" &&
      (attempt.outcome === "pr-opened" || attempt.outcome === "gave-up") &&
      Array.isArray(attempt.prUrls) &&
      attempt.prUrls.every((url) => typeof url === "string");
    if (!valid) fail(`ticket ${number} has a malformed attempt`);
  }
  return value as State;
}

export function loadState(file: string): State {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    return validate(JSON.parse(text), file);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON`);
    throw error;
  }
}

export function saveState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}
