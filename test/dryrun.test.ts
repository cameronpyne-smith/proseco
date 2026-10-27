import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TicketRow } from "../src/core/ticket.ts";
import type { Advisory } from "../src/fixer/advisories.ts";
import { dryRunReport } from "../src/fixer/dryrun.ts";
import { bodyHash } from "../src/fixer/state.ts";

const NPM_LOCK = readFileSync(new URL("./fixtures/lockfiles/acme-package-lock.json", import.meta.url), "utf8");

function row(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    cve: "CVE-2026-0001",
    severity: "high",
    package: "acme-parse",
    installed: "1.0.2",
    fixedIn: "1.0.9",
    source: "package-lock.json",
    epssPercent: null,
    kev: false,
    ...overrides,
  };
}

const ADVISORY: Advisory = {
  id: "GHSA-aaaa-bbbb-cccc",
  summary: "s",
  severity: "high",
  vulnerableRange: "< 1.0.9",
  patchedVersion: "1.0.9",
  affectedFunctions: [],
  references: [],
};

function input(rows: TicketRow[], files: Record<string, string>, overrides = {}) {
  return {
    ticket: { number: 5, repo: "acme-api", body: "body", force: false, ignored: false, commandCommentId: null },
    rows,
    org: "acme-org",
    headSha: "f".repeat(40),
    last: undefined,
    readFile: async (path: string) => files[path] ?? null,
    advisory: async (cve: string) => (cve === "CVE-2026-0001" ? ADVISORY : null),
    ...overrides,
  };
}

describe("dry run report", () => {
  it("joins each unit's rows to their advisory, parent chain, branch, ecosystem and toolchain", async () => {
    const report = await dryRunReport(
      input(
        [row(), row({ cve: "CVE-2026-0002", package: "acme-web", installed: "2.1.0", fixedIn: "3.0.0" })],
        { "package-lock.json": NPM_LOCK, ".nvmrc": "20.11\n" },
      ),
    );
    assert.equal(report.headSha, "f".repeat(40));
    assert.deepEqual(report.decision, { attempt: true, reason: "never attempted" });
    const [lockfile, major] = report.units;
    assert.equal(lockfile!.branch, "proseco/package-lock.json");
    assert.equal(lockfile!.ecosystem, "npm");
    assert.equal(lockfile!.toolchain, "20.11");
    assert.deepEqual(lockfile!.fixes[0]!.chain, ["@acme/ui", "acme-parse"]);
    assert.deepEqual(lockfile!.fixes[0]!.rows[0]!.advisory, ADVISORY);
    assert.equal(major!.branch, "proseco/acme-web-3.0.0");
    assert.deepEqual(major!.fixes[0]!.chain, ["acme-web"]);
    assert.equal(major!.fixes[0]!.rows[0]!.advisory, null);
  });

  it("reads toolchain files next to a lockfile in a subdirectory", async () => {
    const report = await dryRunReport(input([row({ source: "web/package-lock.json" })], { "web/package-lock.json": NPM_LOCK, "web/.nvmrc": "22\n" }));
    assert.equal(report.units[0]!.toolchain, "22");
  });

  it("falls back to the repository root for a toolchain file not beside the lockfile", async () => {
    const files = { "web/package-lock.json": NPM_LOCK, ".nvmrc": "20\n" };
    assert.equal((await dryRunReport(input([row({ source: "web/package-lock.json" })], files))).units[0]!.toolchain, "20");
  });

  it("prefers the file beside the lockfile over the root one, per file", async () => {
    const files = { "web/package-lock.json": NPM_LOCK, "web/.nvmrc": "22\n", ".nvmrc": "20\n" };
    assert.equal((await dryRunReport(input([row({ source: "web/package-lock.json" })], files))).units[0]!.toolchain, "22");
    const mixed = { "web/package-lock.json": NPM_LOCK, "package.json": '{"engines":{"node":">=18"}}' };
    assert.equal((await dryRunReport(input([row({ source: "web/package-lock.json" })], mixed))).units[0]!.toolchain, ">=18");
  });

  it("says when the lockfile is missing at head, has no supported ecosystem, or is an image", async () => {
    const report = await dryRunReport(input([row(), row({ source: "yarn.lock" }), row({ source: "ghcr.io/acme-org/acme-api" })], {}));
    assert.deepEqual(report.units.map((unit) => [unit.source, unit.lockfile]), [
      ["package-lock.json", "missing at head"],
      ["yarn.lock", "unsupported ecosystem"],
      ["ghcr.io/acme-org/acme-api", "not a lockfile: rebuild the image"],
    ]);
    assert.equal(report.units[0]!.fixes[0]!.chain, null);
  });

  it("reports why a ticket would not be attempted", async () => {
    const report = await dryRunReport(
      input([row()], { "package-lock.json": NPM_LOCK }, {
        last: { bodyHash: bodyHash("body"), headSha: "a", attemptedAt: "t", outcome: "gave-up", prUrls: [] },
      }),
    );
    assert.equal(report.decision.attempt, false);
    assert.match(report.decision.reason, /already attempted/);
  });
});
