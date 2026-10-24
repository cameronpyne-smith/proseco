import { GitHubApi, expectOk } from "../core/github.ts";
import { packageKey } from "../core/versions.ts";

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

function summarise(advisory: GlobalAdvisory, pkg: string): Advisory {
  const vulnerability = advisory.vulnerabilities?.find((entry) => entry.package && sameName(entry.package.name, pkg));
  return {
    id: advisory.ghsa_id,
    summary: advisory.summary,
    severity: advisory.severity,
    vulnerableRange: vulnerability?.vulnerable_version_range ?? null,
    patchedVersion: patched(vulnerability?.first_patched_version),
    affectedFunctions: vulnerability?.vulnerable_functions ?? [],
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

  async lookup(id: string, pkg: string): Promise<Advisory | null> {
    const found = await this.#fetch(id);
    const advisory = found.find((entry) => entry.vulnerabilities?.some((item) => item.package && sameName(item.package.name, pkg))) ?? found[0];
    return advisory ? summarise(advisory, pkg) : null;
  }
}
