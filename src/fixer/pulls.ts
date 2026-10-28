import type { PullInfo, PullReview } from "../core/github.ts";
import type { TicketComment } from "../core/types.ts";
import type { UnitOutcomeReport } from "./comment.ts";
import { memoised, trustedCommand, type FixRequest } from "./requests.ts";
import { verdictAt } from "./reviewer.ts";
import { feedbackRounds, MAX_FEEDBACK_ROUNDS, pullState, withoutPulls, withPull, type Decision, type State } from "./state.ts";

export interface PullRedo {
  url: string;
  number: number;
  branch: string;
  headSha: string;
  reason: "command" | "conflict" | "review" | "manual";
  requester: string | null;
  note: string | null;
}

export interface PullSource {
  openPulls(repo: string): Promise<PullInfo[]>;
  conflicted(repo: string, number: number): Promise<boolean>;
  reviews(repo: string, number: number): Promise<PullReview[]>;
  comments(repo: string, number: number): Promise<TicketComment[]>;
  react(repo: string, commentId: number): Promise<void>;
  reply(repo: string, number: number, body: string): Promise<void>;
  canWrite(repo: string, login: string): Promise<boolean>;
}

export interface ScanOptions {
  org: string;
  ticketsRepo: string;
  bot: string;
  acknowledge: boolean;
  reviewer?: string;
  only?: ReadonlySet<number>;
  log?(line: string): void;
}

export function ticketOfPull(body: string, org: string, ticketsRepo: string): number | null {
  const escaped = `${org}/${ticketsRepo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^Part of ${escaped}#(\\d+)\\s*$`, "m").exec(body);
  return match ? Number(match[1]) : null;
}

export function isFixerPull(pull: Pick<PullInfo, "author" | "branch">, bot: string): boolean {
  return pull.author === `${bot}[bot]` && pull.branch.startsWith("proseco/");
}

export function redoOf(pull: Pick<PullInfo, "url" | "number" | "branch" | "headSha">, reason: PullRedo["reason"], requester: string | null = null, note: string | null = null): PullRedo {
  return { url: pull.url, number: pull.number, branch: pull.branch, headSha: pull.headSha, reason, requester, note };
}

function pullPrefix(org: string, repo: string): string {
  return `https://github.com/${org}/${repo}/pull/`;
}

async function wantsReviewRound(source: PullSource, repo: string, pull: PullInfo, reviewer: string | undefined, rounds: number): Promise<boolean> {
  if (!reviewer || rounds >= MAX_FEEDBACK_ROUNDS) return false;
  const verdict = verdictAt(await source.reviews(repo, pull.number), reviewer, pull.headSha);
  return verdict === "caution" || verdict === "blocked";
}

export async function scanPulls(requests: FixRequest[], source: PullSource, state: State, options: ScanOptions): Promise<{ requests: FixRequest[]; state: State }> {
  const { org, ticketsRepo, bot, acknowledge } = options;
  let next = state;
  const redos = new Map<number, PullRedo[]>();
  const answer = async (repo: string, pull: PullInfo, body: string) => {
    if (acknowledge) await source.reply(repo, pull.number, body);
  };
  for (const repo of [...new Set(requests.map((request) => request.repo))].sort()) {
    const canWrite = memoised((login) => source.canWrite(repo, login));
    const open = (await source.openPulls(repo)).filter((pull) => isFixerPull(pull, bot));
    if (acknowledge) {
      const prefix = pullPrefix(org, repo);
      const kept = new Set(open.map((pull) => pull.url));
      next = withoutPulls(next, (url) => url.startsWith(prefix) && !kept.has(url));
    }
    for (const pull of open) {
      const ticket = ticketOfPull(pull.body, org, ticketsRepo);
      if (options.only && (ticket === null || !options.only.has(ticket))) continue;
      const request = requests.find((item) => item.number === ticket && item.repo === repo);
      const known = pullState(next, pull.url);
      const command = await trustedCommand(await source.comments(repo, pull.number), bot, known.lastCommentId ?? null, canWrite);
      if (command) {
        if (acknowledge) {
          await source.react(repo, command.id);
          next = withPull(next, pull.url, { ...pullState(next, pull.url), lastCommentId: command.id });
        }
        if (command.command === "ignore") {
          await answer(repo, pull, `\`@${bot} ignore\` works on the ticket, not on a pull request${ticket ? `: comment it on ${org}/${ticketsRepo}#${ticket}` : ""}.`);
          continue;
        }
        if (!request) {
          await answer(repo, pull, ticket ? `${org}/${ticketsRepo}#${ticket} is closed or is not a proseco ticket, so there is nothing to redo.` : `This pull request does not name its ticket, so there is nothing to redo.`);
          continue;
        }
        if (request.ignored) {
          await answer(repo, pull, `${org}/${ticketsRepo}#${ticket} is ignored. Comment \`@${bot} fix\` on the ticket to resume it.`);
          continue;
        }
        redos.set(request.number, [...(redos.get(request.number) ?? []), redoOf(pull, "command", command.author, command.note === "" ? null : command.note)]);
        continue;
      }
      if (!request || request.ignored || known.refreshedHead === pull.headSha) continue;
      const rounds = feedbackRounds(next, request.number)[pull.url] ?? 0;
      const reason = (await wantsReviewRound(source, repo, pull, options.reviewer, rounds)) ? "review" : (await source.conflicted(repo, pull.number)) ? "conflict" : null;
      if (!reason) continue;
      options.log?.(reason === "review" ? `${pull.url} has findings from the reviewer` : `${pull.url} conflicts with the default branch`);
      if (acknowledge) next = withPull(next, pull.url, { ...pullState(next, pull.url), refreshedHead: pull.headSha });
      redos.set(request.number, [...(redos.get(request.number) ?? []), redoOf(pull, reason)]);
    }
  }
  return { requests: requests.map((request) => ({ ...request, pulls: [...request.pulls, ...(redos.get(request.number) ?? [])] })), state: next };
}

export function redoDecision(pulls: PullRedo[]): Decision {
  return { attempt: true, reason: pulls.map(describeRedo).join("; ") };
}

export function describeRedo(pull: PullRedo): string {
  if (pull.reason === "conflict") return `${pull.url} conflicts with the default branch`;
  if (pull.reason === "command") return `${pull.requester} asked for a redo of ${pull.url}`;
  if (pull.reason === "review") return `the reviewer raised findings on ${pull.url}`;
  return `a redo of ${pull.url} was run by hand`;
}

export function redoReply(pull: PullRedo, headSha: string, outcome: UnitOutcomeReport | null): string {
  if (!outcome) return "proseco did not redo this pull request: its findings are no longer on the ticket, so it can be closed.\n";
  const why = pull.reason === "conflict" ? "because it conflicted with the default branch" : pull.reason === "command" ? `as ${pull.requester} asked` : pull.reason === "review" ? "to address the reviewer's findings" : "by hand";
  const lines = [`proseco redid this pull request from the default branch at ${headSha.slice(0, 7)}, ${why}.`, ""];
  if (outcome.kind === "pr") lines.push(`Result: ${outcome.draft ? "draft" : "ready for review"}.${outcome.url === pull.url ? "" : ` The change is now in ${outcome.url}.`}`);
  else if (outcome.reason === "already fixed on the default branch") lines.push("Result: already fixed on the default branch, so this pull request is no longer needed and can be closed.");
  else lines.push(`Result: not updated: ${outcome.reason}`);
  return `${lines.join("\n")}\n`;
}
