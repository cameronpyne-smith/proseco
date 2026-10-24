import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseImageRepos } from "../src/core/config.ts";
import { groupFindings, qualifies } from "../src/core/findings.ts";
import { parseEpss } from "../src/enrich/epss.ts";
import { parseKev } from "../src/enrich/kev.ts";
import { assignRepos, defenderDiagnostics, parseDefenderRows } from "../src/sources/defender.ts";
import type { DefenderRow } from "../src/sources/defender.ts";
import { parseDependabotAlerts } from "../src/sources/dependabot.ts";
import type { DependabotAlert } from "../src/sources/dependabot.ts";

function withData(row: DefenderRow, patch: Record<string, string>): DefenderRow {
  return { ...row, properties: { ...row.properties, additionalData: { ...row.properties.additionalData, ...patch } } };
}

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

describe("Defender container recommendations", () => {
  const rows = fixture<DefenderRow[]>("defender-assessments.json");
  const parsed = parseDefenderRows(rows);
  const images = parsed.findings;

  it("emits one finding per CVE per detected version and skips Unknown severity", () => {
    assert.deepEqual(
      images.map((f) => [f.cve, f.installed]),
      [
        ["CVE-2026-0001", "4.56.0"],
        ["CVE-2026-0002", "4.56.0"],
        ["CVE-2026-0001", "4.56.0"],
        ["CVE-2026-0002", "4.56.0"],
        ["CVE-2026-0003", "1.2.11"],
        ["CVE-2026-0005", "2.1.0"],
        ["CVE-2026-0005", "2.2.0"],
        ["CVE-2026-0008", ""],
      ],
    );
  });

  it("reads package, ecosystem, fix and the bare image from a container row", () => {
    assert.deepEqual(images[1], {
      origin: "defender",
      cve: "CVE-2026-0002",
      severity: "high",
      ecosystem: "dotnet",
      package: "example.client",
      installed: "4.56.0",
      fixedIn: "4.60.4",
      source: "ghcr.io/acme-org/acme-api",
      relationship: null,
      scope: null,
    });
  });

  it("qualifies only the High finding with a fix from a two-CVE row", () => {
    const own = images.slice(0, 2).map((f) => ({ ...f, repo: "acme-api", imageKey: null }));
    assert.deepEqual(own.filter(qualifies).map((f) => f.cve), ["CVE-2026-0002"]);
  });

  it("gives a Critical finding with no fix a null fixedIn, whatever FixedVersion says", () => {
    const zlib = images.find((f) => f.package === "zlib")!;
    assert.equal(zlib.severity, "critical");
    assert.equal(zlib.fixedIn, null);
    assert.equal(zlib.ecosystem, "os");
    assert.equal(zlib.source, "docker.io/library/postgres");
  });

  it("uses a null ecosystem when the language is empty and the package is not OS", () => {
    assert.equal(parseDefenderRows([withData(rows[0]!, { Language: "", PackageType: "" })]).findings[0]!.ecosystem, null);
  });

  it("strips both digest and tag from the image", () => {
    assert.deepEqual([...new Set(images.map((f) => f.source))], ["ghcr.io/acme-org/acme-api", "docker.io/library/postgres", "docker.elastic.co/kibana/kibana", "mcr.microsoft.com/oss/v2/example/agent"]);
  });

  it("emits the installed version once, empty, when no version was detected", () => {
    assert.deepEqual(images.filter((f) => f.package === "noscan").map((f) => f.installed), [""]);
  });

  it("does not emit a node pool row, and counts it with the malformed row as skipped", () => {
    assert.ok(!images.some((f) => f.package === "kernel"));
    assert.equal(parsed.skipped, 2);
  });

  it("skips and counts a row with malformed JSON in any of the three strings", () => {
    const row = rows[0]!;
    for (const patch of [{ CvesDetails: "[{" }, { ScannersDetails: "{" }] as Record<string, string>[]) {
      const result = parseDefenderRows([withData(row, patch)]);
      assert.deepEqual([result.findings.length, result.skipped], [0, 1]);
    }
    const result = parseDefenderRows([{ ...row, properties: { ...row.properties, resourceAdditionalData: "{" } }]);
    assert.deepEqual([result.findings.length, result.skipped], [0, 1]);
  });

  it("collapses the same image and package on two containers into one finding after grouping", () => {
    const groups = groupFindings(images.map((f) => ({ ...f, repo: "acme-api", imageKey: null })));
    const lines = groups.get("acme-api")!.filter((f) => f.package === "example.client");
    assert.equal(lines.length, 1);
    assert.equal(images.filter((f) => f.package === "example.client").length, 4);
  });

  describe("routing", () => {
    const routing = parseImageRepos(fixture("image-repos.json"));
    const at = (source: string) => assignRepos([{ ...images[0]!, source }], routing);
    const keyed = (source: string) => {
      const { findings } = at(source);
      return findings[0] ? [findings[0].repo, findings[0].imageKey] : "dropped";
    };

    it("routes an own image to its repository, keyed by repo", () => {
      assert.deepEqual(keyed("ghcr.io/acme-org/acme-api"), ["acme-api", null]);
    });

    it("routes a third-party image to its fix repository, keyed by the image", () => {
      assert.deepEqual(keyed("docker.elastic.co/kibana/kibana"), ["acme-infra", "docker.elastic.co/kibana/kibana"]);
      assert.deepEqual(keyed("docker.io/library/postgres"), ["acme-infra", "docker.io/library/postgres"]);
    });

    it("matches case-insensitively", () => {
      assert.deepEqual(keyed("GHCR.io/Acme-Org/Acme-Api"), ["acme-api", null]);
    });

    it("matches on a slash boundary only", () => {
      assert.deepEqual(keyed("docker.io/library/postgres/extra"), ["acme-infra", "docker.io/library/postgres/extra"]);
      assert.deepEqual(keyed("docker.io/library/postgres-extra"), [null, null]);
      assert.deepEqual(keyed("docker.io/library/postgre"), [null, null]);
    });

    it("treats an entry with a trailing slash as a plain prefix", () => {
      assert.deepEqual(keyed("mcr.microsoft.com/oss/v2/example/agent"), ["acme-infra", "mcr.microsoft.com/oss/v2/example/agent"]);
      assert.deepEqual(keyed("mcr.microsoft.com/oss/v2x/agent"), [null, null]);
    });

    it("lets the longest match win across sections", () => {
      const nested = parseImageRepos({ own: { "ghcr.io/acme-org/acme-api": "acme-api" }, thirdParty: { "ghcr.io/": "acme-infra" }, ignore: ["ghcr.io/acme-org/acme-api/tools"] });
      const route = (source: string) => assignRepos([{ ...images[0]!, source }], nested);
      assert.equal(route("ghcr.io/acme-org/acme-api").findings[0]!.repo, "acme-api");
      assert.equal(route("ghcr.io/other/app").findings[0]!.repo, "acme-infra");
      assert.deepEqual([route("ghcr.io/acme-org/acme-api/tools").findings.length, route("ghcr.io/acme-org/acme-api/tools").ignored], [0, 1]);
    });

    it("drops ignored images and counts them", () => {
      const result = assignRepos([{ ...images[0]!, source: "docker.io/library/busybox" }, { ...images[0]!, source: "docker.io/library/busybox" }, images[0]!], routing);
      assert.deepEqual([result.findings.length, result.ignored], [1, 2]);
    });

    it("sends an unmatched image to unmapped", () => {
      const [finding] = at("quay.io/example/tool").findings;
      assert.deepEqual([finding!.repo, finding!.imageKey], [null, null]);
    });
  });

  describe("diagnostics", () => {
    it("reports the counts", () => {
      assert.deepEqual(defenderDiagnostics({ rows: 10, parsed: 5, skipped: 2, ignored: 1 }), ["defender rows skipped: 2", "defender findings ignored: 1"]);
    });

    it("warns about format drift when rows came back but nothing parsed", () => {
      const lines = defenderDiagnostics({ rows: 10, parsed: 0, skipped: 10, ignored: 0 });
      assert.match(lines.at(-1)!, /format may have changed/);
      assert.equal(defenderDiagnostics({ rows: 0, parsed: 0, skipped: 0, ignored: 0 }).length, 2);
    });
  });
});

describe("image-repos routing file", () => {
  it("parses the three sections", () => {
    const routing = parseImageRepos(fixture("image-repos.json"));
    assert.equal(routing.own.get("ghcr.io/acme-org/billing-api"), "acme-billing");
    assert.equal(routing.thirdParty.get("docker.elastic.co/"), "acme-infra");
    assert.deepEqual(routing.ignore, ["docker.io/library/busybox"]);
  });

  it("requires every section, but allows an empty ignore", () => {
    assert.deepEqual(parseImageRepos({ own: {}, thirdParty: {}, ignore: [] }).ignore, []);
    assert.throws(() => parseImageRepos({ own: {}, thirdParty: {} }), /ignore/);
    assert.throws(() => parseImageRepos({ own: {}, ignore: [] }), /thirdParty/);
  });

  it("rejects unknown keys", () => {
    assert.throws(() => parseImageRepos({ own: {}, thirdParty: {}, ignore: [], extra: {} }), /unknown keys: extra/);
  });

  it("rejects a malformed prefix", () => {
    for (const bad of ["Docker.io/library/node", "node", "docker.io/library/node:18", "docker.io/library/node@sha256:0", "docker.io/lib rary/x", ""]) {
      assert.throws(() => parseImageRepos({ own: {}, thirdParty: { [bad]: "acme-infra" }, ignore: [] }), /image reference prefix/, bad);
      assert.throws(() => parseImageRepos({ own: {}, thirdParty: {}, ignore: [bad] }), /image reference prefix/, bad);
    }
  });

  it("rejects a repo given with its org, or not a string", () => {
    assert.throws(() => parseImageRepos({ own: { "ghcr.io/acme-org/x": "acme-org/x" }, thirdParty: {}, ignore: [] }), /repo name without the org/);
    assert.throws(() => parseImageRepos({ own: {}, thirdParty: { "docker.io/x": 3 }, ignore: [] }), /repo name without the org/);
  });

  it("rejects a prefix listed in two sections", () => {
    assert.throws(() => parseImageRepos({ own: { "ghcr.io/a/b": "r" }, thirdParty: { "ghcr.io/a/b": "r" }, ignore: [] }), /more than one section/);
    assert.throws(() => parseImageRepos({ own: { "ghcr.io/a/b": "r" }, thirdParty: {}, ignore: ["ghcr.io/a/b"] }), /more than one section/);
  });

  it("rejects a file that is not an object, a section that is the wrong type", () => {
    assert.throws(() => parseImageRepos([]), /must be an object/);
    assert.throws(() => parseImageRepos({ own: [], thirdParty: {}, ignore: [] }), /must be an object/);
    assert.throws(() => parseImageRepos({ own: {}, thirdParty: {}, ignore: {} }), /must be an array/);
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
