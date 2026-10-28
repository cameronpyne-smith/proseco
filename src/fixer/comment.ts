import type { TicketComment } from "../core/types.ts";

export const COMMENT_PREFIX = "<!-- proseco:attempt ";
export const WORKING = "**Working on it.**";

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

export interface PullState {
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
}

export function statusLine(pulls: PullState[]): string {
  if (pulls.some((pull) => pull.state === "open")) return "**Waiting for review:** a person reviews and merges the pull requests below.";
  if (pulls.some((pull) => pull.state === "merged")) return "**Done on proseco's side:** nothing is left open. This ticket closes when the scanner no longer sees its alerts.";
  return "**No pull request open:** the reasons are below.";
}

export function shownPulls(pulls: PullState[]): string {
  return pulls.map((pull) => `${pull.url} ${pullText(pull)}`).join("\n");
}

export function renderComment(bodyHash: string, reports: UnitReport[], status: string): string {
  const lines = [`${COMMENT_PREFIX}${bodyHash} -->`, ""];
  if (reports.length === 0) {
    lines.push("**Nothing to attempt:** proseco found nothing it can work on in this ticket.");
  } else {
    lines.push(status, "");
    for (const report of reports) lines.push(unitLine(report));
  }
  return `${lines.join("\n")}\n`;
}

export function workingComment(bodyHash: string): string {
  return `${COMMENT_PREFIX}${bodyHash} -->\n\n${WORKING}\n`;
}

function pullText(pull: Pick<PullState, "state" | "draft">): string {
  if (pull.state === "merged") return "merged";
  if (pull.state === "closed") return "closed without merging";
  return pull.draft ? "draft" : "ready for review";
}

function unitLine(report: UnitReport): string {
  const { outcome } = report;
  return outcome.kind === "pr" ? `- ${report.label}: ${pullText({ state: "open", draft: outcome.draft })}: ${outcome.url}` : `- ${report.label}: no pull request: ${outcome.reason}`;
}

export function withStatus(body: string, status: string): string {
  const lines = body.trimEnd().split("\n");
  if (lines.length > 2 && lines[1] === "") lines[2] = status;
  else lines.splice(1, 0, "", status);
  return `${lines.join("\n")}\n`;
}

export function withPulls(body: string, pulls: PullState[]): string {
  const lines = body.split("\n").map((line) => {
    const pull = pulls.find((item) => line.startsWith("- ") && line.endsWith(`: ${item.url}`));
    return pull ? line.replace(/: (?:draft|ready for review|merged|closed without merging): \S+$/, `: ${pullText(pull)}: ${pull.url}`) : line;
  });
  return lines.join("\n");
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

export async function editStatus(api: CommentWriter, ticket: number, bot: string, change: (body: string) => string, fresh: string | null): Promise<void> {
  const existing = await latestComment(api, ticket, bot);
  if (!existing) {
    if (fresh !== null) await api.comment(ticket, fresh);
    return;
  }
  const next = change(existing.body);
  if (next.trimEnd() !== existing.body.trimEnd()) await api.editComment(existing.id, next);
}

async function latestComment(api: CommentWriter, ticket: number, bot: string): Promise<TicketComment | undefined> {
  const author = `${bot}[bot]`;
  return (await api.comments(ticket)).filter((comment) => comment.author === author && comment.body.startsWith(COMMENT_PREFIX)).sort((a, b) => b.id - a.id)[0];
}

export async function appendToComment(api: CommentWriter, ticket: number, bot: string, line: string): Promise<void> {
  const existing = await latestComment(api, ticket, bot);
  if (existing) await api.editComment(existing.id, `${existing.body.trimEnd()}\n${line}\n`);
}

export async function mergeIntoComment(api: CommentWriter, ticket: number, bot: string, reports: UnitReport[], fresh: string, status: string): Promise<void> {
  const existing = await latestComment(api, ticket, bot);
  const lines = existing ? mergeUnitLines(existing.body, reports) : null;
  const merged = lines === null ? null : withStatus(lines, status);
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
