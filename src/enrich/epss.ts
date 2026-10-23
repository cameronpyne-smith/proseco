import { expectOk } from "../core/github.ts";

const EPSS_URL = "https://api.first.org/data/v1/epss";
const EPSS_BATCH = 50;

export function parseEpss(response: { data?: { cve: string; epss: string }[] }): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of response.data ?? []) {
    const score = Number(entry.epss);
    if (Number.isFinite(score)) scores.set(entry.cve.toUpperCase(), score);
  }
  return scores;
}

export async function fetchEpss(cveIds: string[]): Promise<Map<string, number>> {
  const epss = new Map<string, number>();
  for (let index = 0; index < cveIds.length; index += EPSS_BATCH) {
    const batch = cveIds.slice(index, index + EPSS_BATCH);
    const response = await expectOk(await fetch(`${EPSS_URL}?cve=${batch.join(",")}`), "EPSS lookup");
    for (const [cve, score] of parseEpss((await response.json()) as Parameters<typeof parseEpss>[0])) {
      epss.set(cve, score);
    }
  }
  return epss;
}
