import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Attempt {
  bodyHash: string;
  headSha: string;
  attemptedAt: string;
  outcome: "pr-opened" | "gave-up";
  prUrls: string[];
}

export interface TicketState {
  attempt: Attempt | null;
  lastCommentId: number | null;
}

export interface State {
  version: 1;
  tickets: Record<string, TicketState>;
}

export interface PullRequestStatus {
  url: string;
  state: "open" | "merged" | "closed";
}

export interface AttemptQuery {
  bodyHash: string;
  force: boolean;
  prs: PullRequestStatus[];
}

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
  return { version: 1, tickets: { ...state.tickets, [String(ticket)]: next } };
}

export function recordAttempt(state: State, ticket: number, attempt: Attempt): State {
  return withEntry(state, ticket, { ...entry(state, ticket), attempt });
}

export function recordComment(state: State, ticket: number, commentId: number): State {
  return withEntry(state, ticket, { ...entry(state, ticket), lastCommentId: commentId });
}

export function lastCommentId(state: State, ticket: number): number | null {
  return entry(state, ticket).lastCommentId;
}

export function lastAttempt(state: State, ticket: number): Attempt | undefined {
  return entry(state, ticket).attempt ?? undefined;
}

export function decide(last: Attempt | undefined, query: AttemptQuery): Decision {
  if (query.force) return { attempt: true, reason: "a comment command forces a new attempt" };
  if (query.prs.some((pr) => pr.state === "open")) return { attempt: false, reason: "an open pull request exists for the ticket" };
  if (!last) return { attempt: true, reason: "never attempted" };
  if (last.bodyHash === query.bodyHash) return { attempt: false, reason: `already attempted this ticket body (${last.outcome})` };
  const closed = query.prs.some((pr) => pr.state === "closed" && last.prUrls.includes(pr.url));
  if (closed) return { attempt: false, reason: "a pull request from the last attempt was closed without merging; comment the fix command to retry" };
  return { attempt: true, reason: "body changed since the last attempt" };
}

function validate(value: unknown, file: string): State {
  const fail = (message: string): never => {
    throw new Error(`${file} is not a fixer state file: ${message}`);
  };
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) fail("expected version 1");
  const tickets = (value as { tickets?: unknown }).tickets;
  if (typeof tickets !== "object" || tickets === null || Array.isArray(tickets)) fail("expected a tickets object");
  for (const [number, raw] of Object.entries(tickets as Record<string, unknown>)) {
    const item = raw as Partial<TicketState> | null;
    if (typeof item !== "object" || item === null) return fail(`ticket ${number} is malformed`);
    if (item.lastCommentId !== null && !Number.isInteger(item.lastCommentId)) fail(`ticket ${number} has a malformed lastCommentId`);
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
