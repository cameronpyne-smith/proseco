import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compareTests, isRegression } from "../src/fixer/baseline.ts";
import type { PreflightBox } from "../src/fixer/ecosystems/ecosystem.ts";
import { DIFF_SCRIPT, npm } from "../src/fixer/ecosystems/npm.ts";
import { pytestFailures, pythonSources } from "../src/fixer/ecosystems/pytest.ts";
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

  it("is what the python harnesses use, and they no longer stop at the first failure", () => {
    for (const ecosystem of [uv, requirements]) {
      const plan = ecosystem.harness("a.lock");
      assert.equal(plan.failures, pytestFailures);
      assert.doesNotMatch(plan.test, /-x/);
      assert.match(plan.test, /-rfE/);
    }
    assert.equal(npm.harness("package-lock.json").failures, undefined);
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
    assert.deepEqual(drift(v3, v2), { removed: 0, added: 0, changed: 0, exact: false, sameVersion: false });
    assert.deepEqual(drift(v3, same), { removed: 0, added: 0, changed: 0, exact: true, sameVersion: true });
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
