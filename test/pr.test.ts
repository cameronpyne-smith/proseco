import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PackageCheck } from "../src/fixer/check.ts";
import { commitMessage, renderPrBody, summariseDiscarded, type PrBodyInput, type PrFix } from "../src/fixer/pr.ts";

const minimist: PrFix = { package: "minimist", installed: "1.2.5", target: ["1.2.6"], rows: [{ cve: "CVE-2021-44906", severity: "critical" }, { cve: "CVE-2020-7598", severity: "medium" }] };
const leftPad: PrFix = { package: "left-pad", installed: "1.0.0", target: ["1.3.0", "2.0.1"], rows: [{ cve: "CVE-2026-1", severity: "high" }] };
const checks: PackageCheck[] = [{ package: "minimist", installed: ["1.2.8"], ok: true, reason: "installed 1.2.8 is at or above 1.2.6" }];

function input(overrides: Partial<PrBodyInput> = {}): PrBodyInput {
  return {
    org: "acme-org",
    ticketsRepo: "acme-tickets",
    ticket: 12,
    lockfile: "package-lock.json",
    fixes: [minimist],
    summary: "Bumped minimist to 1.2.8.",
    checks,
    tests: { kind: "passed", tail: "ok 1 - works" },
    discarded: [],
    ...overrides,
  };
}

describe("commit and pull request title", () => {
  it("names the package and target for one fix", () => {
    assert.equal(commitMessage("package-lock.json", [minimist]), "Bump minimist to 1.2.6");
    assert.equal(commitMessage("package-lock.json", [leftPad]), "Bump left-pad to 1.3.0 or 2.0.1");
  });

  it("counts the packages and names the lockfile for several", () => {
    assert.equal(commitMessage("web/package-lock.json", [minimist, leftPad]), "Fix 2 vulnerable packages in web/package-lock.json");
  });
});

describe("pull request body", () => {
  it("has a table of packages with installed to target and CVEs with severity", () => {
    const body = renderPrBody(input({ fixes: [minimist, leftPad] }));
    assert.match(body, /\| Package \| Change \| Findings \|/);
    assert.match(body, /\| `minimist` \| 1\.2\.5 → 1\.2\.6 \| CVE-2021-44906 \(critical\)<br>CVE-2020-7598 \(medium\) \|/);
    assert.match(body, /\| `left-pad` \| 1\.0\.0 → 1\.3\.0 or 2\.0\.1 \| CVE-2026-1 \(high\) \|/);
  });

  it("includes the verified summary, the lockfile check and the test result, and ends with Part of", () => {
    const body = renderPrBody(input());
    assert.match(body, /Bumped minimist to 1\.2\.8\./);
    assert.match(body, /minimist: installed 1\.2\.8 is at or above 1\.2\.6/);
    assert.match(body, /`npm ci` and `npm test` passed/);
    assert.match(body, /ok 1 - works/);
    assert.ok(body.trimEnd().endsWith("Part of acme-org/acme-tickets#12"));
    assert.equal(body.includes("Fixes"), false);
  });

  it("says when there is no test script", () => {
    const body = renderPrBody(input({ tests: { kind: "no-tests", tail: "" } }));
    assert.match(body, /no test script/);
  });

  it("says what failed for a draft, with the tail of the output", () => {
    const body = renderPrBody(input({ tests: { kind: "failed", step: "npm test", exitCode: 1, timedOut: false, tail: "AssertionError: boom" } }));
    assert.match(body, /Draft: `npm test` failed with exit code 1/);
    assert.match(body, /AssertionError: boom/);
    const timedOut = renderPrBody(input({ tests: { kind: "failed", step: "npm ci", exitCode: 124, timedOut: true, tail: "" } }));
    assert.match(timedOut, /`npm ci` timed out/);
  });

  it("uses a longer fence when the output contains backticks", () => {
    const body = renderPrBody(input({ tests: { kind: "passed", tail: "```\ninner\n```" } }));
    assert.match(body, /\n````\n```\ninner\n```\n````\n/);
  });

  it("notes a summary with nothing the diff supports", () => {
    assert.match(renderPrBody(input({ summary: "" })), /no claim in the agent's summary is supported by the diff/i);
  });

  it("lists discarded changes only when there are some", () => {
    assert.equal(renderPrBody(input()).includes("not committed"), false);
    const body = renderPrBody(input({ discarded: ["src/a.js", "docs/b.md"] }));
    assert.match(body, /not committed/);
    assert.match(body, /- `src\/a\.js`\n- `docs\/b\.md`/);
  });

  it("escapes pipes in table cells", () => {
    const body = renderPrBody(input({ fixes: [{ ...minimist, package: "a|b" }] }));
    assert.match(body, /`a\\\|b`/);
  });
});

describe("discarded changes summary", () => {
  it("leaves out installed packages, which are not changes the agent made on purpose", () => {
    assert.deepEqual(summariseDiscarded(["node_modules/a/i.js", "node_modules/b/i.js", "web/node_modules/x/y.js", "src/a.js", "src/a.js"]), ["src/a.js"]);
  });

  it("caps the list in the body and says how many more there were", () => {
    const many = Array.from({ length: 30 }, (_, index) => `f${index}.js`);
    const body = renderPrBody(input({ discarded: many }));
    assert.match(body, /- `f19\.js`\n\nand 10 more/);
    assert.equal(body.includes("f20.js"), false);
  });
});
