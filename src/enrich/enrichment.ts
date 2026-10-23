import type { Enrichment } from "../core/types.ts";
import { fetchEpss } from "./epss.ts";
import { fetchKev } from "./kev.ts";

export async function fetchEnrichment(cves: string[]): Promise<Enrichment> {
  const cveIds = [...new Set(cves.filter((cve) => /^CVE-/i.test(cve)))].sort();
  return { epss: await fetchEpss(cveIds), kev: await fetchKev() };
}
