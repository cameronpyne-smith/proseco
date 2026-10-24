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

export interface State {
  version: 1;
  tickets: Record<string, Attempt>;
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

export function recordAttempt(state: State, ticket: number, attempt: Attempt): State {
  return { version: 1, tickets: { ...state.tickets, [String(ticket)]: attempt } };
}

export function decide(last: Attempt | undefined, query: AttemptQuery): Decision {
  if (query.force) return { attempt: true, reason: "the fix label forces a new attempt" };
  if (query.prs.some((pr) => pr.state === "open")) return { attempt: false, reason: "an open pull request exists for the ticket" };
  if (!last) return { attempt: true, reason: "never attempted" };
  if (last.bodyHash === query.bodyHash) return { attempt: false, reason: `already attempted this ticket body (${last.outcome})` };
  const closed = query.prs.some((pr) => pr.state === "closed" && last.prUrls.includes(pr.url));
  if (closed) return { attempt: false, reason: "a pull request from the last attempt was closed without merging; add the fix label to retry" };
  return { attempt: true, reason: "body changed since the last attempt" };
}

function validate(value: unknown, file: string): State {
  const fail = (message: string): never => {
    throw new Error(`${file} is not a fixer state file: ${message}`);
  };
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) fail("expected version 1");
  const tickets = (value as { tickets?: unknown }).tickets;
  if (typeof tickets !== "object" || tickets === null || Array.isArray(tickets)) fail("expected a tickets object");
  for (const [number, entry] of Object.entries(tickets as Record<string, unknown>)) {
    const attempt = entry as Partial<Attempt> | null;
    const valid =
      typeof attempt === "object" &&
      attempt !== null &&
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
