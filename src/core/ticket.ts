import { SEVERITY_RANK, UNMAPPED_KEY, compareText, epssPercent, fixesFor, sortFindings } from "./findings.ts";
import type { Enrichment, ExistingTicket, Finding, Severity } from "./types.ts";
import { toSeverity } from "./types.ts";

export interface TicketContext {
  org: string;
  maintainedIn: string;
}

export interface TicketRow {
  cve: string;
  severity: Severity;
  package: string;
  installed: string;
  fixedIn: string | null;
  source: string;
  epssPercent: number | null;
  kev: boolean;
}

const RAW_HEADER = "| CVE | severity | package | installed | fixed in | source | EPSS | KEV |";
const RAW_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const FIX_HEADER =
  "| package | installed | highest fixed-in | major upgrade | relationship | scope | severity | EPSS | KEV | findings | source |";
const FIX_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
const EPSS_COLUMN = new Map([
  [RAW_HEADER, 6],
  [FIX_HEADER, 7],
]);

export const BODY_LIMIT = 65536;

const MARKER = /^<!-- proseco:([^\s<>]+)(?: repo:([^\s<>]+))? -->/;

export function markerFor(key: string, repo?: string): string {
  return repo && repo !== key ? `<!-- proseco:${key} repo:${repo} -->` : `<!-- proseco:${key} -->`;
}

export function markerKey(body: string): string | null {
  return MARKER.exec(body)?.[1] ?? null;
}

export function markerRepo(body: string): string | null {
  const match = MARKER.exec(body);
  if (!match) return null;
  if (match[2]) return match[2];
  return match[1] === UNMAPPED_KEY ? null : match[1]!;
}

export function bodyTooLarge(body: string): boolean {
  return Buffer.byteLength(body, "utf8") > BODY_LIMIT;
}

export function isProsecoTicket(ticket: Pick<ExistingTicket, "body" | "author">, creators: string[]): boolean {
  return markerKey(ticket.body) !== null && creators.includes(ticket.author);
}

export function titleFor(key: string): string {
  return key === UNMAPPED_KEY ? "Vulnerabilities: unmapped images" : `Vulnerabilities: ${key}`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").trim();
}

function code(value: string): string {
  const text = cell(value.replaceAll("`", ""));
  return text ? `\`${text}\`` : "";
}

function percent(epss: number | null): string {
  return epss === null ? "n/a" : `${epss.toFixed(1)}%`;
}

function tableRow(columns: string[]): string {
  return `| ${columns.join(" | ")} |`;
}

function splitRow(line: string): string[] {
  return line
    .slice(2, -2)
    .split(" | ")
    .map((value) => value.replaceAll("\\|", "|"));
}

function uncode(value: string): string {
  return value.length >= 2 && value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function comparable(body: string): string {
  const lines: string[] = [];
  let rows: string[] = [];
  let epssColumn: number | undefined;
  const flush = () => {
    lines.push(...rows.sort(compareText));
    rows = [];
  };
  for (const line of body.replaceAll("\r\n", "\n").trimEnd().split("\n")) {
    if (EPSS_COLUMN.has(line)) {
      flush();
      epssColumn = EPSS_COLUMN.get(line);
      lines.push(line);
      continue;
    }
    if (epssColumn === undefined || !line.startsWith("| ") || line.startsWith("| ---")) {
      flush();
      lines.push(line);
      continue;
    }
    const cells = line.slice(2, -2).split(" | ");
    cells.splice(epssColumn, 1);
    rows.push(cells.join(" | "));
  }
  flush();
  return lines.join("\n");
}

export function sameBody(stored: string, rendered: string): boolean {
  return comparable(stored) === comparable(rendered);
}

interface Ranked {
  row: string;
  kev: boolean;
  severity: Severity;
  tiebreak: string[];
}

function byStableRank(a: Ranked, b: Ranked): number {
  return (
    Number(b.kev) - Number(a.kev) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.tiebreak.reduce((order, value, index) => order || compareText(value, b.tiebreak[index]!), 0)
  );
}

function keep(rows: Ranked[], fits: (shown: string[]) => boolean): string[] {
  const ranked = [...rows].sort(byStableRank);
  const shown = (count: number) => {
    const chosen = new Set(ranked.slice(0, count));
    return rows.filter((each) => chosen.has(each)).map((each) => each.row);
  };
  let low = 0;
  let high = ranked.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(shown(middle))) low = middle;
    else high = middle - 1;
  }
  return shown(low);
}

function omittedNote(shown: number, total: number, noun: string): string[] {
  return shown === total
    ? []
    : [`Only ${shown} of ${total} ${noun} are listed, to keep this ticket within GitHub's size limit. KEV first, then by severity; the rest are in the source alerts.`, ""];
}

export function renderBody(key: string, findings: Finding[], enrichment: Enrichment, context: TicketContext): string {
  const fixRows: Ranked[] = fixesFor(findings, enrichment, context.org).map((fix) => ({
    row: tableRow([
      code(fix.package),
      cell(fix.installed),
      cell(fix.target.join(", ")),
      fix.majorUpgrade === null ? "?" : fix.majorUpgrade ? "yes" : "no",
      fix.relationship,
      fix.scope,
      fix.severity,
      percent(fix.epss),
      fix.kev ? "yes" : "no",
      fix.alertsUrl ? `[${fix.findings.length}](${fix.alertsUrl})` : String(fix.findings.length),
      code(fix.source),
    ]),
    kev: fix.kev,
    severity: fix.severity,
    tiebreak: [fix.package, fix.installed, fix.source],
  }));
  const rawRows: Ranked[] = sortFindings(findings, enrichment).map((finding) => ({
    row: tableRow([
      cell(finding.cve),
      finding.severity,
      code(finding.package),
      cell(finding.installed),
      cell(finding.fixedIn ?? ""),
      code(finding.source),
      percent(epssPercent(finding, enrichment)),
      enrichment.kev.has(finding.cve) ? "yes" : "no",
    ]),
    kev: enrichment.kev.has(finding.cve),
    severity: finding.severity,
    tiebreak: [finding.cve, finding.package, finding.installed, finding.source],
  }));
  const repo = findings[0]?.repo ?? undefined;
  const imageTicket = repo !== undefined && repo !== key;
  const layout = (fixShown: string[], rawShown: string[]) =>
    [
      markerFor(key, repo),
      "",
      `Critical and high findings with a fix available. This ticket is maintained by proseco in ${context.maintainedIn}; the tables are rewritten on every run.`,
      "",
      "One row per package to upgrade. Severity, EPSS and KEV are the worst across the row's findings. Highest fixed-in is the largest fixed-in version among them, or every one of them when they cannot be compared. Major upgrade is yes when the first non-zero part of the version changes, and ? when a version cannot be read. Relationship and scope are as Dependabot reports them. The raw findings below are the source data for every row.",
      "",
      ...(imageTicket
        ? [
            `These findings are fixed in \`${repo}\` by bumping the image tag or chart version where it is declared. Images shipped by the managed Kubernetes service are updated by upgrading the cluster.`,
            "",
          ]
        : []),
      ...omittedNote(fixShown.length, fixRows.length, "packages"),
      FIX_HEADER,
      FIX_DIVIDER,
      ...fixShown,
      "",
      "<details>",
      `<summary>Raw findings (${rawRows.length})</summary>`,
      "",
      ...omittedNote(rawShown.length, rawRows.length, "findings"),
      RAW_HEADER,
      RAW_DIVIDER,
      ...rawShown,
      "",
      "</details>",
      "",
    ].join("\n");
  const fits = (body: string) => !bodyTooLarge(body);
  const allFixes = fixRows.map((each) => each.row);
  const fixShown = fits(layout(allFixes, [])) ? allFixes : keep(fixRows, (shown) => fits(layout(shown, [])));
  const body = layout(fixShown, keep(rawRows, (shown) => fits(layout(fixShown, shown))));
  if (!fits(body)) throw new Error(`${key}: the ticket body does not fit GitHub's limit of ${BODY_LIMIT} even with no rows`);
  return body;
}

function rawCells(body: string): string[][] {
  const rows: string[][] = [];
  let inRaw = false;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    if (line === RAW_HEADER) {
      inRaw = true;
      continue;
    }
    if (!line.startsWith("| ")) {
      inRaw = false;
      continue;
    }
    if (inRaw && !line.startsWith("| ---")) rows.push(splitRow(line));
  }
  return rows;
}

export function cvesInBody(body: string): Set<string> {
  return new Set(rawCells(body).map((cells) => cells[0]!));
}

export function parseRawTable(body: string): TicketRow[] {
  return rawCells(body).map((cells, index) => {
    const [cve, severityText, pkg, installed, fixedIn, source, epss, kev] = cells;
    const severity = toSeverity(severityText);
    if (cells.length !== 8 || !cve || !severity || (kev !== "yes" && kev !== "no")) {
      throw new Error(`raw findings row ${index + 1} does not match the ticket format: ${cells.join(" | ")}`);
    }
    const score = epss === "n/a" ? null : Number(epss!.replace(/%$/, ""));
    if (score !== null && !Number.isFinite(score)) {
      throw new Error(`raw findings row ${index + 1} has an unreadable EPSS value: ${epss}`);
    }
    return {
      cve,
      severity,
      package: uncode(pkg!),
      installed: installed!,
      fixedIn: fixedIn || null,
      source: uncode(source!),
      epssPercent: score,
      kev: kev === "yes",
    };
  });
}
