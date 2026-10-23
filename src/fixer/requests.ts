import type { FixerConfig } from "../core/config.ts";
import { UNMAPPED_KEY } from "../core/findings.ts";
import type { TicketFilter } from "../core/github.ts";
import { isProsecoTicket, markerKey } from "../core/ticket.ts";
import type { ExistingTicket } from "../core/types.ts";

export interface FixRequest {
  number: number;
  repo: string;
  request: "assess" | "fix";
}

export function requestFilters(labels: FixerConfig["labels"]): TicketFilter[] {
  return [
    { labels: labels.assess, state: "open" },
    { labels: labels.fix, state: "open" },
  ];
}

export function fixRequests(tickets: ExistingTicket[], creators: string[], labels: FixerConfig["labels"]): FixRequest[] {
  const requests: FixRequest[] = [];
  for (const ticket of tickets) {
    if (ticket.state !== "open" || !isProsecoTicket(ticket, creators)) continue;
    const repo = markerKey(ticket.body)!;
    if (repo === UNMAPPED_KEY) continue;
    const request = ticket.labels.includes(labels.fix) ? "fix" : ticket.labels.includes(labels.assess) ? "assess" : null;
    if (request) requests.push({ number: ticket.number, repo, request });
  }
  return requests.sort((a, b) => a.number - b.number);
}
