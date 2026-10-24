import type { FixerConfig, TicketsConfig } from "../core/config.ts";
import { UNMAPPED_KEY } from "../core/findings.ts";
import type { TicketFilter } from "../core/github.ts";
import { isProsecoTicket, markerKey } from "../core/ticket.ts";
import type { ExistingTicket } from "../core/types.ts";

export interface FixRequest {
  number: number;
  repo: string;
  force: boolean;
}

export function requestFilters(find: TicketsConfig["find"]): TicketFilter[] {
  return [
    ...find.labels.map((labels): TicketFilter => ({ labels, state: "open" })),
    ...find.creators.map((creator): TicketFilter => ({ creator, state: "open" })),
  ];
}

export function fixRequests(tickets: ExistingTicket[], creators: string[], labels: FixerConfig["labels"]): FixRequest[] {
  const requests: FixRequest[] = [];
  for (const ticket of tickets) {
    if (ticket.state !== "open" || !isProsecoTicket(ticket, creators)) continue;
    const repo = markerKey(ticket.body)!;
    if (repo === UNMAPPED_KEY) continue;
    requests.push({ number: ticket.number, repo, force: ticket.labels.includes(labels.fix) });
  }
  return requests.sort((a, b) => a.number - b.number);
}
