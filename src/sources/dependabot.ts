import { GitHubApi } from "../core/github.ts";
import type { Finding } from "../core/types.ts";
import { toSeverity } from "../core/types.ts";
import type { Source } from "./source.ts";

export interface DependabotAlert {
  state: string;
  repository: { name: string };
  dependency: {
    manifest_path: string;
    package: { name: string; ecosystem?: string | null };
    version_requirement?: string | null;
    relationship?: string | null;
    scope?: string | null;
  };
  security_advisory: { ghsa_id: string; cve_id: string | null };
  security_vulnerability: {
    severity: string;
    first_patched_version: { identifier: string } | null;
  };
}

export function parseDependabotAlerts(alerts: DependabotAlert[]): Finding[] {
  const findings: Finding[] = [];
  for (const alert of alerts) {
    if (alert.state !== "open") continue;
    const severity = toSeverity(alert.security_vulnerability.severity);
    if (!severity) continue;
    findings.push({
      origin: "dependabot",
      repo: alert.repository.name,
      cve: alert.security_advisory.cve_id ?? alert.security_advisory.ghsa_id,
      severity,
      ecosystem: alert.dependency.package.ecosystem ?? null,
      package: alert.dependency.package.name,
      installed: (alert.dependency.version_requirement ?? "").replace(/^=\s*/, ""),
      fixedIn: alert.security_vulnerability.first_patched_version?.identifier ?? null,
      source: alert.dependency.manifest_path,
      relationship: alert.dependency.relationship ?? null,
      scope: alert.dependency.scope ?? null,
    });
  }
  return findings;
}

export class DependabotSource extends GitHubApi implements Source {
  readonly name = "dependabot";
  readonly #org: string;

  constructor(token: string, org: string) {
    super(token);
    this.#org = org;
  }

  async fetch(): Promise<Finding[]> {
    const alerts = await this.paginate<DependabotAlert>(`/orgs/${this.#org}/dependabot/alerts?state=open&per_page=100`, "Dependabot alerts");
    return parseDependabotAlerts(alerts);
  }
}
