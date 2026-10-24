import type { TicketsConfig } from "../core/config.ts";
import { UNMAPPED_KEY } from "../core/findings.ts";
import type { TicketFilter } from "../core/github.ts";
import { isProsecoTicket, markerKey } from "../core/ticket.ts";
import type { ExistingTicket, TicketComment } from "../core/types.ts";
import { lastCommentId, recordComment, type State } from "./state.ts";

export interface FixRequest {
  number: number;
  repo: string;
  force: boolean;
  commentId: number | null;
}

export interface CommentApi {
  comments(number: number): Promise<TicketComment[]>;
  react(commentId: number, content: "eyes"): Promise<void>;
}

export function requestFilters(find: TicketsConfig["find"]): TicketFilter[] {
  return [
    ...find.labels.map((labels): TicketFilter => ({ labels, state: "open" })),
    ...find.creators.map((creator): TicketFilter => ({ creator, state: "open" })),
  ];
}

export function fixRequests(tickets: ExistingTicket[], creators: string[]): FixRequest[] {
  const requests: FixRequest[] = [];
  for (const ticket of tickets) {
    if (ticket.state !== "open" || !isProsecoTicket(ticket, creators)) continue;
    const repo = markerKey(ticket.body)!;
    if (repo === UNMAPPED_KEY) continue;
    requests.push({ number: ticket.number, repo, force: false, commentId: null });
  }
  return requests.sort((a, b) => a.number - b.number);
}

function isBot(comment: TicketComment): boolean {
  return comment.authorType === "Bot" || comment.author.endsWith("[bot]");
}

export function commandComment(comments: TicketComment[], bot: string, afterId: number | null): TicketComment | null {
  const command = new RegExp(`(^|\\s)@${bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+fix\\b`, "i");
  const found = comments.filter((comment) => comment.id > (afterId ?? 0) && !isBot(comment) && command.test(comment.body));
  return found.reduce<TicketComment | null>((newest, comment) => (newest && newest.id > comment.id ? newest : comment), null);
}

export async function applyCommands(
  requests: FixRequest[],
  api: CommentApi,
  bot: string,
  state: State,
  acknowledge: boolean,
): Promise<{ requests: FixRequest[]; state: State }> {
  let next = state;
  const result: FixRequest[] = [];
  for (const request of requests) {
    const command = commandComment(await api.comments(request.number), bot, lastCommentId(next, request.number));
    if (!command) {
      result.push(request);
      continue;
    }
    if (acknowledge) {
      await api.react(command.id, "eyes");
      next = recordComment(next, request.number, command.id);
    }
    result.push({ ...request, force: true, commentId: command.id });
  }
  return { requests: result, state: next };
}
