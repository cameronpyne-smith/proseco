import type { TicketComment } from "../core/types.ts";

export const COMMENT_PREFIX = "<!-- proseco:attempt ";


export interface PrFacts {
  title: string;
  major: boolean;
  lockfile: string;
  packages: { name: string; from: string; to: string }[];
}

export type UnitOutcomeReport = { kind: "pr"; url: string; draft: boolean; announce?: boolean; facts?: PrFacts } | { kind: "none"; reason: string };

export interface UnitReport {
  label: string;
  outcome: UnitOutcomeReport;
}

export interface CommentWriter {
  comments(number: number): Promise<TicketComment[]>;
  comment(number: number, body: string): Promise<void>;
  editComment(commentId: number, body: string): Promise<void>;
}

export function renderComment(bodyHash: string, reports: UnitReport[]): string {
  const lines = [`${COMMENT_PREFIX}${bodyHash} -->`, ""];
  if (reports.length === 0) {
    lines.push("proseco found nothing to attempt on this ticket.");
  } else {
    lines.push("proseco attempted this ticket:", "");
    for (const report of reports) lines.push(unitLine(report));
  }
  return `${lines.join("\n")}\n`;
}

function unitLine(report: UnitReport): string {
  const { outcome } = report;
  return outcome.kind === "pr" ? `- ${report.label}: ${outcome.draft ? "draft" : "ready for review"}: ${outcome.url}` : `- ${report.label}: no pull request: ${outcome.reason}`;
}

export function mergeUnitLines(existing: string, reports: UnitReport[]): string | null {
  const lines = existing.trimEnd().split("\n");
  const units = lines.flatMap((line, index) => (line.startsWith("- `") ? [index] : []));
  if (units.length === 0) return null;
  let last = units[units.length - 1]!;
  for (const report of reports) {
    const index = lines.findIndex((line) => line.startsWith(`- ${report.label}: `));
    if (index !== -1) lines[index] = unitLine(report);
    else lines.splice(++last, 0, unitLine(report));
  }
  return `${lines.join("\n")}\n`;
}

async function latestComment(api: CommentWriter, ticket: number, bot: string): Promise<TicketComment | undefined> {
  const author = `${bot}[bot]`;
  return (await api.comments(ticket)).filter((comment) => comment.author === author && comment.body.startsWith(COMMENT_PREFIX)).sort((a, b) => b.id - a.id)[0];
}

export async function appendToComment(api: CommentWriter, ticket: number, bot: string, line: string): Promise<void> {
  const existing = await latestComment(api, ticket, bot);
  if (existing) await api.editComment(existing.id, `${existing.body.trimEnd()}\n${line}\n`);
}

export async function mergeIntoComment(api: CommentWriter, ticket: number, bot: string, reports: UnitReport[], fresh: string): Promise<void> {
  const existing = await latestComment(api, ticket, bot);
  const merged = existing ? mergeUnitLines(existing.body, reports) : null;
  if (!existing || merged === null) {
    await upsertComment(api, ticket, bot, fresh);
    return;
  }
  if (merged.trimEnd() !== existing.body.trimEnd()) await api.editComment(existing.id, merged);
}

export async function upsertComment(api: CommentWriter, ticket: number, bot: string, body: string): Promise<"created" | "edited" | "unchanged"> {
  const existing = await latestComment(api, ticket, bot);
  if (!existing) {
    await api.comment(ticket, body);
    return "created";
  }
  if (existing.body.trimEnd() === body.trimEnd()) return "unchanged";
  await api.editComment(existing.id, body);
  return "edited";
}
