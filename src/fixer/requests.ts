import type { TicketsConfig } from "../core/config.ts";
import type { TicketFilter } from "../core/github.ts";
import { isProsecoTicket, markerKey, markerRepo } from "../core/ticket.ts";
import type { ExistingTicket, TicketComment } from "../core/types.ts";
import type { PullRedo } from "./pulls.ts";
import { isIgnored, lastCommentId, recordComment, recordIgnored, type State } from "./state.ts";

export interface FixRequest {
  number: number;
  key: string;
  repo: string;
  force: boolean;
  ignored: boolean;
  commentId: number | null;
  pulls: PullRedo[];
}

export interface CommentApi {
  comments(number: number): Promise<TicketComment[]>;
  react(commentId: number, content: "eyes"): Promise<void>;
  canWrite(login: string): Promise<boolean>;
}

const MAX_NOTE_CHARS = 2000;

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
    requests.push({ number: ticket.number, key: markerKey(ticket.body)!, repo, force: false, ignored: false, commentId: null, pulls: [] });
  }
  return requests.sort((a, b) => a.number - b.number);
}

function isBot(comment: TicketComment): boolean {
  return comment.authorType === "Bot" || comment.author.endsWith("[bot]");
}

export type Command = "fix" | "ignore";

export type CommandComment = TicketComment & { command: Command; note: string };

export function commandComments(comments: TicketComment[], bot: string, afterId: number | null): CommandComment[] {
  const pattern = new RegExp(`(^|\\s)@${bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(fix|ignore)\\b`, "i");
  const found: CommandComment[] = [];
  for (const comment of comments) {
    if (comment.id <= (afterId ?? 0) || isBot(comment)) continue;
    const match = pattern.exec(comment.body);
    if (match) found.push({ ...comment, command: match[2]!.toLowerCase() as Command, note: comment.body.slice(match.index + match[0].length).trim().slice(0, MAX_NOTE_CHARS) });
  }
  return found.sort((a, b) => b.id - a.id);
}

export function commandComment(comments: TicketComment[], bot: string, afterId: number | null): CommandComment | null {
  return commandComments(comments, bot, afterId)[0] ?? null;
}

export async function trustedCommand(comments: TicketComment[], bot: string, afterId: number | null, canWrite: (login: string) => Promise<boolean>): Promise<CommandComment | null> {
  for (const command of commandComments(comments, bot, afterId)) if (await canWrite(command.author)) return command;
  return null;
}

export function memoised(canWrite: (login: string) => Promise<boolean>): (login: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (login) => {
    const key = login.toLowerCase();
    if (!known.has(key)) known.set(key, canWrite(login));
    return known.get(key)!;
  };
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
  const canWrite = memoised((login) => api.canWrite(login));
  for (const request of requests) {
    const command = await trustedCommand(await api.comments(request.number), bot, lastCommentId(next, request.number), canWrite);
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
