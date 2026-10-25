import { compareText, groupFindings } from "../core/findings.ts";
import { cvesInBody, markerKey, renderBody, sameBody, titleFor } from "../core/ticket.ts";
import type { TicketsConfig } from "../core/config.ts";
import type { TicketFilter } from "../core/github.ts";
import type { TicketContext } from "../core/ticket.ts";
import type { Enrichment, ExistingTicket, Finding } from "../core/types.ts";

export type Action =
  | { type: "create"; key: string; title: string; body: string }
  | { type: "update"; key: string; number: number; title: string; body: string }
  | { type: "close"; key: string; number: number; comment: string }
  | { type: "reopen"; key: string; number: number; title: string; body: string; comment: string }
  | { type: "noop"; key: string; number: number };

export function ticketFilters(find: TicketsConfig["find"]): TicketFilter[] {
  return [
    ...find.labels.map((labels): TicketFilter => ({ labels, state: "all" })),
    ...find.creators.map((creator): TicketFilter => ({ creator, state: "all" })),
  ];
}

export function indexTickets(tickets: ExistingTicket[]): Map<string, ExistingTicket> {
  const byKey = new Map<string, ExistingTicket>();
  for (const ticket of [...tickets].sort((a, b) => a.number - b.number)) {
    const key = markerKey(ticket.body);
    if (!key) continue;
    const current = byKey.get(key);
    if (current?.state === "open") continue;
    byKey.set(key, ticket);
  }
  return byKey;
}

export function planActions(
  findings: Finding[],
  tickets: ExistingTicket[],
  enrichment: Enrichment,
  context: TicketContext,
): Action[] {
  const groups = groupFindings(findings);
  const existing = indexTickets(tickets);
  const keys = [...new Set([...groups.keys(), ...existing.keys()])].sort(compareText);
  const actions: Action[] = [];

  for (const key of keys) {
    const group = groups.get(key);
    const ticket = existing.get(key);

    if (!group) {
      if (ticket?.state === "open") {
        actions.push({
          type: "close",
          key,
          number: ticket.number,
          comment: "No critical or high findings with a fix available remain. Closing automatically.",
        });
      }
      continue;
    }

    const title = titleFor(key);
    const body = renderBody(key, group, enrichment, context);

    if (!ticket) {
      actions.push({ type: "create", key, title, body });
      continue;
    }

    if (ticket.state === "open") {
      const unchanged = ticket.title === title && sameBody(ticket.body, body);
      actions.push(
        unchanged
          ? { type: "noop", key, number: ticket.number }
          : { type: "update", key, number: ticket.number, title, body },
      );
      continue;
    }

    if (ticket.stateReason === "not_planned") {
      const known = cvesInBody(ticket.body);
      const fresh = [...cvesInBody(body)].filter((cve) => !known.has(cve)).sort(compareText);
      actions.push(
        fresh.length === 0
          ? { type: "noop", key, number: ticket.number }
          : {
              type: "reopen",
              key,
              number: ticket.number,
              title,
              body,
              comment: `Reopening: new findings not in the last table: ${fresh.join(", ")}.`,
            },
      );
      continue;
    }

    actions.push({
      type: "reopen",
      key,
      number: ticket.number,
      title,
      body,
      comment: "Reopening: qualifying findings are present again.",
    });
  }

  return actions;
}

export function formatPlan(actions: Action[]): string {
  const lines: string[] = [];
  for (const action of actions) {
    const ref = "number" in action ? ` #${action.number}` : "";
    lines.push(`${action.type.toUpperCase()} ${action.key}${ref}`);
    if ("body" in action) lines.push(...action.body.split("\n").map((line) => `    ${line}`));
    if ("comment" in action) lines.push(`    comment: ${action.comment}`);
  }
  if (lines.length === 0) lines.push("Nothing to do.");
  return lines.join("\n");
}
