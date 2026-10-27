import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import type { TicketRow } from "../src/core/ticket.ts";
import { isImageSource, planUnits, slug } from "../src/fixer/plan.ts";

function row(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    cve: "CVE-2026-0001",
    severity: "high",
    package: "acme-parse",
    installed: "1.0.2",
    fixedIn: "1.0.9",
    source: "package-lock.json",
    epssPercent: 1.5,
    kev: false,
    ...overrides,
  };
}

function validRef(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", `refs/heads/${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MIXED: TicketRow[] = [
  row({ cve: "CVE-2026-0001" }),
  row({ cve: "CVE-2026-0002", severity: "critical", fixedIn: "1.0.5" }),
  row({ cve: "CVE-2026-0003", package: "acme-web", installed: "2.1.0", fixedIn: "3.0.0" }),
  row({ cve: "CVE-2026-0004", package: "@acme/ui", installed: "1.2.0", fixedIn: "1.2.5", source: "web/package-lock.json" }),
  row({ cve: "CVE-2026-0005", package: "acme-urllib", installed: "2.0.1", fixedIn: "2.0.5", source: "uv.lock" }),
  row({ cve: "CVE-2026-0006", package: "acme-lib", installed: "0.3.0", fixedIn: "0.3.4", source: "uv.lock" }),
];

describe("branch slugs", () => {
  it("lowercases and turns separators and other characters into single hyphens", () => {
    assert.equal(slug("Web/Package-Lock.json"), "web-package-lock.json");
    assert.equal(slug("@Acme/UI"), "acme-ui");
    assert.equal(slug("a__b  c"), "a-b-c");
  });

  it("trims hyphens from both ends", () => {
    assert.equal(slug("/src/uv/"), "src-uv");
  });
});

describe("requirements files", () => {
  it("merges rows whose package names differ only in case or separators into one fix and one unit", () => {
    const units = planUnits(
      [
        row({ cve: "CVE-2026-0011", package: "Pillow", installed: "10.0.0", fixedIn: "10.3.0", source: "scripts/parity-requirements.txt" }),
        row({ cve: "CVE-2026-0012", package: "pillow", installed: "10.0.0", fixedIn: "10.2.0", source: "scripts/parity-requirements.txt" }),
      ],
      "acme-org",
    );
    assert.equal(units.length, 1);
    assert.deepEqual([units[0]!.ecosystem, units[0]!.branch, units[0]!.fixes.length], ["requirements", "proseco/scripts-parity-requirements.txt", 1]);
    assert.equal(units[0]!.fixes[0]!.rows.length, 2);
  });
});

describe("PR units", () => {
  const units = planUnits(MIXED, "acme-org");

  it("makes one unit per lockfile for non-major rows, in lockfile order, then one per major", () => {
    assert.deepEqual(
      units.map((unit) => [unit.kind, unit.source, unit.branch, unit.fixes.map((fix) => fix.package)]),
      [
        ["lockfile", "package-lock.json", "proseco/package-lock.json", ["acme-parse"]],
        ["lockfile", "uv.lock", "proseco/uv-lock", ["acme-lib", "acme-urllib"]],
        ["lockfile", "web/package-lock.json", "proseco/web-package-lock.json", ["@acme/ui"]],
        ["major", "package-lock.json", "proseco/acme-web-3.0.0", ["acme-web"]],
      ],
    );
  });

  it("carries every raw row of a package into its fix, with the highest fixed-in as the target", () => {
    const parse = units[0]!.fixes[0]!;
    assert.deepEqual(parse.rows.map((r) => r.cve).sort(), ["CVE-2026-0001", "CVE-2026-0002"]);
    assert.deepEqual(parse.target, ["1.0.9"]);
    assert.equal(parse.severity, "critical");
  });

  it("names the ecosystem each lockfile belongs to, and null for one it cannot work on", () => {
    assert.deepEqual(units.map((unit) => unit.ecosystem), ["npm", "uv", "npm", "npm"]);
    const other = planUnits([row({ source: "yarn.lock" })], "acme-org");
    assert.equal(other[0]!.ecosystem, null);
  });

  it("groups pip names the way the ticket does, so differently spelt rows join one fix", () => {
    const joined = planUnits(
      [row({ package: "Acme_Urllib", installed: "2.0.1", fixedIn: "2.0.5", source: "uv.lock" }), row({ cve: "CVE-2", package: "acme-urllib", installed: "2.0.1", fixedIn: "2.0.6", source: "uv.lock" })],
      "acme-org",
    );
    assert.equal(joined.length, 1);
    assert.equal(joined[0]!.fixes.length, 1);
    assert.equal(joined[0]!.fixes[0]!.rows.length, 2);
  });

  it("treats a row whose fix cannot be compared as non-major", () => {
    const [unit] = planUnits([row({ fixedIn: "1.0.9" }), row({ cve: "CVE-2", fixedIn: "weird" })], "acme-org");
    assert.equal(unit!.kind, "lockfile");
  });

  it("puts an image's rows, major or not, in one image unit after the file units", () => {
    const all = planUnits(
      [
        row(),
        row({ cve: "CVE-2026-0021", package: "zlib1g", installed: "1:1.3.dfsg-3.1ubuntu2.2", fixedIn: "1:1.3.dfsg-3.1ubuntu2.3", source: "ghcr.io/acme-org/acme-api" }),
        row({ cve: "CVE-2026-0022", package: "libssl3", installed: "3.0.2", fixedIn: "4.0.0", source: "ghcr.io/acme-org/acme-api" }),
        row({ cve: "CVE-2026-0023", package: "busybox", installed: "1.36.0", fixedIn: "1.36.1", source: "localhost/acme-tools" }),
      ],
      "acme-org",
    );
    assert.deepEqual(
      all.map((unit) => [unit.kind, unit.source, unit.ecosystem, unit.fixes.map((fix) => fix.package)]),
      [
        ["lockfile", "package-lock.json", "npm", ["acme-parse"]],
        ["image", "ghcr.io/acme-org/acme-api", null, ["libssl3", "zlib1g"]],
        ["image", "localhost/acme-tools", null, ["busybox"]],
      ],
    );
  });

  it("does not take a lockfile in a dotted directory, or an unknown lockfile, for an image", () => {
    assert.equal(isImageSource("web.app/package-lock.json"), false);
    assert.equal(isImageSource("Gemfile.lock"), false);
    assert.equal(isImageSource("src/Gemfile.lock"), false);
    assert.equal(isImageSource("acme.azurecr.io/acme-api"), true);
    assert.equal(isImageSource("registry:5000/acme-api"), true);
  });

  it("returns no units for no rows", () => {
    assert.deepEqual(planUnits([], "acme-org"), []);
  });

  it("separates same-target majors of one package across lockfiles", () => {
    const majors = planUnits(
      [
        row({ package: "acme-web", installed: "2.1.0", fixedIn: "3.0.0", source: "package-lock.json" }),
        row({ package: "acme-web", installed: "2.0.0", fixedIn: "3.0.0", source: "web/package-lock.json" }),
      ],
      "acme-org",
    );
    const branches = majors.map((unit) => unit.branch);
    assert.equal(new Set(branches).size, 2);
  });

  it("always yields branch names git accepts, including for .lock files and scoped packages", () => {
    const all = planUnits(
      [...MIXED, row({ package: "@acme/core", installed: "1.0.0", fixedIn: "2.0.0", source: "uv.lock" })],
      "acme-org",
    );
    for (const unit of all) assert.ok(validRef(unit.branch), unit.branch);
    assert.ok(all.some((unit) => unit.branch === "proseco/acme-core-2.0.0"));
  });
});
