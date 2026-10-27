import type { PullDetails } from "../core/github.ts";
import type { ChatMessage, ChatResult, ToolDefinition } from "./agent/ollama.ts";
import type { AnnounceReason, UnitReport } from "./comment.ts";
import type { ReviewOutcome } from "./reviewer.ts";
import { feedbackRounds, MAX_FEEDBACK_ROUNDS, pendingAnnouncement, withAnnouncement, type AnnouncedPr, type PendingAnnouncement, type ReviewVerdict, type State } from "./state.ts";

export const GIVE_UP_MS = 24 * 60 * 60_000;
export const REVIEW_WAIT_MS = 24 * 60 * 60_000;
const FIRST_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 2 * 60 * 60_000;
export const MAX_SENTENCE = 120;
const MAX_ERROR = 300;

export const SENTENCE_PROMPT = [
  "You write the one-line description in a review request that a bot posts to a team chat, above links to pull requests.",
  "The user message lists the pull requests as facts. Write one plain sentence of at most 100 characters that says what the pull requests change, for example: Fix 5 vulnerable packages in uv.lock and upgrade starlette and cryptography across a major version",
  "Use only package names, versions and file names that appear in the facts. No links, no mentions, no markdown, no quotes, no ticket number and no full stop at the end. Reply with the sentence only.",
].join("\n");

export function announcements(reports: UnitReport[]): AnnouncedPr[] {
  return reports.flatMap(({ outcome }) => (outcome.kind === "pr" && outcome.announce && outcome.facts ? [{ url: outcome.url, reason: outcome.announce, facts: outcome.facts }] : []));
}

export function queueAnnouncement(state: State, ticket: number, prs: AnnouncedPr[], now: Date): State {
  if (prs.length === 0) return state;
  const existing = pendingAnnouncement(state, ticket);
  const fresh = new Set(prs.map((pr) => pr.url));
  const merged = [...(existing?.prs ?? []).filter((pr) => !fresh.has(pr.url)), ...prs];
  return withAnnouncement(state, ticket, { prs: merged, queuedAt: now.toISOString(), attempts: 0, nextAt: now.toISOString(), lastError: null });
}

export function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

export interface DecidedPr extends AnnouncedPr {
  outcome?: ReviewOutcome | null;
}

export interface MessageGroup<T extends AnnouncedPr = AnnouncedPr> {
  reReview: boolean;
  prs: T[];
}

export function messageGroups<T extends AnnouncedPr>(prs: T[]): MessageGroup<T>[] {
  const groups = new Map<boolean, MessageGroup<T>>();
  for (const pr of prs) {
    const reReview = pr.reason === "re-review";
    const group = groups.get(reReview) ?? { reReview, prs: [] };
    group.prs.push(pr);
    groups.set(reReview, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.reReview) - Number(b.reReview));
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function fallbackSentence(prs: AnnouncedPr[]): string {
  const [only] = prs;
  if (prs.length === 1 && only) return only.facts.title;
  const lockfiles = prs.filter((pr) => !pr.facts.major);
  const majors = prs.filter((pr) => pr.facts.major);
  const parts: string[] = [];
  const [lockfile] = lockfiles;
  if (lockfiles.length === 1 && lockfile) parts.push(lockfile.facts.title);
  else if (lockfiles.length > 1) parts.push(`Fix ${lockfiles.reduce((sum, pr) => sum + pr.facts.packages.length, 0)} vulnerable packages in ${lockfiles.length} lockfiles`);
  const [major] = majors;
  if (majors.length === 1 && major) parts.push(major.facts.title);
  else if (majors.length > 1) parts.push(`Upgrade ${listOf(majors.flatMap((pr) => pr.facts.packages.map((pkg) => pkg.name)))} across a major version`);
  return parts.map((part, index) => (index === 0 ? part : lower(part))).join(" and ");
}

function listOf(items: string[]): string {
  const unique = [...new Set(items)];
  return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

function versionTokens(version: string): string[] {
  return version.split(/,\s*|\s+or\s+/).flatMap((item) => [item, item.split(".")[0]!]);
}

function allowedTokens(prs: AnnouncedPr[]): Set<string> {
  const tokens = new Set<string>();
  const add = (value: string) => value.split(/\s+/).forEach((word) => word && tokens.add(word.toLowerCase().replace(/^[("']+|[)"',;:.!?]+$/g, "")));
  for (const { facts } of prs) {
    add(facts.title);
    add(facts.lockfile);
    add(facts.lockfile.split("/").at(-1) ?? "");
    tokens.add(String(facts.packages.length));
    for (const pkg of facts.packages) {
      add(pkg.name);
      for (const version of [...versionTokens(pkg.from), ...versionTokens(pkg.to)]) add(version);
    }
  }
  for (const count of [prs.length, prs.filter((pr) => pr.facts.major).length, prs.filter((pr) => !pr.facts.major).length, prs.reduce((sum, pr) => sum + pr.facts.packages.length, 0)]) tokens.add(String(count));
  return tokens;
}

export function checkSentence(raw: string, prs: AnnouncedPr[]): string | null {
  const text = raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  if (text === "" || text.length > MAX_SENTENCE || /[\r\n\t]/.test(text)) return null;
  if (/[<>[\]{}`*#|~\\@=]/.test(text) || /:\/\/|www\./i.test(text)) return null;
  const allowed = allowedTokens(prs);
  for (const word of text.split(/\s+/)) {
    const bare = word.toLowerCase().replace(/^[("']+|[)"',;:.!?]+$/g, "");
    if (/[0-9./_-]/.test(bare) && !allowed.has(bare)) return null;
  }
  return text;
}

export function sentenceFacts(repo: string, prs: AnnouncedPr[]): string {
  return [
    `Repository: ${repo}`,
    "Pull requests:",
    ...prs.map(({ facts }) => {
      const what = facts.major ? "major upgrade" : "vulnerable package fix";
      const packages = facts.packages.map((pkg) => `${pkg.name} ${pkg.from} to ${pkg.to}`).join("; ");
      return `- ${what}${facts.lockfile ? ` in ${facts.lockfile}` : ""}${packages ? `: ${packages}` : ""} (title: ${facts.title})`;
    }),
  ].join("\n");
}

export type SentenceModel = { chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> };

export async function writeSentence(llm: SentenceModel | null, repo: string, prs: AnnouncedPr[]): Promise<string> {
  if (!llm) return fallbackSentence(prs);
  try {
    const { message } = await llm.chat(
      [
        { role: "system", content: SENTENCE_PROMPT },
        { role: "user", content: sentenceFacts(repo, prs) },
      ],
      [],
    );
    return checkSentence(message.content, prs) ?? fallbackSentence(prs);
  } catch {
    return fallbackSentence(prs);
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderMessage(input: { ticket: number; ticketUrl: string; sentence: string; reReview: boolean; urls: string[] }): string {
  const link = (url: string, text: string) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
  return [
    `${link(input.ticketUrl, String(input.ticket))} - ${escapeHtml(`${input.reReview ? "Re-review: " : ""}${input.sentence}`)}`,
    ...input.urls.map((url) => link(url, url)),
  ].join("<br>");
}

export interface PullLocation {
  org: string;
  repo: string;
  number: number;
}

export function pullLocation(url: string): PullLocation | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/.exec(url);
  return match ? { org: match[1]!, repo: match[2]!, number: Number(match[3]) } : null;
}

export interface MessageDeps {
  org: string;
  bot: string;
  reviewer: { name: string } | null;
  ticketUrl(ticket: number): string;
  pull(location: PullLocation): Promise<PullDetails>;
  verdict(location: PullLocation, headSha: string): Promise<ReviewVerdict | null>;
  sentence(repo: string, prs: AnnouncedPr[]): Promise<string>;
}

export function isAnnounceable(deps: Pick<MessageDeps, "bot">, url: string, details: PullDetails): boolean {
  return details.state === "open" && !details.draft && details.author === `${deps.bot}[bot]` && details.url === url;
}

export async function stillAnnounceable(deps: Pick<MessageDeps, "org" | "bot" | "pull">, prs: AnnouncedPr[]): Promise<{ pr: AnnouncedPr; details: PullDetails }[]> {
  const kept: { pr: AnnouncedPr; details: PullDetails }[] = [];
  for (const pr of prs) {
    const location = pullLocation(pr.url);
    if (!location || location.org !== deps.org) continue;
    const details = await deps.pull(location);
    if (isAnnounceable(deps, pr.url, details)) kept.push({ pr, details });
  }
  return kept;
}

export interface ReviewQuery {
  queuedAt: string;
  rounds: Record<string, number>;
  now: Date;
  force: boolean;
}

export async function reviewOutcome(deps: Pick<MessageDeps, "reviewer" | "verdict">, pr: AnnouncedPr, details: PullDetails, query: ReviewQuery): Promise<ReviewOutcome | null | "waiting"> {
  if (!deps.reviewer) return null;
  const location = pullLocation(pr.url)!;
  const verdict = await deps.verdict(location, details.headSha);
  if (verdict === "ready" || verdict === "caution") return verdict;
  if (verdict === "blocked") return query.force || (query.rounds[pr.url] ?? 0) >= MAX_FEEDBACK_ROUNDS ? "changes-requested" : "waiting";
  if (query.force || query.now.getTime() - Date.parse(query.queuedAt) >= REVIEW_WAIT_MS) return "no-review";
  return "waiting";
}

export async function buildMessage(deps: MessageDeps, ticket: number, group: MessageGroup): Promise<string> {
  const repos = [...new Set(group.prs.map((pr) => pullLocation(pr.url)?.repo ?? ""))].join(", ");
  const sentence = await deps.sentence(repos, group.prs);
  return renderMessage({ ticket, ticketUrl: deps.ticketUrl(ticket), sentence, reReview: group.reReview, urls: group.prs.map((pr) => pr.url) });
}

export interface DeliveryDeps extends MessageDeps {
  loadState(): State;
  saveState(state: State): void;
  send(html: string): Promise<void>;
  gaveUp(ticket: number, reason: string): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface DeliveryOptions {
  force?: boolean;
  waiting?(pr: AnnouncedPr): void;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);
}

export async function deliverTicket(deps: DeliveryDeps, ticket: number, pending: PendingAnnouncement, options: DeliveryOptions = {}): Promise<PendingAnnouncement | null> {
  let remaining = pending.prs;
  try {
    const query: ReviewQuery = { queuedAt: pending.queuedAt, rounds: feedbackRounds(deps.loadState(), ticket), now: deps.now(), force: options.force === true };
    const decided: DecidedPr[] = [];
    const waiting: AnnouncedPr[] = [];
    for (const { pr, details } of await stillAnnounceable(deps, remaining)) {
      const outcome = await reviewOutcome(deps, pr, details, query);
      if (outcome === "waiting") waiting.push(pr);
      else decided.push({ ...pr, outcome });
    }
    const kept = new Set([...waiting, ...decided].map((pr) => pr.url));
    remaining = remaining.filter((pr) => kept.has(pr.url));
    for (const group of messageGroups(decided)) {
      await deps.send(await buildMessage(deps, ticket, group));
      const sent = new Set(group.prs.map((pr) => pr.url));
      remaining = remaining.filter((pr) => !sent.has(pr.url));
      deps.log(`#${ticket} announced in Teams: ${group.prs.map((pr) => `${pr.url}${pr.outcome ? ` (${pr.outcome})` : ""}`).join(", ")}`);
    }
    for (const pr of waiting) options.waiting?.(pr);
    return waiting.length > 0 ? { ...pending, prs: waiting } : null;
  } catch (error) {
    const now = deps.now();
    const reason = errorText(error);
    const attempts = pending.attempts + 1;
    if (now.getTime() - Date.parse(pending.queuedAt) >= GIVE_UP_MS) {
      deps.log(`#${ticket} not announced in Teams after ${attempts} tries, giving up: ${reason}`);
      try {
        await deps.gaveUp(ticket, reason);
      } catch (noteError) {
        deps.log(`#${ticket} could not note the failed announcement on the ticket: ${errorText(noteError)}`);
      }
      return null;
    }
    const nextAt = new Date(now.getTime() + retryDelay(attempts)).toISOString();
    deps.log(`#${ticket} Teams announcement failed (try ${attempts}), retrying at ${nextAt}: ${reason}`);
    return { ...pending, prs: remaining, attempts, nextAt, lastError: reason };
  }
}

export async function deliverAnnouncements(deps: DeliveryDeps): Promise<void> {
  const due = Object.entries(deps.loadState().tickets).flatMap(([number, entry]) =>
    entry.announcement && Date.parse(entry.announcement.nextAt) <= deps.now().getTime() ? [{ ticket: Number(number), pending: entry.announcement }] : [],
  );
  for (const { ticket, pending } of due) {
    const next = await deliverTicket(deps, ticket, pending);
    deps.saveState(withAnnouncement(deps.loadState(), ticket, next));
  }
}

export function announceReason(before: { draft: boolean; approved: boolean; changed: boolean } | null, draft: boolean): AnnounceReason | null {
  if (draft) return null;
  if (!before) return "new";
  if (before.approved && before.changed) return "re-review";
  return before.draft ? "new" : null;
}
