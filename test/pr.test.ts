import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PackageCheck } from "../src/fixer/check.ts";
import { commitMessage, majorTitle, renderMajorPrBody, renderPrBody, summariseDiscarded, type MajorPrBodyInput, type PrBodyInput, type PrFix } from "../src/fixer/pr.ts";

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
    tests: { kind: "passed", commands: ["npm ci --no-audit --no-fund", "npm test --if-present"], tail: "ok 1 - works" },
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
    assert.match(body, /`npm ci --no-audit --no-fund` and `npm test --if-present` passed in the sandbox/);
    assert.match(body, /ok 1 - works/);
    assert.ok(body.trimEnd().endsWith("Part of acme-org/acme-tickets#12"));
    assert.equal(body.includes("Fixes"), false);
  });

  it("names the commands that ran for any ecosystem, and says when there were no tests to run", () => {
    const python = renderPrBody(input({ tests: { kind: "passed", commands: ["uv sync --frozen", "uv run pytest -x -q"], tail: "" } }));
    assert.match(python, /`uv sync --frozen` and `uv run pytest -x -q` passed in the sandbox/);
    const none = renderPrBody(input({ tests: { kind: "no-tests", commands: ["uv sync --frozen"], tail: "" } }));
    assert.match(none, /`uv sync --frozen` passed in the sandbox; the project has no tests the fixer can run/);
  });

  it("says what failed for a draft, with the tail of the output", () => {
    const body = renderPrBody(input({ tests: { kind: "failed", step: "npm test --if-present", exitCode: 1, timedOut: false, tail: "AssertionError: boom" } }));
    assert.match(body, /Draft: `npm test --if-present` failed with exit code 1/);
    assert.match(body, /AssertionError: boom/);
    const timedOut = renderPrBody(input({ tests: { kind: "failed", step: "npm ci", exitCode: 124, timedOut: true, tail: "" } }));
    assert.match(timedOut, /`npm ci` timed out/);
  });

  it("uses a longer fence when the output contains backticks", () => {
    const body = renderPrBody(input({ tests: { kind: "passed", commands: ["npm ci"], tail: "```\ninner\n```" } }));
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
    assert.deepEqual(summariseDiscarded(["node_modules/a/i.js", "node_modules/b/i.js", "web/node_modules/x/y.js", "svc/.venv/lib/x.py", "tests/__pycache__/t.pyc", ".pytest_cache/v", "src/a.js", "src/a.js"]), ["src/a.js"]);
  });

  it("caps the list in the body and says how many more there were", () => {
    const many = Array.from({ length: 30 }, (_, index) => `f${index}.js`);
    const body = renderPrBody(input({ discarded: many }));
    assert.match(body, /- `f19\.js`\n\nand 10 more/);
    assert.equal(body.includes("f20.js"), false);
  });
});

describe("major upgrade pull request", () => {
  const nodeFetch: PrFix = { package: "node-fetch", installed: "2.6.1", target: ["3.1.1"], rows: [{ cve: "CVE-2022-0235", severity: "high" }] };

  function major(overrides: Partial<MajorPrBodyInput> = {}): MajorPrBodyInput {
    return {
      org: "acme-org",
      ticketsRepo: "acme-tickets",
      ticket: 12,
      lockfile: "package-lock.json",
      fix: nodeFetch,
      releaseTags: ["v3.0.0", "v2.7.0"],
      summary: "Changed index.js to import node-fetch dynamically because version 3 is ESM only.",
      checks: [{ package: "node-fetch", installed: ["3.3.2"], ok: true, reason: "installed 3.3.2 is at or above 3.1.1" }],
      tests: { kind: "passed", commands: ["npm ci --no-audit --no-fund", "npm test"], tail: "ok 1" },
      discarded: [],
      ...overrides,
    };
  }

  it("titles the pull request with the package and target", () => {
    assert.equal(majorTitle(nodeFetch), "Upgrade node-fetch to 3.1.1 (major)");
    assert.equal(majorTitle({ ...nodeFetch, target: ["3.1.1", "4.0.0"] }), "Upgrade node-fetch to 3.1.1 or 4.0.0 (major)");
  });

  it("has the package row, the release tags, the summary, the harness result, why it is a draft and Part of, in that order", () => {
    const body = renderMajorPrBody(major());
    const positions = [
      /\| `node-fetch` \| 2\.6\.1 → 3\.1\.1 \| CVE-2022-0235 \(high\) \|/,
      /### Breaking changes considered\n\n- `v3\.0\.0`\n- `v2\.7\.0`/,
      /### Summary[^]*dynamically/,
      /### Checks[^]*node-fetch: installed 3\.3\.2/,
      /### Why this is a draft[^]*crosses a major version[^]*person must confirm/,
      /Part of acme-org\/acme-tickets#12/,
    ].map((pattern) => {
      const match = pattern.exec(body);
      assert.ok(match, String(pattern));
      return match.index;
    });
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(body.trimEnd().endsWith("Part of acme-org/acme-tickets#12"));
    assert.equal(body.includes("Fixes"), false);
  });

  it("is a draft whether the harness passed, had no tests or failed, and never claims the upgrade is safe", () => {
    for (const tests of [major().tests, { kind: "no-tests" as const, commands: ["npm ci"], tail: "" }, { kind: "failed" as const, step: "npm test", exitCode: 1, timedOut: false, tail: "boom" }]) {
      const body = renderMajorPrBody(major({ tests }));
      assert.match(body, /### Why this is a draft/);
      assert.doesNotMatch(body, /\bsafe\b|\bready\b/i);
    }
  });

  it("reports what ran: commands that passed, the one that failed with its output, and that nothing else ran without tests", () => {
    assert.match(renderMajorPrBody(major()), /`npm ci --no-audit --no-fund` and `npm test` ran in the sandbox and exited 0/);
    assert.match(renderMajorPrBody(major()), /ok 1/);
    assert.match(renderMajorPrBody(major({ tests: { kind: "no-tests", commands: ["npm ci"], tail: "" } })), /`npm ci` ran in the sandbox and exited 0; the project has no tests the fixer can run, so nothing else ran/);
    const failed = renderMajorPrBody(major({ tests: { kind: "failed", step: "npm test", exitCode: 1, timedOut: false, tail: "AssertionError: boom" } }));
    assert.match(failed, /`npm test` failed with exit code 1 in the sandbox/);
    assert.match(failed, /AssertionError: boom/);
    assert.match(renderMajorPrBody(major({ tests: { kind: "failed", step: "npm ci", exitCode: 124, timedOut: true, tail: "" } })), /`npm ci` timed out/);
  });

  it("says so when no release notes were found", () => {
    assert.match(renderMajorPrBody(major({ releaseTags: [] })), /### Breaking changes considered\n\n_No release notes were found for this version range\._/);
  });

  it("notes a summary with nothing the diff supports", () => {
    assert.match(renderMajorPrBody(major({ summary: "" })), /no claim in the agent's summary is supported by the diff/i);
  });

  it("lists discarded paths, capped, only when there are some", () => {
    assert.equal(renderMajorPrBody(major()).includes("not committed"), false);
    const body = renderMajorPrBody(major({ discarded: Array.from({ length: 22 }, (_, index) => `f${index}.js`) }));
    assert.match(body, /### Changes not committed/);
    assert.match(body, /- `f19\.js`\n\nand 2 more/);
  });
});
