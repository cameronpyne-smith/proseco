import { expectOk } from "../core/github.ts";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export function parseKev(feed: { vulnerabilities?: { cveID: string }[] }): Set<string> {
  return new Set((feed.vulnerabilities ?? []).map((entry) => entry.cveID.toUpperCase()));
}

export async function fetchKev(): Promise<Set<string>> {
  const response = await expectOk(await fetch(KEV_URL), "CISA KEV feed");
  return parseKev((await response.json()) as Parameters<typeof parseKev>[0]);
}
