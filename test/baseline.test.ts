import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compareTests, isRegression } from "../src/fixer/baseline.ts";
import type { PreflightBox } from "../src/fixer/ecosystems/ecosystem.ts";
import { DIFF_SCRIPT, npm } from "../src/fixer/ecosystems/npm.ts";
import { npmFailures, pytestFailures, pythonSources } from "../src/fixer/ecosystems/pytest.ts";
import { requirements } from "../src/fixer/ecosystems/requirements.ts";
import { uv } from "../src/fixer/ecosystems/uv.ts";
import type { TestOutcome } from "../src/fixer/pr.ts";
import { failureExcerpt } from "../src/fixer/excerpt.ts";
import { lockfileStatus } from "../src/fixer/status.ts";
import { crossedMajors, gatherReview, lockfileMajorMessage, rankReviewLines, refusedChecksMessage, reviewMessage, type PackageReview } from "../src/fixer/review.ts";

function failed(overrides: Partial<Extract<TestOutcome, { kind: "failed" }>> = {}): Extract<TestOutcome, { kind: "failed" }> {
  return { kind: "failed", step: "pytest", exitCode: 1, timedOut: false, tail: "", ...overrides };
}

const PASSED: TestOutcome = { kind: "passed", commands: ["install", "pytest"], tail: "" };

describe("pytestFailures", () => {
  it("collects FAILED and ERROR ids from the short summary and ignores everything else", () => {
    const output = [
      "tests/test_a.py .F",
      "=========== short test summary info ===========",
      "FAILED tests/test_a.py::test_net - ConnectionError: boom",
      "ERROR tests/test_b.py - ImportError: nope",
      "FAILED tests/test_a.py::test_net - again",
      "1 failed, 1 error",
    ].join("\n");
    assert.deepEqual(pytestFailures(output), ["tests/test_a.py::test_net", "tests/test_b.py"]);
    assert.equal(pytestFailures("3 passed"), null);
  });

  it("keeps the whole id, brackets and spaces included, and drops only the trailing message", () => {
    const output = ["FAILED tests/t.py::test_x[a b-1] - AssertionError: nope - really", "ERROR tests/t.py::test_y[\u001b[31mred\u001b[0m]", "FAILED tests/t.py::test_z"].join("\n");
    assert.deepEqual(pytestFailures(output), ["tests/t.py::test_x[a b-1]", "tests/t.py::test_y[red]", "tests/t.py::test_z"]);
  });

  it("is what the python harnesses use, and they no longer stop at the first failure", () => {
    for (const ecosystem of [uv, requirements]) {
      const plan = ecosystem.harness("a.lock");
      assert.equal(plan.failures, pytestFailures);
      assert.doesNotMatch(plan.test, /-x/);
      assert.match(plan.test, /-rfE/);
    }
    assert.equal(npm.harness("package-lock.json").failures, npmFailures);
  });
});

describe("npmFailures", () => {
  it("reads jest and vitest file and test failures", () => {
    const jest = ["PASS src/ok.test.js", "FAIL src/a.test.js (3.2 s)", "  ✕ adds numbers (5 ms)", "  × handles empty input 12 ms", "Tests: 2 failed"].join("\n");
    assert.deepEqual(npmFailures(jest), ["adds numbers", "handles empty input", "src/a.test.js"]);
    assert.deepEqual(npmFailures(" \u001b[41m FAIL \u001b[49m  src/b.test.ts > suite > works"), ["src/b.test.ts > suite > works"]);
  });

  it("reads mocha's numbered failures, node's test runner and TAP", () => {
    const mocha = ["  3 passing", "  2 failing", "", "  1) Suite", "       does a thing:", "     AssertionError", "  2) Other suite", "       does another:"].join("\n");
    assert.deepEqual(npmFailures(mocha), ["Other suite", "Suite"]);
    assert.deepEqual(npmFailures("✖ rejects bad input (1.2ms)\nnot ok 4 - tap case\n"), ["rejects bad input", "tap case"]);
  });

  it("finds nothing in output without failures", () => {
    assert.equal(npmFailures("PASS src/a.test.js\nTests: 3 passed\nnpm error code ELIFECYCLE\n"), null);
  });
});

describe("compareTests", () => {
  it("has nothing to compare when the default branch passed", () => {
    assert.equal(compareTests(PASSED, failed()), null);
    assert.equal(compareTests(null, failed()), null);
    assert.equal(compareTests({ kind: "no-tests", commands: ["install"], tail: "" }, failed()), null);
  });

  it("splits failing ids into new and pre-existing, and only the new ones are a regression", () => {
    const comparison = compareTests(failed({ failedIds: ["a", "b"] }), failed({ failedIds: ["b", "c"] }))!;
    assert.deepEqual([comparison.mode, comparison.fresh, comparison.existing], ["ids", ["c"], ["b"]]);
    assert.equal(isRegression(failed({ failedIds: ["b", "c"] }), comparison), true);
    const same = compareTests(failed({ failedIds: ["a", "b"] }), failed({ failedIds: ["b"] }))!;
    assert.equal(isRegression(failed({ failedIds: ["b"] }), same), false);
  });

  it("falls back to the exit status when ids are missing, a step differs or a run timed out, and that is a regression", () => {
    for (const after of [failed(), failed({ failedIds: ["a"], step: "install" }), failed({ failedIds: ["a"], timedOut: true })]) {
      const comparison = compareTests(failed({ failedIds: ["a"] }), after)!;
      assert.equal(comparison.mode, "exit");
      assert.equal(isRegression(after, comparison), true);
    }
  });

  it("reports tests that now pass, and a passing run is never a regression", () => {
    const comparison = compareTests(failed(), PASSED)!;
    assert.equal(comparison.mode, "cleared");
    assert.equal(isRegression(PASSED, comparison), false);
    assert.equal(isRegression(failed(), null), true);
  });
});

type Drifted = { removed: number; added: number; changed: number; exact?: boolean; sameVersion?: boolean };

function box(drifts: Record<string, Drifted | "fail">) {
  const scripts: string[] = [];
  const fake: PreflightBox = {
    async run(command) {
      const script = command[2]!;
      scripts.push(script);
      const resolver = /cd "\$d" && (.+?) install --package-lock-only/.exec(script)![1]!;
      const drift = drifts[resolver];
      if (!drift || drift === "fail") return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      const full = { exact: drift.removed + drift.added + drift.changed === 0, sameVersion: true, ...drift };
      return { exitCode: 0, stdout: `noise\nPRESOLVE ${JSON.stringify(full)}\n`, stderr: "", timedOut: false };
    },
  };
  return { fake, scripts };
}

const CLEAN = { removed: 0, added: 0, changed: 0 };

describe("npm preflight", () => {
  it("says nothing when the bundled npm leaves the untouched lockfile exactly alone", async () => {
    const { fake, scripts } = box({ npm: CLEAN });
    const result = await npm.preflight!(fake, "web/package-lock.json", 1000);
    assert.deepEqual([result.notes, result.tool], [[], undefined]);
    assert.equal(scripts.length, 1);
  });

  it("works on a scratch copy and never in /work itself", async () => {
    const { fake, scripts } = box({ npm: CLEAN });
    await npm.preflight!(fake, "web/package-lock.json", 1000);
    assert.match(scripts[0]!, /mktemp -d \/tmp\/preflight/);
    assert.match(scripts[0]!, /tar -C '\/work\/web' --exclude=node_modules --exclude=\.git/);
    assert.match(scripts[0]!, /rm -rf "\$d"/);
    assert.doesNotMatch(scripts[0]!, /cd \/work|cd '\/work/);
  });

  it("compares the whole lockfile, not only the packages map", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-diff-"));
    const write = (name: string, value: unknown) => {
      writeFileSync(join(dir, name), JSON.stringify(value));
      return join(dir, name);
    };
    const packages = { "": { name: "x" }, "node_modules/a": { version: "1.0.0" } };
    const v3 = write("v3.json", { name: "x", lockfileVersion: 3, packages });
    const v2 = write("v2.json", { name: "x", lockfileVersion: 2, packages, dependencies: { a: { version: "1.0.0" } } });
    const same = write("same.json", { packages, lockfileVersion: 3, name: "x" });
    const drift = (a: string, b: string) => JSON.parse(spawnSync("node", ["-e", DIFF_SCRIPT, a, b], { encoding: "utf8" }).stdout.replace("PRESOLVE ", "")) as Record<string, unknown>;
    assert.deepEqual(drift(v3, v2), { removed: 0, added: 0, changed: 0, swapped: 0, exact: false, sameVersion: false });
    const entry = (extra: Record<string, unknown>) => ({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-aaa", ...extra } } });
    const honest = write("honest.json", entry({}));
    const swapped = write("swapped.json", entry({ integrity: "sha512-evil" }));
    const aliased = write("aliased.json", entry({ name: "evil" }));
    const moved = write("moved.json", entry({ resolved: "https://evil.invalid/a/-/a-1.0.0.tgz" }));
    for (const other of [swapped, aliased, moved]) assert.equal(drift(honest, other).swapped, 1);
    assert.equal(drift(honest, honest).swapped, 0);
    assert.deepEqual(drift(v3, same), { removed: 0, added: 0, changed: 0, swapped: 0, exact: true, sameVersion: true });
  });

  it("tries older majors newest first and tells the agent the exact command of the first that leaves it exactly unchanged", async () => {
    const { fake, scripts } = box({ npm: { removed: 300, added: 0, changed: 2 }, "npx -y npm@10": { removed: 120, added: 0, changed: 0 }, "npx -y npm@9": "fail", "npx -y npm@8": CLEAN });
    const { notes, tool, summary } = await npm.preflight!(fake, "package-lock.json", 1000);
    const [note, ...more] = notes;
    assert.equal(tool, "npx -y npm@8");
    assert.equal(more.length, 0);
    assert.match(note!, /300 removed, 0 added, 2 changed/);
    assert.match(note!, /`npx -y npm@8 install --package-lock-only --no-audit --no-fund`/);
    assert.match(note!, /in place of `npm` for every npm command/);
    assert.match(note!, /`npx -y npm@8 ci --no-audit --no-fund` for installing/);
    assert.doesNotMatch(note!, /are not affected/);
    assert.match(summary!, /npm: 300 removed, 0 added, 2 changed; npx -y npm@10: 120 removed, 0 added, 0 changed; npx -y npm@9: failed; npx -y npm@8: exact/);
    assert.equal(scripts.length, 4);
  });

  it("does not take an older npm that has the same packages but rewrites lockfileVersion", async () => {
    const { fake } = box({ npm: { removed: 5, added: 0, changed: 0 }, "npx -y npm@10": { removed: 5, added: 0, changed: 0 }, "npx -y npm@9": "fail", "npx -y npm@8": "fail", "npx -y npm@7": { removed: 0, added: 0, changed: 0, exact: false, sameVersion: false } });
    const { notes, tool, summary } = await npm.preflight!(fake, "package-lock.json", 1000);
    assert.equal(tool, undefined);
    assert.match(notes[0]!, /No npm available in the sandbox reproduces this lockfile exactly/);
    assert.match(notes[0]!, /sandbox's npm is the closest[^]*changes 5 packages unrelated to the task \(5 removed, 0 added, 0 changed\)/);
    assert.match(summary!, /npx -y npm@7: 0 removed, 0 added, 0 changed, lockfileVersion rewritten/);
  });

  it("picks the candidate with the smallest drift that keeps lockfileVersion, and the bundled npm on a tie", async () => {
    const smaller = box({ npm: { removed: 300, added: 0, changed: 0 }, "npx -y npm@10": { removed: 40, added: 0, changed: 0 }, "npx -y npm@9": { removed: 90, added: 0, changed: 0 }, "npx -y npm@8": "fail", "npx -y npm@7": { removed: 1, added: 0, changed: 0, sameVersion: false } });
    const result = await npm.preflight!(smaller.fake, "package-lock.json", 1000);
    assert.equal(result.tool, "npx -y npm@10");
    assert.match(result.notes[0]!, /`npx -y npm@10` is the closest[^]*40 packages[^]*Use `npx -y npm@10` in place of `npm` for every npm command, `ci` and `test` included/);
    const tie = box({ npm: { removed: 7, added: 0, changed: 0 }, "npx -y npm@10": { removed: 7, added: 0, changed: 0 }, "npx -y npm@9": "fail", "npx -y npm@8": "fail", "npx -y npm@7": "fail" });
    assert.equal((await npm.preflight!(tie.fake, "package-lock.json", 1000)).tool, undefined);
    const formatting = box({ npm: { removed: 0, added: 0, changed: 0, exact: false }, "npx -y npm@10": "fail", "npx -y npm@9": "fail", "npx -y npm@8": "fail", "npx -y npm@7": "fail" });
    const only = await npm.preflight!(formatting.fake, "package-lock.json", 1000);
    assert.equal(only.tool, undefined);
    assert.match(only.notes[0]!, /changes only the file's formatting or other top-level fields/);
  });

  it("gives each candidate its own limit, never more than three minutes, and stops when the total is spent", async () => {
    const timeouts: number[] = [];
    const fake: PreflightBox = {
      async run(_command, timeoutMs) {
        timeouts.push(timeoutMs);
        return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
      },
    };
    await npm.preflight!(fake, "package-lock.json", 10 * 60_000);
    assert.deepEqual(timeouts, [180_000, 180_000, 180_000, 180_000, 180_000]);
    timeouts.length = 0;
    await npm.preflight!(fake, "package-lock.json", 5_000);
    assert.deepEqual(timeouts, [5_000, 5_000, 5_000, 5_000, 5_000]);
    timeouts.length = 0;
    let clock = 0;
    await npm.preflight!(fake, "package-lock.json", 10 * 60_000, () => (clock += 4 * 60_000));
    assert.ok(timeouts.length >= 2 && timeouts.length < 5, `ran ${timeouts.length}`);
    assert.ok(timeouts.every((timeout) => timeout <= 180_000));
  });

  it("stops at the first exact candidate", async () => {
    const { scripts, fake } = box({ npm: { removed: 1, added: 0, changed: 0 }, "npx -y npm@10": CLEAN });
    await npm.preflight!(fake, "package-lock.json", 1000);
    assert.equal(scripts.length, 2);
  });

  it("gives nothing when no npm can re-resolve the lockfile at all", async () => {
    const { fake } = box({});
    assert.deepEqual((await npm.preflight!(fake, "package-lock.json", 1000)).notes, []);
  });

  it("tells the agent not to accept mass removals", () => {
    assert.match(npm.notes, /Do not accept a resolver run that removes, adds or changes packages the task does not touch/);
  });
});

describe("finish review", () => {
  const lock = (versions: Record<string, string>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: Object.fromEntries(Object.keys(versions).map((name) => [name, "*"])) }, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) },
    });

  it("lists the upgraded package and every direct dependency that crossed a major", () => {
    const crossed = crossedMajors(npm, lock({ "acme-build": "5.0.0", "acme-ui": "4.0.0", "acme-lint": "1.0.0" }), lock({ "acme-build": "6.1.0", "acme-ui": "5.2.0", "acme-lint": "1.4.0" }), { package: "acme-build", installed: "5.0.0" });
    assert.deepEqual(crossed, [{ package: "acme-build", from: "5.0.0", to: "6.1.0" }, { package: "acme-ui", from: "4.0.0", to: "5.2.0" }]);
  });

  it("gives the npm and python ecosystems their own search and file scripts", () => {
    const sources = npm.reviewSources!("acme-ui", "web")!;
    assert.match(sources.search, /^cd \/work && \[ -d web\/node_modules\/acme-ui \] \|\| \{ echo PROSECO_MISSING; exit 0; \}; grep -rhoiEI .*no longer\|has been removed\|removed in\|was removed.* web\/node_modules\/acme-ui --exclude-dir=node_modules \| sort -u/);
    assert.match(sources.files, /find web\/node_modules\/acme-ui -maxdepth 2 .*-iname 'readme\*'.*-iname '\*migrat\*'/);
    assert.equal(npm.reviewSources!("bad; rm -rf /", "."), null);
    assert.match(uv.reviewSources!("acme-lib", ".")!.search, /^cd \/work && base=\$\(uv run python -c .*distribution\(sys\.argv\[1\]\).* acme-lib\)/);
    assert.match(requirements.reviewSources!("acme-lib", "api")!.files, /^cd \/work\/api && base=\$\(python -c/);
    assert.equal(pythonSources("x y", ".", "python"), null);
  });

  it("ranks lines that name the package with its new major first, dedupes, cuts and caps", () => {
    const raw = [
      "A plain removal notice about something else",
      "Svelte 5 components are no longer classes. Instantiate them using `mount` or `hydrate`",
      "A plain removal notice about something else",
      "x".repeat(400),
      "short",
      "Attempted to instantiate %component% with `new %name%`, which is no longer valid in Svelte 5",
      "svelte 4 had this removed in the old days",
      ...Array.from({ length: 40 }, (_, index) => `generic message number ${index} was removed`),
    ];
    const { lines, total } = rankReviewLines(raw, "svelte", "5.1.0");
    assert.deepEqual(lines.slice(0, 2), [raw[1], raw[5]]);
    assert.equal(lines.length, 25);
    assert.equal(total, 45);
    assert.equal(new Set(lines).size, lines.length);
    const wide = rankReviewLines([raw[3]!], "svelte", "5.1.0").lines[0]!;
    assert.equal(wide.length, 301);
    assert.ok(wide.endsWith("…"));
  });

  it("matches a scoped name by its last segment and a 0.x line by its minor", () => {
    const scoped = rankReviewLines(["unrelated removed thing here", "Vite 6 no longer supports the old option"], "@acme/vite", "6.0.1");
    assert.equal(scoped.lines[0], "Vite 6 no longer supports the old option");
    const zero = rankReviewLines(["other removed thing here", "acme-z 0.3 has been removed support"], "acme-z", "0.3.1");
    assert.equal(zero.lines[0], "acme-z 0.3 has been removed support");
  });

  it("runs the search and the file listing per package and reports a package that is not installed", async () => {
    const scripts: string[] = [];
    const run = async (script: string) => {
      scripts.push(script);
      if (script.includes("acme-gone")) return { exitCode: 0, stdout: "PROSECO_MISSING\n", stderr: "" };
      return { exitCode: 0, stdout: script.includes("find ") ? "web/node_modules/acme-ui/README.md\nweb/node_modules/acme-ui/CHANGELOG.md\n" : "Acme-ui 5 no longer has classes\n", stderr: "" };
    };
    const reviews = await gatherReview(run, npm, [{ package: "acme-ui", from: "4.0.0", to: "5.2.0" }, { package: "acme-gone", from: "1.0.0", to: "2.0.0" }], "web");
    assert.equal(scripts.length, 4);
    assert.deepEqual([reviews[0]!.lines, reviews[0]!.files, reviews[0]!.problem], [["Acme-ui 5 no longer has classes"], ["web/node_modules/acme-ui/README.md", "web/node_modules/acme-ui/CHANGELOG.md"], null]);
    assert.deepEqual([reviews[1]!.lines, reviews[1]!.problem], [[], "it is not installed in the sandbox"]);
  });

  describe("the review message", () => {
    const review = (overrides: Partial<PackageReview> = {}): PackageReview => ({ package: "acme-ui", from: "4.0.0", to: "5.2.0", lines: ["Acme-ui 5 no longer has classes <b>"], total: 1, files: ["README.md"], problem: null, ...overrides });

    it("puts each package's messages and files in the message and asks for the summary to account for each", () => {
      const message = reviewMessage([review()], 20_000);
      assert.match(message, /^Not accepted yet/);
      assert.match(message, /### acme-ui 4\.0\.0 → 5\.2\.0\n<messages package="acme-ui">\nAcme-ui 5 no longer has classes &lt;b&gt;\n<\/messages>/);
      assert.match(message, /Files to read: README\.md/);
      assert.match(message, /entry points such as main\.js or index\.ts/);
      assert.match(message, /In your next finish summary, for each package above, say which of these messages apply to code in this repository and what you changed for each; if none apply, say why\./);
      assert.match(message, /second finish is accepted/);
    });

    it("says so when nothing was found, when it is not installed, and when the install failed", () => {
      const message = reviewMessage([review({ lines: [], total: 0, files: [] }), review({ package: "acme-b", lines: [], total: 0, files: [], problem: "it is not installed in the sandbox" })], 20_000, "`npm ci` failed with exit code 1");
      assert.match(message, /No lines about removed or changed APIs were found/);
      assert.match(message, /No README, CHANGELOG or MIGRATION files were found/);
      assert.match(message, /could not read messages from the installed package: it is not installed in the sandbox/);
      assert.match(message, /install step failed[^]*`npm ci` failed with exit code 1/);
    });

    it("drops lines from the longest list until the message fits, keeping the best-ranked first", () => {
      const lines = Array.from({ length: 25 }, (_, index) => `message ${index} ${"y".repeat(100)}`);
      const big = reviewMessage([review({ lines, total: 25 }), review({ package: "acme-b", lines, total: 25 })], 100_000);
      const small = reviewMessage([review({ lines, total: 25 }), review({ package: "acme-b", lines, total: 25 })], 3000);
      assert.ok(small.length <= 3000);
      assert.ok(small.length < big.length);
      assert.match(small, /message 0 /);
      assert.match(small, /lines shown, those naming the package and this major first/);
    });
  });
});

describe("failureExcerpt", () => {
  it("returns short text as it is, and the tail when there is no error line", () => {
    assert.equal(failureExcerpt("  short  ", 100), "short");
    assert.equal(failureExcerpt(`${"a\n".repeat(100)}end`, 20), "…a\na\na\na\na\na\nend".slice(0, 0) + `…${`${"a\n".repeat(100)}end`.slice(-20)}`);
  });

  it("starts at the first error line and keeps the tail, so a usage dump after the error does not hide it", () => {
    const usage = Array.from({ length: 200 }, (_, index) => `usage line ${index}`).join("\n");
    const text = `npm warn something\nnpm error code EUSAGE\nnpm error Missing: fsevents@2.3.3 from lock file\n${usage}`;
    const out = failureExcerpt(text, 400);
    assert.match(out, /^…\nnpm error code EUSAGE\nnpm error Missing: fsevents@2\.3\.3 from lock file/);
    assert.match(out, /\n…\n[^]*usage line 199$/);
    assert.ok(out.length <= 400 + 10);
    assert.doesNotMatch(out, /npm warn/);
  });

  it("returns everything from the error line when that fits", () => {
    assert.equal(failureExcerpt(`noise\n${"x".repeat(50)}\nnpm ERR! boom\ntrailing`, 40), "…\nnpm ERR! boom\ntrailing");
  });
});

describe("refusal messages", () => {
  it("lists each failing check with its target and the installed copies and where they sit", () => {
    const text = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/tmp": { version: "0.2.6" }, "node_modules/a/node_modules/tmp": { version: "0.2.3" } } });
    const checks = [{ package: "tmp", from: "0.2.1", installed: ["0.2.3"], ok: false, reason: "installed 0.2.3 is below 0.2.6" }, { package: "fine", installed: ["1.0.0"], ok: true, reason: "ok" }];
    const message = refusedChecksMessage(checks, () => "0.2.6", (pkg) => npm.copiesOf!(text, pkg));
    assert.match(message, /^Not accepted yet: the lockfile check/);
    assert.match(message, /- tmp: installed 0\.2\.3 is below 0\.2\.6\. Target: 0\.2\.6\.\n  Installed copies: 0\.2\.3 at node_modules\/a\/node_modules\/tmp/);
    assert.doesNotMatch(message, /fine/);
    assert.match(message, /then call finish again/);
  });

  it("falls back to the versions when the ecosystem cannot say where", () => {
    const message = refusedChecksMessage([{ package: "x", installed: ["1.0.0", "1.1.0"], ok: false, reason: "r" }], () => "2.0.0", () => []);
    assert.match(message, /Installed copies: 1\.0\.0, 1\.1\.0/);
  });

  it("says a lockfile unit must not move a direct dependency across a major", () => {
    const message = lockfileMajorMessage([{ package: "acme-e2e", from: "12.0.0", to: "13.1.0", repository: null }, { package: "acme-test", from: "10.0.0", to: "11.0.0", repository: null }]);
    assert.match(message, /- acme-e2e 12\.0\.0 → 13\.1\.0\n- acme-test 10\.0\.0 → 11\.0\.0/);
    assert.match(message, /must not move a direct dependency across a major version/);
    assert.match(message, /in-range update, a parent bump within its major, or an override/);
  });

  it("lists copies by path for npm and nothing for links or the root", () => {
    const text = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "tmp", version: "9.9.9" }, "node_modules/tmp": { version: "0.2.6" }, "node_modules/l": { link: true, version: "1.0.0" } } });
    assert.deepEqual(npm.copiesOf!(text, "tmp"), [{ version: "0.2.6", where: "node_modules/tmp" }]);
    assert.deepEqual(npm.copiesOf!(text, "l"), []);
  });
});

describe("lockfileStatus", () => {
  const lock = (packages: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...Object.fromEntries(Object.entries(packages).map(([path, version]) => [path, { version }])) } });
  const before = lock({ "node_modules/tmp": "0.2.1", "node_modules/a": "1.0.0", "node_modules/a/node_modules/tmp": "0.2.1", "node_modules/gone": "1.0.0", "node_modules/z": "1.0.0" });
  const after = lock({ "node_modules/tmp": "0.2.6", "node_modules/a": "1.0.1", "node_modules/a/node_modules/tmp": "0.2.3", "node_modules/new": "2.0.0", "node_modules/z": "1.0.0" });
  const fixes = [{ package: "tmp", installed: "0.2.1", target: ["0.2.6"] }];

  it("shows each fix check with its copies and paths, then the changes with the fix packages first", () => {
    const text = lockfileStatus(npm, "package-lock.json", fixes, before, after);
    assert.match(text, /^Lockfile status, read by the host from your current package-lock\.json:/);
    assert.match(text, /- tmp: FAILING, installed 0\.2\.3 is below 0\.2\.6\. Target: 0\.2\.6\. Copies: 0\.2\.6 at node_modules\/tmp; 0\.2\.3 at node_modules\/a\/node_modules\/tmp/);
    assert.match(text, /Changes against the default branch: 5 \(1 added, 1 removed, 3 changed\), the fix packages first:\n~ node_modules\/a\/node_modules\/tmp 0\.2\.1 → 0\.2\.3\n~ node_modules\/tmp 0\.2\.1 → 0\.2\.6\n~ node_modules\/a 1\.0\.0 → 1\.0\.1\n- node_modules\/gone 1\.0\.0\n\+ node_modules\/new 2\.0\.0/);
    assert.doesNotMatch(text, /node_modules\/z/);
  });

  it("reports ok checks, limits to a package, and caps the change list", () => {
    const ok = lockfileStatus(npm, "package-lock.json", fixes, before, lock({ "node_modules/tmp": "0.2.6" }));
    assert.match(ok, /- tmp: ok, /);
    const only = lockfileStatus(npm, "package-lock.json", fixes, before, after, "a");
    assert.match(only, /- no fix for a in this unit/);
    assert.match(only, /Changes against the default branch: 1 \(0 added, 0 removed, 1 changed\)[^]*~ node_modules\/a 1\.0\.0 → 1\.0\.1/);
    assert.doesNotMatch(only, /node_modules\/tmp/);
    const many = lockfileStatus(npm, "package-lock.json", [], lock({}), lock(Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`node_modules/p${index}`, "1.0.0"]))));
    assert.match(many, /: 70 \(70 added, 0 removed, 0 changed\)/);
    assert.match(many, /\.\.\. and 10 more$/);
  });

  it("works for uv and requirements through their installed versions", () => {
    const uvLock = (version: string) => `version = 1\n[[package]]\nname = "Acme-Lib"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n`;
    const status = lockfileStatus(uv, "uv.lock", [{ package: "acme.lib", installed: "1.0.0", target: ["1.2.0"] }], uvLock("1.0.0"), uvLock("1.1.0"));
    assert.match(status, /- acme\.lib: FAILING, installed 1\.1\.0 is below 1\.2\.0\. Target: 1\.2\.0\. Copies: 1\.1\.0/);
    assert.match(status, /~ acme-lib 1\.0\.0 → 1\.1\.0/);
    const req = lockfileStatus(requirements, "requirements.txt", [{ package: "requests", installed: "2.31.0", target: ["2.32.0"] }], "requests==2.31.0\nold==1.0\n", "requests==2.32.3\n");
    assert.match(req, /- requests: ok/);
    assert.match(req, /~ requests 2\.31\.0 → 2\.32\.3\n- old 1\.0/);
  });

  it("is mentioned in the ecosystem notes and both system prompts", () => {
    for (const notes of [npm.notes, uv.notes, requirements.notes]) assert.match(notes, /lockfile_status/);
    assert.match(npm.notes, /instead of parsing `git diff package-lock\.json`/);
  });
});

describe("overridesPackage", () => {
  it("finds an npm override at any nesting level and with a version in the key", () => {
    const manifest = (overrides: unknown) => JSON.stringify({ name: "x", overrides });
    assert.equal(npm.overridesPackage!(manifest({ "acme-ser": "^7.0.3" }), "acme-ser"), true);
    assert.equal(npm.overridesPackage!(manifest({ "acme-ser@^6": "^7.0.3" }), "acme-ser"), true);
    assert.equal(npm.overridesPackage!(manifest({ "acme-mocha": { "acme-ser": "^7.0.3" } }), "acme-ser"), true);
    assert.equal(npm.overridesPackage!(manifest({ "@acme/ser": "^7" }), "@acme/ser"), true);
    assert.equal(npm.overridesPackage!(manifest({ "@acme/ser@1": "^7" }), "@acme/ser"), true);
    assert.equal(npm.overridesPackage!(manifest({ "acme-other": "^1" }), "acme-ser"), false);
    assert.equal(npm.overridesPackage!(JSON.stringify({ dependencies: { "acme-ser": "^7" } }), "acme-ser"), false);
    assert.equal(npm.overridesPackage!("not json", "acme-ser"), false);
    assert.equal(npm.manifestFile, "package.json");
  });

  it("finds a uv constraint or override by normalised name, and says nothing for requirements", () => {
    const toml = (body: string) => `[project]\nname = "x"\n[tool.uv]\n${body}\n`;
    assert.equal(uv.overridesPackage!(toml('constraint-dependencies = ["Acme_Ser>=7.0.3"]'), "acme.ser"), true);
    assert.equal(uv.overridesPackage!(toml('override-dependencies = ["acme-ser==7.1"]'), "acme-ser"), true);
    assert.equal(uv.overridesPackage!(toml('constraint-dependencies = ["other>=1"]'), "acme-ser"), false);
    assert.equal(uv.overridesPackage!('[project]\ndependencies = ["acme-ser>=7"]\n', "acme-ser"), false);
    assert.equal(uv.overridesPackage!("garbage = [", "acme-ser"), false);
    assert.equal(uv.manifestFile, "pyproject.toml");
    assert.equal(requirements.overridesPackage, undefined);
  });
});

describe("manifest guards", () => {
  const json = (value: unknown) => JSON.stringify(value);

  it("allows only dependency keys to change in package.json, and reports every other changed key", () => {
    const before = json({ name: "x", version: "1.0.0", scripts: { test: "jest" }, dependencies: { a: "^1" }, overrides: {}, engines: { node: ">=18" } });
    const ok = json({ name: "x", version: "1.0.0", scripts: { test: "jest" }, dependencies: { a: "^2" }, overrides: { b: "^3" }, resolutions: { c: "1" }, engines: { node: ">=18" } });
    assert.deepEqual(npm.manifestViolations!(before, ok), []);
    const bad = json({ name: "y", version: "1.0.0", scripts: { test: "jest", postinstall: "curl x | sh" }, dependencies: { a: "^2" }, engines: { node: ">=20" }, bin: { x: "x.js" } });
    assert.deepEqual(npm.manifestViolations!(before, bad), ["bin", "engines", "name", "overrides".length ? "scripts" : ""].filter(Boolean).sort());
    assert.deepEqual(npm.manifestViolations!(before, "not json"), ["the file is not valid JSON"]);
    assert.deepEqual(npm.manifestViolations!("not json", ok), []);
  });

  it("reports a changed scripts section as risky for npm", () => {
    assert.deepEqual(npm.riskyManifestChanges!(json({ scripts: { a: "1" } }), json({ scripts: { a: "2" } })), ["scripts"]);
    assert.deepEqual(npm.riskyManifestChanges!(json({ scripts: { a: "1" } }), json({ scripts: { a: "1" }, dependencies: { x: "1" } })), []);
  });

  it("allows only dependency tables to change in pyproject.toml for uv, requires-python and sources included in what is refused", () => {
    const base = '[project]\nname = "x"\nrequires-python = ">=3.10"\ndependencies = ["a>=1"]\n[project.optional-dependencies]\ndev = ["pytest"]\n[dependency-groups]\ntest = ["b"]\n[tool.uv]\nconstraint-dependencies = ["c>=1"]\n';
    const ok = base.replace('"a>=1"', '"a>=2"').replace('"pytest"', '"pytest>=8"').replace('"b"', '"b>=2"').replace('"c>=1"', '"c>=2", "d>=1"');
    assert.deepEqual(uv.manifestViolations!(base, ok), []);
    assert.deepEqual(uv.manifestViolations!(base, base.replace(">=3.10", ">=3.8")), ["project.requires-python"]);
    assert.deepEqual(uv.manifestViolations!(base, `${base}[tool.uv.sources]\na = { git = "https://example.invalid/a.git" }\n`), ["tool.uv.sources"]);
    assert.deepEqual(uv.manifestViolations!(base, base.replace('name = "x"', 'name = "y"')), ["project.name"]);
    assert.deepEqual(uv.manifestViolations!(base, "garbage = ["), ["the file is not valid TOML"]);
  });

  it("reports changed entry points and build settings as risky for uv", () => {
    const base = '[project]\nname = "x"\n[project.scripts]\nrun = "x:main"\n';
    assert.deepEqual(uv.riskyManifestChanges!(base, base.replace("x:main", "y:main")), ["project.scripts"]);
    assert.deepEqual(uv.riskyManifestChanges!(base, base), []);
  });
});

describe("npm verification against the resolver", () => {
  const exactRef = { exact: true, removed: 0, added: 0, changed: 0, swapped: 0 };

  it("records what the preflight measured so the committed lockfile can be compared with it", async () => {
    const bundled = await npm.preflight!(box({ npm: CLEAN }).fake, "package-lock.json", 1000);
    assert.deepEqual(bundled.reference, { exact: true, removed: 0, added: 0, changed: 0, swapped: 0 });
    const older = await npm.preflight!(box({ npm: { removed: 5, added: 0, changed: 0 }, "npx -y npm@10": CLEAN }).fake, "package-lock.json", 1000);
    assert.deepEqual(older.reference, { tool: "npx -y npm@10", exact: true, removed: 0, added: 0, changed: 0, swapped: 0 });
    const closest = await npm.preflight!(box({ npm: { removed: 5, added: 1, changed: 2, swapped: 3 } as never, "npx -y npm@10": "fail", "npx -y npm@9": "fail", "npx -y npm@8": "fail", "npx -y npm@7": "fail" }).fake, "package-lock.json", 1000);
    assert.deepEqual(closest.reference, { exact: false, removed: 5, added: 1, changed: 2, swapped: 3 });
    assert.equal((await npm.preflight!(box({}).fake, "package-lock.json", 1000)).reference, undefined);
  });

  it("accepts a lockfile the chosen npm leaves exactly unchanged, with the reference's tool", async () => {
    const { fake, scripts } = box({ "npx -y npm@8": CLEAN });
    const result = await npm.verify!(fake, "web/package-lock.json", 5000, { ...exactRef, tool: "npx -y npm@8" });
    assert.equal(result.outcome, "ok");
    assert.match(result.text, /`npx -y npm@8 install --package-lock-only --no-audit --no-fund` leaves the committed lockfile exactly unchanged/);
    assert.match(scripts[0]!, /tar -C '\/work\/web'/);
  });

  it("refuses a lockfile with entries whose resolved, integrity or name the resolver would not produce", async () => {
    const result = await npm.verify!(box({ npm: { removed: 0, added: 0, changed: 0, swapped: 2, exact: false } as never }).fake, "package-lock.json", 5000, exactRef);
    assert.equal(result.outcome, "tampered");
    assert.match(result.text, /2 lockfile entries have a `resolved`, `integrity` or `name` that `npm install --package-lock-only/);
  });

  it("calls other differences drift, and a failing resolver unknown", async () => {
    assert.equal((await npm.verify!(box({ npm: { removed: 1, added: 0, changed: 0 } }).fake, "package-lock.json", 5000, exactRef)).outcome, "drift");
    assert.equal((await npm.verify!(box({ npm: "fail" }).fake, "package-lock.json", 5000, exactRef)).outcome, "unknown");
    assert.equal((await npm.verify!(box({ npm: CLEAN }).fake, "package-lock.json", 5000, undefined)).outcome, "unknown");
  });

  it("allows as much drift as the default branch has, but not more swapped entries or more drift", async () => {
    const reference = { exact: false, removed: 5, added: 0, changed: 1, swapped: 1 };
    assert.equal((await npm.verify!(box({ npm: { removed: 5, added: 0, changed: 1, swapped: 1 } as never }).fake, "package-lock.json", 5000, reference)).outcome, "ok");
    assert.equal((await npm.verify!(box({ npm: { removed: 5, added: 0, changed: 1, swapped: 2 } as never }).fake, "package-lock.json", 5000, reference)).outcome, "tampered");
    assert.equal((await npm.verify!(box({ npm: { removed: 9, added: 0, changed: 1, swapped: 1 } as never }).fake, "package-lock.json", 5000, reference)).outcome, "drift");
  });
});

describe("registry checks on the committed lockfile", () => {
  const entry = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-x", ...extra });
  const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });
  const head = lock({ "node_modules/a": entry("a", "1.0.0"), "node_modules/@s/b": entry("@s/b", "1.0.0") });
  const pairs = [{ path: "package.json", before: JSON.stringify({ dependencies: { a: "^1" } }), after: JSON.stringify({ dependencies: { a: "^1" } }) }];

  it("accepts honest changes, scoped packages and an unchanged entry", () => {
    const after = lock({ "node_modules/a": entry("a", "1.0.1"), "node_modules/@s/b": entry("@s/b", "1.0.0"), "node_modules/c": entry("c", "2.0.0") });
    assert.deepEqual(npm.lockfileProblems!(head, after, pairs), []);
    assert.deepEqual(npm.lockfileProblems!(head, lock({ "node_modules/@s/b": entry("@s/b", "1.1.0") }), pairs), []);
  });

  it("accepts a private registry whose path has a prefix before the package", () => {
    const private_ = lock({ "node_modules/a": { ...entry("a", "1.0.0"), resolved: "https://npm.example.invalid/api/npm/a/-/a-1.0.0.tgz" } });
    const after = lock({ "node_modules/a": { ...entry("a", "1.0.1"), resolved: "https://npm.example.invalid/api/npm/a/-/a-1.0.1.tgz" } });
    assert.deepEqual(npm.lockfileProblems!(private_, after, pairs), []);
  });

  it("rejects an entry whose name differs from its path, a host the default branch never used, and a tarball path that is not the package's", () => {
    const aliased = lock({ "node_modules/a": entry("a", "1.0.1", { name: "evil" }) });
    assert.match(npm.lockfileProblems!(head, aliased, pairs)[0]!, /node_modules\/a is an alias for evil, not a/);
    const host = lock({ "node_modules/a": entry("a", "1.0.1", { resolved: "https://evil.invalid/a/-/a-1.0.1.tgz" }) });
    assert.match(npm.lockfileProblems!(head, host, pairs)[0]!, /resolves from evil\.invalid, which no entry of the default branch's lockfile uses/);
    const other = lock({ "node_modules/a": entry("a", "1.0.1", { resolved: "https://registry.npmjs.org/evil/-/evil-1.0.1.tgz" }) });
    assert.match(npm.lockfileProblems!(head, other, pairs)[0]!, /does not end in \/a\/-\/a-1\.0\.1\.tgz/);
    const version = lock({ "node_modules/a": entry("a", "1.0.1", { resolved: "https://registry.npmjs.org/a/-/a-9.9.9.tgz" }) });
    assert.equal(npm.lockfileProblems!(head, version, pairs).length, 1);
  });

  it("rejects dependency specs that are new and not plain versions or ranges, and ignores ones that were already there", () => {
    const manifest = (dependencies: Record<string, string>) => ({ path: "package.json", before: JSON.stringify({ dependencies: { a: "^1", old: "github:x/old" } }), after: JSON.stringify({ dependencies: { a: "^1", old: "github:x/old", ...dependencies } }) });
    assert.deepEqual(npm.lockfileProblems!(head, head, [manifest({})]), []);
    for (const spec of ["npm:evil@1.0.0", "github:x/y", "git+https://example.invalid/y.git", "https://example.invalid/y.tgz", "file:../y", "link:../y"]) {
      assert.match(npm.lockfileProblems!(head, head, [manifest({ z: spec })])[0]!, /adds a dependency that does not come from the registry by version/, spec);
    }
    const overrides = { path: "package.json", before: JSON.stringify({}), after: JSON.stringify({ overrides: { a: "npm:evil@1" } }) };
    assert.equal(npm.lockfileProblems!(head, head, [overrides]).length, 1);
    assert.deepEqual(npm.lockfileProblems!(head, head, [{ path: "package.json", before: null, after: JSON.stringify({ dependencies: { a: "^2", b: "~1.2.3", c: "*", d: "1.x" } }) }]), []);
  });
});

describe("uv verification and registry checks", () => {
  const registry = (url: string) => `source = { registry = "${url}" }`;
  const lock = (...packages: { name: string; version: string; source: string }[]) => `version = 1\n${packages.map((item) => `[[package]]\nname = "${item.name}"\nversion = "${item.version}"\n${item.source}\n`).join("")}`;
  const PYPI = registry("https://pypi.org/simple");
  const head = lock({ name: "acme-app", version: "0.1.0", source: 'source = { editable = "." }' }, { name: "acme-lib", version: "1.0.0", source: PYPI });

  it("accepts a changed package from the same registry and rejects another source", () => {
    assert.deepEqual(uv.lockfileProblems!(head, lock({ name: "acme-app", version: "0.1.0", source: 'source = { editable = "." }' }, { name: "Acme_Lib", version: "1.1.0", source: PYPI }, { name: "new", version: "2.0", source: PYPI }), []), []);
    const git = lock({ name: "acme-app", version: "0.1.0", source: 'source = { editable = "." }' }, { name: "acme-lib", version: "1.1.0", source: 'source = { git = "https://example.invalid/lib.git" }' });
    assert.match(uv.lockfileProblems!(head, git, [])[0]!, /acme-lib 1\.1\.0 does not come from a registry \(git\)/);
    const other = lock({ name: "acme-lib", version: "1.1.0", source: registry("https://evil.invalid/simple") });
    assert.match(uv.lockfileProblems!(head, other, [])[0]!, /comes from https:\/\/evil\.invalid\/simple, which no package of the default branch's lockfile uses/);
    const local = lock({ name: "evil-local", version: "1", source: 'source = { editable = "../x" }' });
    assert.match(uv.lockfileProblems!(head, local, [])[0]!, /local package that the default branch's lockfile does not have/);
  });

  function uvBox(exit: number | "timeout") {
    const scripts: string[] = [];
    const fake: PreflightBox = {
      async run(command) {
        scripts.push(command[2]!);
        return { exitCode: exit === "timeout" ? 124 : exit, stdout: "", stderr: exit === 0 ? "" : "error: The lockfile at `uv.lock` needs to be updated", timedOut: exit === "timeout" };
      },
    };
    return { fake, scripts };
  }

  it("uses uv lock --check in the lockfile's directory, on the default branch first and on the committed lockfile after", async () => {
    const clean = uvBox(0);
    const pre = await uv.preflight!(clean.fake, "svc/uv.lock", 1000);
    assert.deepEqual(pre.reference, { exact: true, removed: 0, added: 0, changed: 0, swapped: 0 });
    assert.equal(clean.scripts[0], "cd '/work/svc' && uv lock --check");
    assert.equal((await uv.verify!(clean.fake, "uv.lock", 1000, pre.reference)).outcome, "ok");
    assert.equal(clean.scripts[1], "uv lock --check");
  });

  it("refuses a lockfile that fails the check when the default branch passes, and only drafts it when the default branch fails too", async () => {
    const failing = uvBox(2);
    const tampered = await uv.verify!(failing.fake, "uv.lock", 1000, { exact: true, removed: 0, added: 0, changed: 0, swapped: 0 });
    assert.equal(tampered.outcome, "tampered");
    assert.match(tampered.text, /fails on the committed uv\.lock although it passes on the default branch: error: The lockfile/);
    assert.equal((await uv.verify!(failing.fake, "uv.lock", 1000, { exact: false, removed: 0, added: 0, changed: 0, swapped: 0 })).outcome, "drift");
    assert.equal((await uv.verify!(uvBox("timeout").fake, "uv.lock", 1000, undefined)).outcome, "unknown");
    assert.equal((await uv.preflight!(uvBox("timeout").fake, "uv.lock", 1000)).reference, undefined);
  });

  it("has nothing to verify for requirements files", () => {
    assert.equal(requirements.verify, undefined);
    assert.equal(requirements.lockfileProblems, undefined);
  });
});

describe("shell quoting of paths inside the sandbox", () => {
  it("quotes a directory with spaces or quotes in the npm review scripts, and refuses package names with dot segments", () => {
    const sources = npm.reviewSources!("acme-ui", "my app/it's")!;
    assert.match(sources.search, /\[ -d 'my app\/it'\\''s\/node_modules\/acme-ui' \]/);
    assert.match(sources.search, /'my app\/it'\\''s\/node_modules\/acme-ui' --exclude-dir=node_modules/);
    assert.match(sources.files, /find 'my app\/it'\\''s\/node_modules\/acme-ui' -maxdepth 2 -path 'my app\/it'\\''s\/node_modules\/acme-ui\/node_modules' -prune/);
    for (const name of ["..", "a/../b", "@s/..", "./x", "a//b", "a b", "a;b", "$(x)"]) assert.equal(npm.reviewSources!(name, "."), null, name);
    assert.ok(npm.reviewSources!("@scope/pkg", "."));
  });

  it("quotes the directory and the file name in the python review scripts and the requirements install", () => {
    const sources = pythonSources("acme-lib", "my svc", "python")!;
    assert.match(sources.search, /^cd .\/work\/my svc. && base=/);
    assert.equal(requirements.harness("svc/dev requirements.txt").install, "python -m pip install -r 'dev requirements.txt'");
    assert.equal(requirements.harness("svc/requirements.txt").install, "python -m pip install -r requirements.txt");
    assert.equal(requirements.harness("a/it's-requirements.txt").install, "python -m pip install -r 'it'\\''s-requirements.txt'");
  });
});
