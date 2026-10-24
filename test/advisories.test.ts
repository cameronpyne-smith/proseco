import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Advisories } from "../src/fixer/advisories.ts";

const GLOBAL = {
  ghsa_id: "GHSA-aaaa-bbbb-cccc",
  cve_id: "CVE-2026-0001",
  summary: "Prototype pollution in acme-parse",
  severity: "high",
  references: ["https://example.invalid/advisory", "https://example.invalid/fix"],
  vulnerabilities: [
    { package: { ecosystem: "npm", name: "acme-other" }, vulnerable_version_range: "< 9", first_patched_version: "9.0.0", vulnerable_functions: [] },
    {
      package: { ecosystem: "npm", name: "acme-parse" },
      vulnerable_version_range: ">= 1.0.0, < 1.0.9",
      first_patched_version: "1.0.9",
      vulnerable_functions: ["parse", "merge"],
    },
  ],
};

function client(responses: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const body = responses[url];
    return body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { advisories: new Advisories("token", fetchImpl), urls };
}

describe("advisories", () => {
  const byCve = "https://api.github.com/advisories?cve_id=CVE-2026-0001";

  it("looks a CVE up by cve_id and returns the entry for the package", async () => {
    const { advisories } = client({ [byCve]: [GLOBAL] });
    assert.deepEqual(await advisories.lookup("CVE-2026-0001", "acme-parse"), {
      id: "GHSA-aaaa-bbbb-cccc",
      summary: "Prototype pollution in acme-parse",
      severity: "high",
      vulnerableRange: ">= 1.0.0, < 1.0.9",
      patchedVersion: "1.0.9",
      affectedFunctions: ["parse", "merge"],
      references: ["https://example.invalid/advisory", "https://example.invalid/fix"],
    });
  });

  it("looks a GHSA id up directly", async () => {
    const { advisories, urls } = client({ "https://api.github.com/advisories/GHSA-aaaa-bbbb-cccc": GLOBAL });
    const found = await advisories.lookup("GHSA-aaaa-bbbb-cccc", "acme-parse");
    assert.equal(found?.patchedVersion, "1.0.9");
    assert.deepEqual(urls, ["https://api.github.com/advisories/GHSA-aaaa-bbbb-cccc"]);
  });

  it("matches package names the way Python does", async () => {
    const pip = { ...GLOBAL, vulnerabilities: [{ package: { ecosystem: "pip", name: "Acme_Parse" }, vulnerable_version_range: "< 2", first_patched_version: "2.0", vulnerable_functions: null }] };
    const { advisories } = client({ [byCve]: [pip] });
    const found = await advisories.lookup("CVE-2026-0001", "acme-parse");
    assert.equal(found?.patchedVersion, "2.0");
    assert.deepEqual(found?.affectedFunctions, []);
  });

  it("returns the advisory without range data when it does not list the package", async () => {
    const { advisories } = client({ [byCve]: [GLOBAL] });
    const found = await advisories.lookup("CVE-2026-0001", "unrelated");
    assert.equal(found?.summary, "Prototype pollution in acme-parse");
    assert.equal(found?.vulnerableRange, null);
    assert.equal(found?.patchedVersion, null);
  });

  it("returns null when GitHub has no advisory for the CVE", async () => {
    const { advisories } = client({ [byCve]: [] });
    assert.equal(await advisories.lookup("CVE-2026-0001", "acme-parse"), null);
  });

  it("asks once per CVE and reuses the answer for every package", async () => {
    const { advisories, urls } = client({ [byCve]: [GLOBAL] });
    await advisories.lookup("CVE-2026-0001", "acme-parse");
    await advisories.lookup("CVE-2026-0001", "acme-other");
    assert.equal(urls.length, 1);
  });

  it("names the CVE when the request fails", async () => {
    const { advisories } = client({});
    await assert.rejects(advisories.lookup("CVE-2026-0001", "acme-parse"), /advisory for CVE-2026-0001 failed: 404/);
  });
});
