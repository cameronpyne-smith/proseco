import { execFileSync } from "node:child_process";
import { expectOk } from "../core/github.ts";
import type { Finding } from "../core/types.ts";
import { toSeverity } from "../core/types.ts";
import type { ImageRouting } from "../core/config.ts";
import type { Source } from "./source.ts";

export interface DefenderRow {
  id: string;
  properties: {
    status?: { code?: string };
    additionalData?: {
      CvesDetails?: string;
      ScannersDetails?: string;
      Language?: string;
      PackageType?: string;
      SoftwareName?: string;
    };
    resourceAdditionalData?: string;
  };
}

export type ImageFinding = Omit<Finding, "repo" | "imageKey">;

interface CveDetail {
  CveId?: string;
  Severity?: string;
  FixStatus?: string;
  FixedVersion?: string;
}

interface ResourceDetails {
  ResourceAdditionalDataType?: string;
  ImageDetails?: { ImageUri?: string };
}

interface ScannerDetails {
  mdvm?: { DetectedSoftwareVersions?: unknown };
}

function parseJson<T>(text: string | undefined): T | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as T) : null;
  } catch {
    return null;
  }
}

export function bareImage(imageUri: string): string {
  return imageUri.split("@")[0]!.replace(/:[^/]*$/, "");
}

export function parseDefenderRows(rows: DefenderRow[]): { findings: ImageFinding[]; skipped: number } {
  const findings: ImageFinding[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.properties.status?.code !== "Unhealthy") continue;
    const data = row.properties.additionalData;
    const resource = parseJson<ResourceDetails>(row.properties.resourceAdditionalData);
    const imageUri = resource?.ImageDetails?.ImageUri;
    const cves = parseJson<CveDetail[]>(data?.CvesDetails);
    const scanners = data?.ScannersDetails === undefined ? {} : parseJson<ScannerDetails>(data.ScannersDetails);
    if (resource?.ResourceAdditionalDataType !== "KubernetesContainer" || !imageUri || !Array.isArray(cves) || !scanners) {
      skipped++;
      continue;
    }
    const detected = scanners.mdvm?.DetectedSoftwareVersions;
    const versions = Array.isArray(detected) ? detected.filter((version): version is string => typeof version === "string") : [];
    for (const installed of versions.length > 0 ? versions : [""]) {
      for (const detail of cves) {
        const severity = toSeverity(detail.Severity);
        if (!severity || !detail.CveId) continue;
        findings.push({
          origin: "defender",
          cve: detail.CveId,
          severity,
          ecosystem: data?.PackageType === "OS" ? "os" : data?.Language || null,
          package: data?.SoftwareName ?? "",
          installed,
          fixedIn: detail.FixStatus === "FixAvailable" ? detail.FixedVersion || null : null,
          source: bareImage(imageUri),
          relationship: null,
          scope: null,
        });
      }
    }
  }
  return { findings, skipped };
}

function longestMatch(image: string, section: Iterable<string>): string | null {
  let best: string | null = null;
  for (const prefix of section) {
    const matches = image === prefix || image.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    if (matches && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best;
}

export function assignRepos(imageFindings: ImageFinding[], routing: ImageRouting): { findings: Finding[]; ignored: number } {
  const findings: Finding[] = [];
  let ignored = 0;
  for (const finding of imageFindings) {
    const image = finding.source.toLowerCase();
    const matches = [
      { section: "own", prefix: longestMatch(image, routing.own.keys()) },
      { section: "thirdParty", prefix: longestMatch(image, routing.thirdParty.keys()) },
      { section: "ignore", prefix: longestMatch(image, routing.ignore) },
    ].filter((match): match is { section: string; prefix: string } => match.prefix !== null);
    const best = matches.sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (best?.section === "ignore") ignored++;
    else if (best?.section === "own") findings.push({ ...finding, repo: routing.own.get(best.prefix)!, imageKey: null });
    else if (best?.section === "thirdParty") findings.push({ ...finding, repo: routing.thirdParty.get(best.prefix)!, imageKey: finding.source });
    else findings.push({ ...finding, repo: null, imageKey: null });
  }
  return { findings, ignored };
}

export function defenderDiagnostics(counts: { rows: number; parsed: number; skipped: number; ignored: number }): string[] {
  const lines = [`defender rows skipped: ${counts.skipped}`, `defender findings ignored: ${counts.ignored}`];
  if (counts.rows > 0 && counts.parsed === 0) {
    lines.push(`::warning::defender returned ${counts.rows} rows but none parsed into findings; the recommendation format may have changed`);
  }
  return lines;
}

async function fetchDefenderRows(subscriptionId: string): Promise<DefenderRow[]> {
  const accessToken = execFileSync(
    "az",
    ["account", "get-access-token", "--resource", "https://management.azure.com", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf8" },
  ).trim();
  const query = [
    "securityresources",
    'where type == "microsoft.security/assessments"',
    'where properties.metadata.securityIssue == "Vulnerability"',
    'where properties.metadata.recommendationCategory == "SoftwareUpdate"',
    'where properties.status.code == "Unhealthy"',
    "project id, properties",
  ].join(" | ");
  const rows: DefenderRow[] = [];
  let skipToken: string | undefined;
  do {
    const response = await expectOk(
      await fetch("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          subscriptions: [subscriptionId],
          query,
          options: { resultFormat: "objectArray", $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) },
        }),
      }),
      "Resource Graph query",
    );
    const page = (await response.json()) as { data: DefenderRow[]; $skipToken?: string };
    rows.push(...page.data);
    skipToken = page.$skipToken;
  } while (skipToken);
  return rows;
}

export class DefenderSource implements Source {
  readonly name = "defender";
  readonly #subscriptionId: string;
  readonly #routing: ImageRouting;
  #diagnostics: string[] = [];

  constructor(subscriptionId: string, routing: ImageRouting) {
    this.#subscriptionId = subscriptionId;
    this.#routing = routing;
  }

  async fetch(): Promise<Finding[]> {
    const rows = await fetchDefenderRows(this.#subscriptionId);
    const parsed = parseDefenderRows(rows);
    const routed = assignRepos(parsed.findings, this.#routing);
    this.#diagnostics = defenderDiagnostics({ rows: rows.length, parsed: parsed.findings.length, skipped: parsed.skipped, ignored: routed.ignored });
    return routed.findings;
  }

  diagnostics(): string[] {
    return this.#diagnostics;
  }
}
