import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixesFor, groupFindings } from "../src/core/findings.ts";
import { BODY_LIMIT, bodyTooLarge, cvesInBody, isProsecoTicket, markerFor, markerKey, markerRepo, parseRawTable, renderBody, titleFor } from "../src/core/ticket.ts";
import type { Enrichment, Finding } from "../src/core/types.ts";

const CONTEXT = { org: "acme-org", maintainedIn: "acme-ops" };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    origin: "dependabot",
    repo: "acme-docs",
    cve: "CVE-2026-0001",
    severity: "high",
    ecosystem: "npm",
    package: "lodash",
    installed: "4.17.0",
    fixedIn: "4.17.21",
    source: "package-lock.json",
    relationship: "transitive",
    scope: "development",
    imageKey: null,
    ...overrides,
  };
}

function enrichment(epss: Record<string, number> = {}, kev: string[] = []): Enrichment {
  return { epss: new Map(Object.entries(epss)), kev: new Set(kev) };
}

function rowCves(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("| CVE-"))
    .map((line) => line.split(" | ")[0]!.slice(2));
}

function render(key: string, findings: Finding[], enrichmentData: Enrichment): string {
  return renderBody(key, findings, enrichmentData, CONTEXT);
}

function fixes(findings: Finding[], enrichmentData: Enrichment) {
  return fixesFor(findings, enrichmentData, CONTEXT.org);
}

describe("grouping and threshold", () => {
  it("groups findings by repo and sends image findings without a repo to unmapped", () => {
    const groups = groupFindings([
      finding({ repo: "A", cve: "CVE-1" }),
      finding({ repo: "B", cve: "CVE-2" }),
      finding({ repo: "A", cve: "CVE-3" }),
      finding({ repo: null, cve: "CVE-4", source: "ghcr.io/acme-org/orphan" }),
    ]);
    assert.deepEqual([...groups.keys()].sort(), ["A", "B", "unmapped"]);
    assert.equal(groups.get("A")!.length, 2);
  });

  it("keeps only critical or high findings that have a fix", () => {
    const groups = groupFindings([
      finding({ cve: "CVE-1", severity: "critical" }),
      finding({ cve: "CVE-2", severity: "high" }),
      finding({ cve: "CVE-3", severity: "medium" }),
      finding({ cve: "CVE-4", severity: "low" }),
      finding({ cve: "CVE-5", severity: "critical", fixedIn: null }),
    ]);
    assert.deepEqual(
      groups.get("acme-docs")!.map((f) => f.cve),
      ["CVE-1", "CVE-2"],
    );
  });

  it("produces no group for a repo whose findings all fall below the threshold", () => {
    const groups = groupFindings([finding({ severity: "medium" }), finding({ fixedIn: null })]);
    assert.equal(groups.size, 0);
  });

  it("collapses the same finding reported twice", () => {
    const groups = groupFindings([finding(), finding()]);
    assert.equal(groups.get("acme-docs")!.length, 1);
  });

  it("keeps the same CVE separate when source or installed version differs", () => {
    const groups = groupFindings([finding(), finding({ source: "other/package-lock.json" }), finding({ installed: "4.0.0" })]);
    assert.equal(groups.get("acme-docs")!.length, 3);
  });
});

describe("body", () => {
  it("sorts by KEV, then EPSS, then severity", () => {
    const findings = [
      finding({ cve: "CVE-A", severity: "critical" }),
      finding({ cve: "CVE-B", severity: "high" }),
      finding({ cve: "CVE-C", severity: "high" }),
      finding({ cve: "CVE-D", severity: "critical" }),
      finding({ cve: "CVE-E", severity: "high" }),
    ];
    const body = render("acme-docs", findings, enrichment({ "CVE-B": 0.5, "CVE-C": 0.9, "CVE-D": 0.1 }, ["CVE-E"]));
    assert.deepEqual(rowCves(body), ["CVE-E", "CVE-C", "CVE-B", "CVE-D", "CVE-A"]);
  });

  it("ranks critical above high when KEV and EPSS tie", () => {
    const body = render(
      "acme-docs",
      [finding({ cve: "CVE-H", severity: "high" }), finding({ cve: "CVE-C", severity: "critical" })],
      enrichment(),
    );
    assert.deepEqual(rowCves(body), ["CVE-C", "CVE-H"]);
  });

  it("renders the same body whatever order the findings arrive in", () => {
    const findings = [
      finding({ cve: "CVE-1", package: "b" }),
      finding({ cve: "CVE-1", package: "a" }),
      finding({ cve: "CVE-2" }),
      finding({ cve: "CVE-3", severity: "critical" }),
    ];
    const forward = render("acme-docs", findings, enrichment());
    const reversed = render("acme-docs", [...findings].reverse(), enrichment());
    assert.equal(forward, reversed);
  });

  it("shows n/a for a CVE with no EPSS score and marks KEV entries", () => {
    const body = render("acme-docs", [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })], enrichment({ "CVE-2": 0.0123 }, ["CVE-2"]));
    const rows = body.split("\n").filter((line) => line.startsWith("| CVE-"));
    assert.ok(rows[0]!.endsWith("| 1.2% | yes |"));
    assert.ok(rows[1]!.endsWith("| n/a | no |"));
  });

  it("keeps scoped package names from becoming GitHub mentions", () => {
    const body = render("acme-docs", [finding({ package: "@babel/core" })], enrichment());
    assert.ok(body.includes("`@babel/core`"));
    assert.ok(!/(^|[^`])@babel/.test(body));
  });

  it("escapes pipes so a value cannot break the table", () => {
    const body = render("acme-docs", [finding({ package: "a|b" })], enrichment());
    assert.equal(body.split("\n").filter((line) => line.startsWith("| CVE-")).length, 1);
    assert.deepEqual([...cvesInBody(body)], ["CVE-2026-0001"]);
  });
});

describe("fix rows", () => {
  function fixRows(body: string): string[][] {
    return body
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => line.slice(2, -2).split(" | "));
  }

  it("folds every CVE for one package version in one lockfile into a single row", () => {
    const found = fixes(
      [
        finding({ cve: "CVE-1", package: "Pillow", ecosystem: "pip", installed: "12.3.0", fixedIn: "12.4.0", severity: "high" }),
        finding({ cve: "CVE-2", package: "pillow", ecosystem: "pip", installed: "12.3.0", fixedIn: "13.0.0", severity: "critical" }),
        finding({ cve: "CVE-3", package: "Pillow", ecosystem: "pip", installed: "12.3.0", fixedIn: "12.10.0", severity: "high" }),
      ],
      enrichment({ "CVE-1": 0.004, "CVE-3": 0.02 }, ["CVE-1"]),
    );
    assert.equal(found.length, 1);
    const [fix] = found;
    assert.equal(fix!.package, "Pillow");
    assert.deepEqual(fix!.target, ["13.0.0"]);
    assert.equal(fix!.majorUpgrade, true);
    assert.equal(fix!.severity, "critical");
    assert.equal(fix!.epss, 2);
    assert.equal(fix!.kev, true);
    assert.deepEqual(fix!.findings.map((f) => f.cve).sort(), ["CVE-1", "CVE-2", "CVE-3"]);
  });

  it("keeps a separate row per installed version and per lockfile", () => {
    const found = fixes(
      [
        finding({ cve: "CVE-1", package: "brace-expansion", installed: "1.1.12", fixedIn: "1.1.17" }),
        finding({ cve: "CVE-1", package: "brace-expansion", installed: "2.0.2", fixedIn: "2.1.3" }),
        finding({ cve: "CVE-1", package: "brace-expansion", installed: "2.0.2", fixedIn: "2.1.3", source: "web/package-lock.json" }),
      ],
      enrichment(),
    );
    assert.equal(found.length, 3);
  });

  it("does not merge npm packages whose names differ only in case", () => {
    const found = fixes([finding({ cve: "CVE-1", package: "JSONStream" }), finding({ cve: "CVE-2", package: "jsonstream" })], enrichment());
    assert.equal(found.length, 2);
  });

  it("shows relationship and scope as reported, listing both when the findings disagree", () => {
    const [fix] = fixes(
      [finding({ cve: "CVE-1", relationship: "direct", scope: "runtime" }), finding({ cve: "CVE-2", relationship: "direct", scope: null })],
      enrichment(),
    );
    assert.equal(fix!.relationship, "direct");
    assert.equal(fix!.scope, "runtime");
    const [unknown] = fixes([finding({ origin: "defender", relationship: null, scope: null })], enrichment());
    assert.equal(unknown!.relationship, "unknown");
    assert.equal(unknown!.scope, "unknown");
  });

  it("links a Dependabot row to its open alerts for that package and lockfile", () => {
    const [fix] = fixes([finding({ repo: "acme-docs", package: "@babel/core", source: "web/package-lock.json" })], enrichment());
    const url = new URL(fix!.alertsUrl!);
    assert.equal(url.origin + url.pathname, "https://github.com/acme-org/acme-docs/security/dependabot");
    assert.equal(url.searchParams.get("q"), "is:open package:@babel/core manifest:web/package-lock.json");
  });

  it("gives an image finding no Dependabot link", () => {
    const [fix] = fixes([finding({ origin: "defender", repo: "acme-api", source: "ghcr.io/acme-org/acmeapi" })], enrichment());
    assert.equal(fix!.alertsUrl, null);
  });

  it("orders rows by KEV, then EPSS, then severity", () => {
    const found = fixes(
      [
        finding({ cve: "CVE-A", package: "a", severity: "critical" }),
        finding({ cve: "CVE-B", package: "b" }),
        finding({ cve: "CVE-C", package: "c" }),
      ],
      enrichment({ "CVE-B": 0.1, "CVE-C": 0.5 }, ["CVE-B"]),
    );
    assert.deepEqual(
      found.map((fix) => fix.package),
      ["b", "c", "a"],
    );
  });

  it("renders the fix table above the raw findings, which sit collapsed with their count", () => {
    const body = render(
      "acme-docs",
      [finding({ cve: "CVE-1", fixedIn: "4.17.21" }), finding({ cve: "CVE-2", fixedIn: "5.0.0" })],
      enrichment({ "CVE-1": 0.012 }),
    );
    const rows = fixRows(body);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.slice(0, 10), ["`lodash`", "4.17.0", "5.0.0", "yes", "transitive", "development", "high", "1.2%", "no", rows[0]![9]]);
    assert.match(rows[0]![9]!, /^\[2\]\(https:\/\/github\.com\/acme-org\/acme-docs\/security\/dependabot\?q=/);
    assert.ok(body.indexOf("| package |") < body.indexOf("<details>"));
    assert.ok(body.includes("<details>\n<summary>Raw findings (2)</summary>\n\n| CVE |"));
    assert.deepEqual(rowCves(body).sort(), ["CVE-1", "CVE-2"]);
  });

  it("shows every fixed-in version and an unknown major upgrade when versions cannot be compared", () => {
    const body = render(
      "acme-docs",
      [finding({ cve: "CVE-1", fixedIn: "5.0.0" }), finding({ cve: "CVE-2", fixedIn: "5.0.0-rc.1" })],
      enrichment(),
    );
    const [row] = fixRows(body);
    assert.equal(row![2], "5.0.0, 5.0.0-rc.1");
    assert.equal(row![3], "?");
  });

  it("reads CVEs only from the raw table", () => {
    const body = render("acme-docs", [finding({ cve: "CVE-1" })], enrichment());
    assert.deepEqual([...cvesInBody(body)], ["CVE-1"]);
  });

  it("still reads CVEs from a ticket written before the fix table existed", () => {
    const legacy = [
      "<!-- proseco:acme-docs -->",
      "",
      "| CVE | severity | package | installed | fixed in | source | EPSS | KEV |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| CVE-7 | high | `lodash` | 4.17.0 | 4.17.21 | `package-lock.json` | n/a | no |",
      "",
    ].join("\r\n");
    assert.deepEqual([...cvesInBody(legacy)], ["CVE-7"]);
  });
});


describe("reading a ticket back", () => {
  it("returns every raw finding as it was rendered", () => {
    const findings = [
      finding({ cve: "CVE-1", package: "@babel/core", severity: "critical" }),
      finding({ cve: "GHSA-aaaa-bbbb-cccc", package: "acme-pipe", installed: "1.0.0|b", fixedIn: "1.0.1", source: "web/package-lock.json" }),
      finding({ cve: "CVE-3", package: "Pillow", ecosystem: "pip", installed: "12.3.0", fixedIn: "13.0.0", source: "uv.lock" }),
    ];
    const rows = parseRawTable(render("acme-docs", findings, enrichment({ "CVE-1": 0.0123 }, ["CVE-3"])));
    assert.deepEqual(
      rows.sort((a, b) => a.cve.localeCompare(b.cve)),
      [
        { cve: "CVE-1", severity: "critical", package: "@babel/core", installed: "4.17.0", fixedIn: "4.17.21", source: "package-lock.json", epssPercent: 1.2, kev: false },
        { cve: "CVE-3", severity: "high", package: "Pillow", installed: "12.3.0", fixedIn: "13.0.0", source: "uv.lock", epssPercent: null, kev: true },
        { cve: "GHSA-aaaa-bbbb-cccc", severity: "high", package: "acme-pipe", installed: "1.0.0|b", fixedIn: "1.0.1", source: "web/package-lock.json", epssPercent: null, kev: false },
      ],
    );
  });

  it("reads a ticket written before the fix table existed, with Windows line endings", () => {
    const legacy = [
      "<!-- proseco:acme-docs -->",
      "",
      "| CVE | severity | package | installed | fixed in | source | EPSS | KEV |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| CVE-7 | high | `lodash` | 4.17.0 | 4.17.21 | `package-lock.json` | 0.4% | no |",
      "",
    ].join("\r\n");
    assert.deepEqual(parseRawTable(legacy), [
      { cve: "CVE-7", severity: "high", package: "lodash", installed: "4.17.0", fixedIn: "4.17.21", source: "package-lock.json", epssPercent: 0.4, kev: false },
    ]);
  });

  it("refuses a raw row that does not match the format instead of guessing", () => {
    const edited = render("acme-docs", [finding()], enrichment()).replace("| high | `lodash`", "| severe | `lodash`");
    assert.throws(() => parseRawTable(edited), /row 1 does not match the ticket format/);
  });

  it("refuses a raw row whose package or source could reach outside the repository or a shell", () => {
    const body = (pkg: string, source: string) => render("acme-docs", [finding({ package: pkg, source })], enrichment());
    for (const pkg of ["a b", "x;rm", "$(id)", "../x", "a/b", "@scope", "-x"]) assert.throws(() => parseRawTable(body(pkg, "package-lock.json")), /invalid package name/, pkg);
    for (const source of ["../package-lock.json", "/etc/x", "a//b", "a/./b", "a/../b", "a b/uv.lock", "a\\b"]) assert.throws(() => parseRawTable(body("lodash", source)), /invalid source path/, source);
    for (const pkg of ["@babel/core", "Pillow", "zope.interface", "Newtonsoft.Json", "libstdc++6", "libssl1.1", "python3.11-minimal", "gcc-12-base"]) assert.equal(parseRawTable(body(pkg, "web/package-lock.json"))[0]!.package, pkg);
    assert.equal(parseRawTable(body("lodash", "ghcr.io/acme/app:1.2"))[0]!.source, "ghcr.io/acme/app:1.2");
  });

  it("recognises a proseco ticket by its marker on the first line and an author it trusts", () => {
    const body = render("acme-docs", [finding()], enrichment());
    assert.equal(isProsecoTicket({ body, author: "proseco-bot[bot]" }, ["proseco-bot[bot]"]), true);
    assert.equal(isProsecoTicket({ body, author: "someone" }, ["proseco-bot[bot]"]), false);
    assert.equal(isProsecoTicket({ body: `Copied:\n${body}`, author: "proseco-bot[bot]" }, ["proseco-bot[bot]"]), false);
  });
});

describe("image findings", () => {
  const KIBANA = "docker.elastic.co/kibana/kibana";
  const image = (overrides: Partial<Finding> = {}) =>
    finding({ origin: "defender", repo: "acme-infra", imageKey: KIBANA, ecosystem: "os", package: "openssl", installed: "3.0.1", fixedIn: "3.0.2", source: KIBANA, relationship: null, scope: null, ...overrides });

  it("keys an own-image or Dependabot finding by repo, a third-party finding by image, and the rest as unmapped", () => {
    const groups = groupFindings([
      finding({ repo: "A", cve: "CVE-1" }),
      image({ cve: "CVE-2" }),
      image({ cve: "CVE-3", repo: null, imageKey: null }),
      finding({ origin: "defender", repo: "acme-api", imageKey: null, cve: "CVE-4", source: "ghcr.io/acme-org/acme-api" }),
    ]);
    assert.deepEqual([...groups.keys()].sort(), [KIBANA, "A", "acme-api", "unmapped"].sort());
  });

  it("collapses the same image and package seen on several containers into one finding", () => {
    const groups = groupFindings([image(), image(), image(), image({ installed: "3.0.5" })]);
    assert.equal(groups.get(KIBANA)!.length, 2);
  });

  it("round-trips an image key and its repo through marker, render and parse", () => {
    const body = render(KIBANA, [image()], enrichment());
    assert.equal(body.split("\n")[0], `<!-- proseco:${KIBANA} repo:acme-infra -->`);
    assert.equal(markerKey(body), KIBANA);
    assert.equal(markerRepo(body), "acme-infra");
    assert.equal(titleFor(KIBANA), `Vulnerabilities: ${KIBANA}`);
    assert.deepEqual(parseRawTable(body).map((row) => [row.cve, row.source, row.package]), [["CVE-2026-0001", KIBANA, "openssl"]]);
    assert.match(body, /fixed in `acme-infra` by bumping the image tag or chart version where it is declared/);
    assert.match(body, /upgrading the cluster/);
    assert.ok(body.indexOf("fixed in `acme-infra`") < body.indexOf("| package |"));
  });

  it("states the fix location only on image tickets, and writes no repo on a repo ticket", () => {
    const body = render("acme-docs", [finding()], enrichment());
    assert.equal(body.split("\n")[0], "<!-- proseco:acme-docs -->");
    assert.doesNotMatch(body, /bumping the image tag/);
    assert.equal(markerRepo(body), "acme-docs");
  });
});

describe("markers", () => {
  it("renders repo only when the key is not itself the repo", () => {
    assert.equal(markerFor("acme-api"), "<!-- proseco:acme-api -->");
    assert.equal(markerFor("acme-api", "acme-api"), "<!-- proseco:acme-api -->");
    assert.equal(markerFor("docker.io/library/postgres", "acme-infra"), "<!-- proseco:docker.io/library/postgres repo:acme-infra -->");
  });

  it("reads old markers and the unmapped marker", () => {
    assert.equal(markerRepo("<!-- proseco:Acme.Repo1 -->\n\nbody"), "Acme.Repo1");
    assert.equal(markerKey("<!-- proseco:Acme.Repo1 -->\n\nbody"), "Acme.Repo1");
    assert.equal(markerRepo("<!-- proseco:unmapped -->"), null);
    assert.equal(markerKey("<!-- proseco:unmapped -->"), "unmapped");
    assert.equal(markerRepo("no marker"), null);
    assert.equal(markerKey("no marker"), null);
  });
});

describe("body size", () => {
  const KIBANA_IMAGE = "docker.elastic.co/kibana/kibana";
  const many = (count: number, overrides: (index: number) => Partial<Finding> = () => ({})) =>
    Array.from({ length: count }, (_, index) =>
      finding({
        origin: "defender",
        repo: "acme-infra",
        imageKey: KIBANA_IMAGE,
        cve: `CVE-2026-${String(index).padStart(5, "0")}`,
        package: `package-${index % 150}`,
        installed: `1.0.${index % 150}`,
        fixedIn: `1.1.${index % 150}`,
        source: `${KIBANA_IMAGE}:8.15.0`,
        ...overrides(index),
      }),
    );

  it("measures the body in UTF-8 bytes, which is never less than GitHub's character count", () => {
    assert.equal(BODY_LIMIT, 65536);
    assert.equal(bodyTooLarge("x".repeat(65536)), false);
    assert.equal(bodyTooLarge("x".repeat(65537)), true);
    assert.equal(bodyTooLarge("é".repeat(32769)), true);
  });

  it("renders a small body whole, with no note", () => {
    const body = render(KIBANA_IMAGE, many(3), enrichment());
    assert.equal(parseRawTable(body).length, 3);
    assert.doesNotMatch(body, /are listed, to keep this ticket within GitHub's size limit/);
  });

  it("lists as many raw findings as fit, KEV then critical first, and says how many it left out", () => {
    const findings = many(900, (index) => ({ severity: index % 3 === 0 ? "critical" : "high" }));
    const body = render(KIBANA_IMAGE, findings, enrichment({}, ["CVE-2026-00899"]));
    assert.equal(bodyTooLarge(body), false);
    const rows = parseRawTable(body);
    assert.ok(rows.length > 100 && rows.length < 900);
    assert.match(body, new RegExp(`<summary>Raw findings \\(900\\)</summary>\n\nOnly ${rows.length} of 900 findings are listed`));
    assert.ok(rows.some((row) => row.cve === "CVE-2026-00899"));
    assert.equal(rows.filter((row) => row.severity === "critical").length, 300);
    assert.equal(fixesFor(findings, enrichment(), "acme-org").length, body.split("\n").filter((line) => line.startsWith("| `package-")).length);
  });

  it("lists the same findings whatever their EPSS, so a daily score change does not rewrite the ticket", () => {
    const findings = many(900);
    const scores = (seed: number) => Object.fromEntries(findings.map((each, index) => [each.cve, ((index * seed) % 97) / 100]));
    assert.deepEqual(new Set(rowCves(render(KIBANA_IMAGE, findings, enrichment(scores(7))))), new Set(rowCves(render(KIBANA_IMAGE, findings, enrichment(scores(13))))));
  });

  it("trims the package table too when it alone would not fit", () => {
    const findings = many(1200, (index) => ({ package: `package-${index}-${"x".repeat(60)}`, installed: `1.0.${index}` }));
    const body = render(KIBANA_IMAGE, findings, enrichment());
    assert.equal(bodyTooLarge(body), false);
    assert.match(body, /Only \d+ of 1200 packages are listed/);
    assert.match(body, /Only 0 of 1200 findings are listed/);
    assert.deepEqual(parseRawTable(body), []);
  });
});
