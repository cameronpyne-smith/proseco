import { execFileSync } from "node:child_process";
import { expectOk } from "../core/github.ts";
import type { Finding } from "../core/types.ts";
import { toSeverity } from "../core/types.ts";
import type { Source } from "./source.ts";

const RUNNING_IMAGES_ASSESSMENT = "c609cf0f-71ab-41e9-a3c6-9a1f7fe1b8d5";

export interface DefenderRow {
  id: string;
  properties: {
    id?: string;
    status?: { code?: string; severity?: string };
    additionalData?: {
      cve?: { title?: string }[];
      patchable?: boolean;
      imageDetails?: { registry?: string; repository?: string };
      softwareDetails?: { packageName?: string; version?: string; fixedVersion?: string };
    };
  };
}

export interface ImageFinding extends Omit<Finding, "repo"> {
  registry: string | null;
  repository: string;
}

export function parseDefenderRows(rows: DefenderRow[]): ImageFinding[] {
  const findings: ImageFinding[] = [];
  for (const row of rows) {
    const { status, additionalData } = row.properties;
    if (status?.code !== "Unhealthy") continue;
    const severity = toSeverity(status.severity);
    const repository = additionalData?.imageDetails?.repository;
    const cve = additionalData?.cve?.[0]?.title ?? row.properties.id;
    if (!severity || !repository || !cve) continue;
    const software = additionalData?.softwareDetails;
    findings.push({
      origin: "defender",
      registry: additionalData?.imageDetails?.registry ?? null,
      repository,
      cve,
      severity,
      ecosystem: null,
      package: software?.packageName ?? "",
      installed: software?.version ?? "",
      fixedIn: additionalData?.patchable === false ? null : software?.fixedVersion || null,
      source: imageName(additionalData?.imageDetails?.registry ?? null, repository),
      relationship: null,
      scope: null,
    });
  }
  return findings;
}

export function imageName(registry: string | null, repository: string): string {
  return registry ? `${registry}/${repository}` : repository;
}

export function ghcrPackageName(finding: Pick<ImageFinding, "registry" | "repository">, org: string): string | null {
  if (finding.registry?.toLowerCase() !== "ghcr.io") return null;
  const prefix = `${org.toLowerCase()}/`;
  const repository = finding.repository;
  return repository.toLowerCase().startsWith(prefix) ? repository.slice(prefix.length) : null;
}

export function assignRepos(
  imageFindings: ImageFinding[],
  org: string,
  repoByPackage: Map<string, string>,
): Finding[] {
  return imageFindings.map(({ registry, repository, ...finding }) => {
    const pkg = ghcrPackageName({ registry, repository }, org);
    return { ...finding, repo: pkg ? (repoByPackage.get(pkg.toLowerCase()) ?? null) : null };
  });
}

async function fetchDefenderRows(subscriptionId: string): Promise<DefenderRow[]> {
  const accessToken = execFileSync(
    "az",
    ["account", "get-access-token", "--resource", "https://management.azure.com", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf8" },
  ).trim();
  const query = [
    "securityresources",
    'where type == "microsoft.security/assessments/subassessments"',
    `where id has "${RUNNING_IMAGES_ASSESSMENT}"`,
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
  readonly #org: string;
  readonly #repoByPackage: Map<string, string>;

  constructor(subscriptionId: string, org: string, repoByPackage: Map<string, string>) {
    this.#subscriptionId = subscriptionId;
    this.#org = org;
    this.#repoByPackage = repoByPackage;
  }

  async fetch(): Promise<Finding[]> {
    return assignRepos(parseDefenderRows(await fetchDefenderRows(this.#subscriptionId)), this.#org, this.#repoByPackage);
  }
}
