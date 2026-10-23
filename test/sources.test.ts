import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseImageRepos } from "../src/core/config.ts";
import { qualifies } from "../src/core/findings.ts";
import { parseEpss } from "../src/enrich/epss.ts";
import { parseKev } from "../src/enrich/kev.ts";
import { assignRepos, ghcrPackageName, parseDefenderRows } from "../src/sources/defender.ts";
import type { DefenderRow } from "../src/sources/defender.ts";
import { parseDependabotAlerts } from "../src/sources/dependabot.ts";
import type { DependabotAlert } from "../src/sources/dependabot.ts";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

describe("Dependabot alerts", () => {
  const alerts = fixture<DependabotAlert[]>("dependabot-alerts.json");
  const findings = parseDependabotAlerts(alerts);

  it("maps every open alert to a finding in its repository", () => {
    assert.equal(findings.length, alerts.length);
    assert.deepEqual(
      [...new Set(findings.map((f) => f.repo))].sort(),
      ["acme-assistant", "acme-e2e", "acme-help", "acme-reports"],
    );
  });

  it("falls back to the GHSA id when an advisory has no CVE", () => {
    const certifi = findings.find((f) => f.package === "certifi")!;
    assert.match(certifi.cve, /^GHSA-/);
    assert.equal(certifi.severity, "critical");
  });

  it("reports the installed version without the requirement operator", () => {
    const certifi = findings.find((f) => f.package === "certifi")!;
    assert.equal(certifi.installed, "2026.1.4");
    assert.equal(certifi.fixedIn, "2026.10.19");
    assert.equal(certifi.source, "uv.lock");
  });

  it("carries the ecosystem, relationship and scope Dependabot reports", () => {
    const alert = alerts[0]!;
    const [reported] = parseDependabotAlerts([
      { ...alert, dependency: { ...alert.dependency, relationship: "transitive", scope: "development" } },
    ]);
    assert.equal(reported!.origin, "dependabot");
    assert.equal(reported!.ecosystem, "pip");
    assert.equal(reported!.relationship, "transitive");
    assert.equal(reported!.scope, "development");
    assert.equal(findings[0]!.relationship, null);
    assert.equal(findings[0]!.scope, null);
  });

  it("drops alerts that are not open", () => {
    const dismissed = { ...alerts[0]!, state: "dismissed" };
    assert.deepEqual(parseDependabotAlerts([dismissed]), []);
  });

  it("applies the threshold over the recorded data", () => {
    const qualifying = findings.filter(qualifies);
    assert.ok(qualifying.length > 0 && qualifying.length < findings.length);
    assert.ok(qualifying.every((f) => (f.severity === "critical" || f.severity === "high") && f.fixedIn));
  });
});

describe("Defender sub-assessments", () => {
  const images = parseDefenderRows(fixture<DefenderRow[]>("defender-rows.json"));

  it("keeps only unhealthy findings", () => {
    assert.deepEqual(
      images.map((f) => f.cve),
      ["CVE-2026-1001", "CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1004"],
    );
  });

  it("reads package, versions and image from the documented shape", () => {
    assert.deepEqual(images[0], {
      origin: "defender",
      registry: "ghcr.io",
      repository: "acme-org/acme-api",
      cve: "CVE-2026-1001",
      severity: "high",
      ecosystem: null,
      package: "openssl",
      installed: "3.0.1",
      fixedIn: "3.0.2",
      source: "ghcr.io/acme-org/acme-api",
      relationship: null,
      scope: null,
    });
  });

  it("treats a finding Defender marks unpatchable as having no fix", () => {
    const zlib = images.find((f) => f.package === "zlib")!;
    assert.equal(zlib.fixedIn, null);
    assert.equal(zlib.severity, "critical");
    assert.equal(qualifies({ ...zlib, repo: null }), false);
  });

  describe("image to repo mapping", () => {
    const mapped = new Map<string, string>([["acme-api", "acme-api"]]);
    const findings = assignRepos(images, "acme-org", mapped);

    it("maps a ghcr package through the image-repos mapping", () => {
      assert.equal(findings[0]!.repo, "acme-api");
    });

    it("sends a ghcr package missing from the mapping to unmapped", () => {
      assert.equal(findings[1]!.repo, null);
    });

    it("matches the package name case-insensitively", () => {
      const upper = [{ ...images[0]!, repository: "acme-org/Acme-Api" }];
      assert.equal(assignRepos(upper, "acme-org", mapped)[0]!.repo, "acme-api");
    });

    it("sends images outside ghcr to unmapped without a package lookup", () => {
      assert.equal(findings[3]!.repo, null);
      assert.equal(ghcrPackageName(images[3]!, "acme-org"), null);
    });

    it("derives the package name from the repository path under the org", () => {
      assert.equal(ghcrPackageName(images[0]!, "acme-org"), "acme-api");
      assert.equal(ghcrPackageName({ registry: "ghcr.io", repository: "someone-else/app" }, "acme-org"), null);
    });
  });
});

describe("image-repos mapping file", () => {
  it("parses a mapping file", () => {
    const repoByPackage = parseImageRepos(fixture("image-repos.json"));
    assert.equal(repoByPackage.get("billing-api"), "acme-billing");
    assert.equal(repoByPackage.get("sync-worker"), "acme-sync");
  });

  it("rejects a package name that is not lowercase", () => {
    assert.throws(() => parseImageRepos({ "Acme-Api": "acme-api" }), /not a lowercase ghcr package name/);
  });

  it("rejects a full image reference as the key", () => {
    assert.throws(() => parseImageRepos({ "ghcr.io/acme-org/acmeapi": "acme-api" }), /not a lowercase ghcr package name/);
  });

  it("rejects a repo given with its org", () => {
    assert.throws(() => parseImageRepos({ acmeapi: "acme-org/acme-api" }), /repo name without the org/);
  });

  it("rejects a mapping that is not an object", () => {
    assert.throws(() => parseImageRepos([]), /must be an object/);
  });
});

describe("enrichment feeds", () => {
  it("parses FIRST EPSS responses, whose scores arrive as strings", () => {
    const scores = parseEpss({
      data: [
        { cve: "CVE-2026-0001", epss: "0.01234" },
        { cve: "CVE-2026-0002", epss: "0.9" },
      ],
    });
    assert.equal(scores.get("CVE-2026-0001"), 0.01234);
    assert.equal(scores.get("CVE-2026-0002"), 0.9);
  });

  it("parses the CISA KEV catalogue", () => {
    const kev = parseKev({ vulnerabilities: [{ cveID: "CVE-2021-44228" }, { cveID: "CVE-2026-0002" }] });
    assert.ok(kev.has("CVE-2021-44228"));
    assert.ok(!kev.has("CVE-2026-0001"));
  });
});
