import { isMajorUpgrade, packageKey } from "../core/versions.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";
import type { ReleaseNotes } from "./releases.ts";

function release(version: string): string {
  return /^v?(\d+(?:\.\d+)*)/.exec(version.trim())?.[1] ?? version;
}

export interface ForcedMajor {
  package: string;
  from: string;
  to: string;
  repository: string | null;
}

export function forcedMajors(ecosystem: Pick<Ecosystem, "directVersions" | "findingEcosystem">, before: string, after: string, upgraded: string): ForcedMajor[] {
  const skip = packageKey(ecosystem.findingEcosystem, upgraded);
  const was = ecosystem.directVersions(before);
  const found: ForcedMajor[] = [];
  for (const [name, to] of ecosystem.directVersions(after)) {
    const from = was.get(name);
    if (from === undefined || packageKey(ecosystem.findingEcosystem, name) === skip) continue;
    if (isMajorUpgrade(release(from), [release(to)])) found.push({ package: name, from, to, repository: null });
  }
  return found.sort((a, b) => (a.package < b.package ? -1 : 1));
}

export async function withRepositories(
  ecosystem: string,
  forced: ForcedMajor[],
  releases: ((ecosystem: string, pkg: string, installed: string, target: string) => Promise<ReleaseNotes>) | undefined,
): Promise<ForcedMajor[]> {
  if (!releases) return forced;
  return Promise.all(
    forced.map(async (item) => {
      try {
        return { ...item, repository: (await releases(ecosystem, item.package, item.from, item.to)).repository };
      } catch {
        return item;
      }
    }),
  );
}
