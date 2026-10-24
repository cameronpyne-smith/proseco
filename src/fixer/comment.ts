import type { TicketComment } from "../core/types.ts";

export const COMMENT_PREFIX = "<!-- proseco:attempt ";

export type UnitOutcomeReport = { kind: "pr"; url: string; draft: boolean } | { kind: "none"; reason: string };

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
    for (const report of reports) {
      const { outcome } = report;
      lines.push(outcome.kind === "pr" ? `- ${report.label}: ${outcome.draft ? "draft" : "ready for review"}: ${outcome.url}` : `- ${report.label}: no pull request: ${outcome.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function upsertComment(api: CommentWriter, ticket: number, bot: string, body: string): Promise<"created" | "edited" | "unchanged"> {
  const author = `${bot}[bot]`;
  const mine = (await api.comments(ticket))
    .filter((comment) => comment.author === author && comment.body.startsWith(COMMENT_PREFIX))
    .sort((a, b) => b.id - a.id);
  const existing = mine[0];
  if (!existing) {
    await api.comment(ticket, body);
    return "created";
  }
  if (existing.body.trimEnd() === body.trimEnd()) return "unchanged";
  await api.editComment(existing.id, body);
  return "edited";
}
