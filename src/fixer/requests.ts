import type { TicketsConfig } from "../core/config.ts";
import type { TicketFilter } from "../core/github.ts";
import { isProsecoTicket, markerKey, markerRepo } from "../core/ticket.ts";
import type { ExistingTicket, TicketComment } from "../core/types.ts";
import { isIgnored, lastCommentId, recordComment, recordIgnored, type State } from "./state.ts";

export interface FixRequest {
  number: number;
  key: string;
  repo: string;
  force: boolean;
  ignored: boolean;
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
    const repo = markerRepo(ticket.body);
    if (!repo) continue;
    requests.push({ number: ticket.number, key: markerKey(ticket.body)!, repo, force: false, ignored: false, commentId: null });
  }
  return requests.sort((a, b) => a.number - b.number);
}

function isBot(comment: TicketComment): boolean {
  return comment.authorType === "Bot" || comment.author.endsWith("[bot]");
}

export type Command = "fix" | "ignore";

export type CommandComment = TicketComment & { command: Command };

export function commandComment(comments: TicketComment[], bot: string, afterId: number | null): CommandComment | null {
  const pattern = new RegExp(`(^|\\s)@${bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(fix|ignore)\\b`, "i");
  let newest: CommandComment | null = null;
  for (const comment of comments) {
    if (comment.id <= (afterId ?? 0) || isBot(comment) || (newest && newest.id > comment.id)) continue;
    const match = pattern.exec(comment.body);
    if (match) newest = { ...comment, command: match[2]!.toLowerCase() as Command };
  }
  return newest;
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
      result.push({ ...request, ignored: isIgnored(next, request.number) });
      continue;
    }
    const ignored = command.command === "ignore";
    if (acknowledge) {
      await api.react(command.id, "eyes");
      next = recordIgnored(recordComment(next, request.number, command.id), request.number, ignored);
    }
    result.push({ ...request, force: !ignored, ignored, commentId: command.id });
  }
  return { requests: result, state: next };
}
