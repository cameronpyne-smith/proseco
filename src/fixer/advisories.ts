import { GitHubApi, expectOk } from "../core/github.ts";
import { compareVersions, packageKey } from "../core/versions.ts";

export interface Advisory {
  id: string;
  summary: string;
  severity: string;
  vulnerableRange: string | null;
  patchedVersion: string | null;
  affectedFunctions: string[];
  references: string[];
}

interface GlobalAdvisory {
  ghsa_id: string;
  summary: string;
  severity: string;
  references?: (string | { url: string })[] | null;
  vulnerabilities?:
    | {
        package: { ecosystem: string; name: string } | null;
        vulnerable_version_range: string | null;
        first_patched_version: string | { identifier: string } | null;
        vulnerable_functions: string[] | null;
      }[]
    | null;
}

function sameName(a: string, b: string): boolean {
  return packageKey("pip", a) === packageKey("pip", b);
}

function patched(version: string | { identifier: string } | null | undefined): string | null {
  return typeof version === "object" && version !== null ? version.identifier : (version ?? null);
}

type Vulnerability = NonNullable<GlobalAdvisory["vulnerabilities"]>[number];

function forPackage(advisory: GlobalAdvisory, pkg: string): Vulnerability[] {
  return (advisory.vulnerabilities ?? []).filter((entry) => entry.package && sameName(entry.package.name, pkg));
}

export function inRange(version: string, range: string): boolean {
  const clauses = range.split(",").map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(<=|>=|<|>|=)?\s*(\S+)$/.exec(clause);
    const order = match ? compareVersions(version, match[2]!) : null;
    if (!match || order === null) return false;
    switch (match[1] ?? "=") {
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case ">=":
        return order >= 0;
      default:
        return order === 0;
    }
  });
}

function applicable(vulnerabilities: Vulnerability[], installed: string | undefined): Vulnerability | null {
  return (installed === undefined ? undefined : vulnerabilities.find((entry) => entry.vulnerable_version_range !== null && inRange(installed, entry.vulnerable_version_range))) ?? null;
}

function summarise(advisory: GlobalAdvisory, pkg: string, installed: string | undefined): Advisory {
  const all = forPackage(advisory, pkg);
  const chosen = applicable(all, installed) ?? (all.length === 1 ? all[0] : undefined);
  const ranges = [...new Set(all.flatMap((entry) => (entry.vulnerable_version_range ? [entry.vulnerable_version_range] : [])))];
  const fixes = [...new Set(all.flatMap((entry) => (patched(entry.first_patched_version) ? [patched(entry.first_patched_version)!] : [])))];
  const pick = chosen ?? all[0];
  return {
    id: advisory.ghsa_id,
    summary: advisory.summary,
    severity: advisory.severity,
    vulnerableRange: chosen ? (chosen.vulnerable_version_range ?? null) : ranges.length > 0 ? ranges.join(" or ") : null,
    patchedVersion: chosen ? patched(chosen.first_patched_version) : fixes.length > 0 ? fixes.join(", ") : null,
    affectedFunctions: pick?.vulnerable_functions ?? [],
    references: (advisory.references ?? []).map((reference) => (typeof reference === "string" ? reference : reference.url)),
  };
}

export class Advisories extends GitHubApi {
  readonly #cache = new Map<string, Promise<GlobalAdvisory[]>>();

  #fetch(id: string): Promise<GlobalAdvisory[]> {
    const cached = this.#cache.get(id);
    if (cached) return cached;
    const pending = this.#load(id);
    this.#cache.set(id, pending);
    pending.catch(() => this.#cache.delete(id));
    return pending;
  }

  async #load(id: string): Promise<GlobalAdvisory[]> {
    const what = `advisory for ${id}`;
    if (id.startsWith("GHSA-")) {
      const response = await expectOk(await this.request(`/advisories/${encodeURIComponent(id)}`), what);
      return [(await response.json()) as GlobalAdvisory];
    }
    const response = await expectOk(await this.request(`/advisories?${new URLSearchParams({ cve_id: id })}`), what);
    return (await response.json()) as GlobalAdvisory[];
  }

  async lookup(id: string, pkg: string, installed?: string): Promise<Advisory | null> {
    const found = await this.#fetch(id);
    const named = found.filter((entry) => forPackage(entry, pkg).length > 0);
    const advisory = named.find((entry) => applicable(forPackage(entry, pkg), installed)) ?? named[0] ?? found[0];
    return advisory ? summarise(advisory, pkg, installed) : null;
  }
}
