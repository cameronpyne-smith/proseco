import { GitHubApi, expectOk } from "../core/github.ts";
import { compareVersions } from "../core/versions.ts";

const MAX_BODY_CHARS = 1500;
const MAX_TOTAL_CHARS = 12_000;
const PER_PAGE = 100;
const MAX_PAGES = 3;
const PYPI_KEYS = ["source", "repository", "homepage", "changelog"];

export interface ReleaseNote {
  tag: string;
  name: string;
  body: string;
}

export interface ReleaseNotes {
  repository: string | null;
  releases: ReleaseNote[];
  note: string | null;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
}

export function repositoryOf(value: string): string | null {
  const text = value.trim();
  const match =
    /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text) ??
    /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(text);
  return match ? `${match[1]}/${match[2]!.replace(/\.git$/, "")}` : null;
}

function versionOf(tag: string, pkg: string): string {
  let version = tag;
  for (const prefix of [`${pkg}@`, `${pkg}-`]) {
    if (version.startsWith(prefix)) {
      version = version.slice(prefix.length);
      break;
    }
  }
  return version.replace(/^v/, "");
}

function truncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function none(repository: string | null, note: string): ReleaseNotes {
  return { repository, releases: [], note };
}

export class Releases extends GitHubApi {
  readonly #plain: typeof fetch;
  readonly #cache = new Map<string, Promise<ReleaseNotes>>();

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    super(token, fetchImpl);
    this.#plain = fetchImpl;
  }

  lookup(ecosystem: string, pkg: string, installed: string, target: string): Promise<ReleaseNotes> {
    const key = JSON.stringify([ecosystem, pkg, installed, target]);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const pending = this.#load(ecosystem, pkg, installed, target).catch((error: Error) => none(null, `release notes could not be fetched: ${error.message}`));
    this.#cache.set(key, pending);
    return pending;
  }

  async #json(url: string, what: string): Promise<unknown> {
    return (await expectOk(await this.#plain(url), what)).json();
  }

  async #repository(ecosystem: string, pkg: string): Promise<string | null> {
    if (ecosystem === "npm") {
      const metadata = (await this.#json(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`, `npm metadata for ${pkg}`)) as { repository?: string | { url?: string } };
      const url = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
      return url ? repositoryOf(url) : null;
    }
    if (ecosystem === "pip") {
      const metadata = (await this.#json(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, `PyPI metadata for ${pkg}`)) as { info?: { project_urls?: Record<string, string> | null } };
      const urls = Object.entries(metadata.info?.project_urls ?? {});
      for (const key of PYPI_KEYS) {
        for (const [label, url] of urls) {
          const repository = label.toLowerCase() === key ? repositoryOf(url) : null;
          if (repository) return repository;
        }
      }
    }
    return null;
  }

  async #releases(repository: string): Promise<GitHubRelease[]> {
    const found: GitHubRelease[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await expectOk(await this.request(`/repos/${repository}/releases?per_page=${PER_PAGE}&page=${page}`), `releases of ${repository}`);
      const batch = (await response.json()) as GitHubRelease[];
      found.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return found;
  }

  async #load(ecosystem: string, pkg: string, installed: string, target: string): Promise<ReleaseNotes> {
    const repository = await this.#repository(ecosystem, pkg);
    if (!repository) return none(null, `${pkg} publishes no GitHub repository, so there are no release notes to read`);
    const inWindow = (await this.#releases(repository))
      .map((release) => ({ release, version: versionOf(release.tag_name, pkg) }))
      .filter(({ version }) => (compareVersions(version, installed) ?? -1) > 0 && (compareVersions(version, target) ?? 1) <= 0)
      .sort((a, b) => compareVersions(b.version, a.version)!);
    if (inWindow.length === 0) return none(repository, `no releases of ${repository} between ${installed} and ${target} were found`);
    let remaining = MAX_TOTAL_CHARS;
    const releases = inWindow.map(({ release }): ReleaseNote => {
      const body = truncate((release.body ?? "").trim(), Math.min(MAX_BODY_CHARS, remaining));
      remaining -= body.length;
      return { tag: release.tag_name, name: release.name ?? "", body };
    });
    return { repository, releases, note: null };
  }
}
