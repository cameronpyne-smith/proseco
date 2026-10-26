import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PackageCheck } from "../src/fixer/check.ts";
import { breakingReleases, commitMessage, majorTitle, renderMajorPrBody, renderPrBody, summariseDiscarded, type MajorPrBodyInput, type PrBodyInput, type PrFix } from "../src/fixer/pr.ts";
import type { ReleaseNotes } from "../src/fixer/releases.ts";

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
    assert.match(body, /\| `minimist` \| 1\.2\.5 → 1\.2\.8 \(fix needs 1\.2\.6\) \| CVE-2021-44906 \(critical\)<br>CVE-2020-7598 \(medium\) \|/);
    assert.match(body, /\| `left-pad` \| 1\.0\.0 → 1\.3\.0 or 2\.0\.1 \| CVE-2026-1 \(high\) \|/);
  });

  it("shows the version the lockfile ended up with, and the target only when it differs", () => {
    const rollup: PrFix = { package: "rollup", installed: "4.46.2", target: ["4.59.0"], rows: [{ cve: "CVE-2026-9", severity: "high" }] };
    const body = renderPrBody(input({ fixes: [rollup, minimist], checks: [{ package: "rollup", installed: ["4.65.0"], ok: true, reason: "installed 4.65.0 is at or above 4.59.0" }, { package: "minimist", installed: ["1.2.6"], ok: true, reason: "ok" }] }));
    assert.match(body, /\| `rollup` \| 4\.46\.2 → 4\.65\.0 \(fix needs 4\.59\.0\) \|/);
    assert.match(body, /\| `minimist` \| 1\.2\.5 → 1\.2\.6 \|/);
    assert.match(renderPrBody(input({ fixes: [rollup], checks: [] })), /\| `rollup` \| 4\.46\.2 → 4\.59\.0 \|/);
  });

  it("shows each row the copies of its own major line when a package appears twice", () => {
    const brace1: PrFix = { package: "acme-brace", installed: "1.1.12", target: ["1.1.20"], rows: [{ cve: "CVE-2026-1", severity: "high" }] };
    const brace2: PrFix = { package: "acme-brace", installed: "2.0.2", target: ["2.1.6"], rows: [{ cve: "CVE-2026-1", severity: "high" }] };
    const body = renderPrBody(input({ fixes: [brace1, brace2], checks: [{ package: "acme-brace", from: "1.1.12", installed: ["1.1.21"], ok: true, reason: "x" }, { package: "acme-brace", from: "2.0.2", installed: ["2.1.7"], ok: true, reason: "y" }] }));
    assert.match(body, /\| `acme-brace` \| 1\.1\.12 → 1\.1\.21 \(fix needs 1\.1\.20\) \|/);
    assert.match(body, /\| `acme-brace` \| 2\.0\.2 → 2\.1\.7 \(fix needs 2\.1\.6\) \|/);
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
    const python = renderPrBody(input({ tests: { kind: "passed", commands: ["uv sync --frozen", "uv run pytest -q -rfE"], tail: "" } }));
    assert.match(python, /`uv sync --frozen` and `uv run pytest -q -rfE` passed in the sandbox/);
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
  const RELEASES: ReleaseNotes = {
    repository: "acme-org/node-fetch",
    note: null,
    releases: [
      { tag: "v3.1.1", name: "v3.1.1", body: "Fixes a header bug." },
      { tag: "v3.1.0", name: "v3.1.0", body: "Adds a feature." },
      { tag: "v3.0.0", name: "v3.0.0", body: "Now ESM only." },
      { tag: "v3.0.0-beta.9", name: "v3.0.0-beta.9", body: "BREAKING: drops CommonJS." },
      { tag: "v2.7.0", name: "v2.7.0", body: "Breaking change in how headers are joined." },
      { tag: "v2.6.2", name: "v2.6.2", body: "Fixes a typo." },
    ],
  };

  function major(overrides: Partial<MajorPrBodyInput> = {}): MajorPrBodyInput {
    return {
      org: "acme-org",
      ticketsRepo: "acme-tickets",
      ticket: 12,
      lockfile: "package-lock.json",
      fix: nodeFetch,
      releases: RELEASES,
      codeChanged: true,
      forcedMajors: [],
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
      /\| `node-fetch` \| 2\.6\.1 → 3\.3\.2 \(fix needs 3\.1\.1\) \| CVE-2022-0235 \(high\) \|/,
      /### Breaking changes considered\n\nThe agent was given the notes of 6 releases of `acme-org\/node-fetch` after 2\.6\.1, up to 3\.1\.1\. These start a new major version or mention breaking changes:\n\n- \[`v3\.0\.0`\]\(https:\/\/github\.com\/acme-org\/node-fetch\/releases\/tag\/v3\.0\.0\)\n- \[`v2\.7\.0`\]\(https:\/\/github\.com\/acme-org\/node-fetch\/releases\/tag\/v2\.7\.0\)\n\nAll release notes: https:\/\/github\.com\/acme-org\/node-fetch\/releases\n/,
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

  it("says the agent changed code only when it did", () => {
    assert.match(renderMajorPrBody(major()), /the agent changed code to adapt to it/);
    const manifestOnly = renderMajorPrBody(major({ codeChanged: false }));
    assert.doesNotMatch(manifestOnly, /changed code/);
    assert.match(manifestOnly, /crosses a major version\. The agent changed only the manifest and lockfile, but a person must confirm nothing else needs to change before this pull request can merge, whatever the sandbox run reported\./);
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
    const untested = renderMajorPrBody(major({ tests: { kind: "no-tests", commands: ["npm ci"], tail: "" } }));
    assert.match(untested, /`npm ci` ran in the sandbox and exited 0; the project has no tests the fixer can run, so nothing else ran\.\n- \*\*Untested:\*\* nothing here shows that the upgraded code works\. A build that passes can still fail when the code runs, so a person must run the project before this can merge\./);
    assert.doesNotMatch(renderMajorPrBody(major()), /Untested/);
    const failed = renderMajorPrBody(major({ tests: { kind: "failed", step: "npm test", exitCode: 1, timedOut: false, tail: "AssertionError: boom" } }));
    assert.match(failed, /`npm test` failed with exit code 1 in the sandbox/);
    assert.match(failed, /AssertionError: boom/);
    assert.match(renderMajorPrBody(major({ tests: { kind: "failed", step: "npm ci", exitCode: 124, timedOut: true, tail: "" } })), /`npm ci` timed out/);
  });

  it("says so when no release notes were found", () => {
    for (const releases of [null, { ...RELEASES, releases: [] }, { ...RELEASES, repository: null }]) {
      assert.match(renderMajorPrBody(major({ releases })), /### Breaking changes considered\n\n_No release notes were found for this version range\._/);
    }
  });

  it("says when no release starts a major version or mentions breaking changes", () => {
    const body = renderMajorPrBody(major({ releases: { ...RELEASES, releases: [RELEASES.releases[5]!] } }));
    assert.match(body, /notes of 1 release of `acme-org\/node-fetch` after 2\.6\.1, up to 3\.1\.1\. None of them starts a new major version or mentions breaking changes\.\n\nAll release notes:/);
  });

  it("picks stable releases that start a major version, including from 0.x and with package-prefixed tags, or that mention breaking changes", () => {
    const tags = (pkg: string, installed: string, list: [string, string][]) => breakingReleases(pkg, installed, list.map(([tag, body]) => ({ tag, name: "", body }))).map((release) => release.tag);
    assert.deepEqual(tags("vite", "5.4.19", [["vite@6.0.1", ""], ["vite@6.0.0", "see CHANGELOG"], ["vite@6.0.0-beta.1", "breaking"], ["vite@5.4.20", ""]]), ["vite@6.0.0"]);
    assert.deepEqual(tags("x", "0.3.1", [["0.4.1", ""], ["0.4.0", ""], ["0.3.2", "BREAKING CHANGES: none really"]]), ["0.4.0", "0.3.2"]);
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

  it("lists high-risk paths first, capped, and omits the section when there are none", () => {
    const body = renderMajorPrBody(major({ highRisk: ["Dockerfile", "package.json (scripts changed)"] }));
    assert.match(body, /^Upgrades `node-fetch`[^\n]*\n\n### High-risk paths changed\n\n[^\n]*Read these changes first:\n\n- `Dockerfile`\n- `package\.json \(scripts changed\)`\n\n\| Package/);
    assert.match(renderMajorPrBody(major({ highRisk: Array.from({ length: 25 }, (_, index) => `s${index}.sh`) })), /- and 5 more/);
    assert.doesNotMatch(renderMajorPrBody(major()), /High-risk/);
  });

  it("shows the installed version in the major body's package row", () => {
    assert.match(renderMajorPrBody(major()), /\| `node-fetch` \| 2\.6\.1 → 3\.3\.2 \(fix needs 3\.1\.1\) \|/);
  });

  it("lists the other direct dependencies that crossed a major version, with release links when known", () => {
    const body = renderMajorPrBody(major({ forcedMajors: [{ package: "svelte", from: "4.2.0", to: "5.1.0", repository: "acme-org/svelte" }, { package: "acme-plugin", from: "3.0.1", to: "5.0.0", repository: null }] }));
    assert.match(body, /### Other major upgrades\n\nThese direct dependencies also crossed a major version[^\n]*breaking changes must be checked too[^\n]*\n\n- `svelte` 4\.2\.0 → 5\.1\.0 \(\[releases\]\(https:\/\/github\.com\/acme-org\/svelte\/releases\)\)\n- `acme-plugin` 3\.0\.1 → 5\.0\.0\n/);
    assert.ok(body.indexOf("### Other major upgrades") < body.indexOf("### Summary"));
    assert.doesNotMatch(renderMajorPrBody(major()), /Other major upgrades/);
  });

  it("words a failure that also happens on the default branch accurately in the major body", () => {
    const baseline = { kind: "failed" as const, step: "npm test", exitCode: 1, timedOut: false, tail: "before tail" };
    const after = { ...baseline, tail: "after tail" };
    const body = renderMajorPrBody(major({ tests: after, comparison: { baseline, mode: "exit", fresh: [], existing: [] } }));
    assert.match(body, /- `npm test` failed with exit code 1 in the sandbox, and `npm test` also fails with exit code 1 on the default branch\. The failing tests could not be compared one by one/);
    assert.match(body, /after tail[^]*Output on the default branch[^]*before tail/);
    assert.doesNotMatch(body, /Draft:/);
    const ids = renderMajorPrBody(major({ tests: { ...after, failedIds: ["a", "b"] }, comparison: { baseline, mode: "ids", fresh: ["b"], existing: ["a"] } }));
    assert.match(ids, /1 new failing test, which pass on the default branch:\n  - `b`/);
    assert.match(ids, /1 failing test also fails on the default branch, so this change did not cause it:\n  - `a`/);
  });

  it("words a different failing step against the default branch's", () => {
    const baseline = { kind: "failed" as const, step: "npm test", exitCode: 1, timedOut: false, tail: "" };
    const body = renderPrBody(input({ tests: { ...baseline, step: "npm ci --no-audit --no-fund", exitCode: 1 }, comparison: { baseline, mode: "exit", fresh: [], existing: [] } }));
    assert.match(body, /Draft: `npm ci --no-audit --no-fund` failed with exit code 1 in the sandbox\. On the default branch the run got as far as `npm test`/);
  });
});
