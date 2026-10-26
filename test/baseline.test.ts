import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareTests, isRegression } from "../src/fixer/baseline.ts";
import type { PreflightBox } from "../src/fixer/ecosystems/ecosystem.ts";
import { npm } from "../src/fixer/ecosystems/npm.ts";
import { pytestFailures, pythonSources } from "../src/fixer/ecosystems/pytest.ts";
import { requirements } from "../src/fixer/ecosystems/requirements.ts";
import { uv } from "../src/fixer/ecosystems/uv.ts";
import type { TestOutcome } from "../src/fixer/pr.ts";
import { failureExcerpt } from "../src/fixer/excerpt.ts";
import { crossedMajors, gatherReview, rankReviewLines, reviewMessage, type PackageReview } from "../src/fixer/review.ts";

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

function box(drifts: Record<string, { removed: number; added: number; changed: number } | "fail">) {
  const scripts: string[] = [];
  const fake: PreflightBox = {
    async run(command) {
      const script = command[2]!;
      scripts.push(script);
      const resolver = /cd "\$d" && (.+?) install --package-lock-only/.exec(script)![1]!;
      const drift = drifts[resolver];
      if (!drift || drift === "fail") return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: `noise\nPRESOLVE ${JSON.stringify(drift)}\n`, stderr: "", timedOut: false };
    },
  };
  return { fake, scripts };
}

const CLEAN = { removed: 0, added: 0, changed: 0 };

describe("npm preflight", () => {
  it("says nothing when the bundled npm leaves the untouched lockfile alone", async () => {
    const { fake, scripts } = box({ npm: CLEAN });
    assert.deepEqual(await npm.preflight!(fake, "web/package-lock.json", 1000), { notes: [] });
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

  it("tries older majors newest first and tells the agent the exact command of the first that leaves it unchanged", async () => {
    const { fake, scripts } = box({ npm: { removed: 300, added: 0, changed: 2 }, "npx -y npm@10": { removed: 120, added: 0, changed: 0 }, "npx -y npm@9": "fail", "npx -y npm@8": CLEAN });
    const { notes, tool } = await npm.preflight!(fake, "package-lock.json", 1000);
    const [note, ...more] = notes;
    assert.equal(tool, "npx -y npm@8");
    assert.equal(more.length, 0);
    assert.match(note!, /300 removed, 0 added, 2 changed/);
    assert.match(note!, /`npx -y npm@8 install --package-lock-only --no-audit --no-fund`/);
    assert.match(note!, /in place of `npm` for every npm command/);
    assert.match(note!, /`npx -y npm@8 ci --no-audit --no-fund` for installing/);
    assert.doesNotMatch(note!, /are not affected/);
    assert.equal(scripts.length, 4);
  });

  it("says re-resolving changes unrelated packages when no npm reproduces the lockfile", async () => {
    const { fake, scripts } = box({ npm: { removed: 300, added: 0, changed: 0 } });
    const { notes: [note], tool } = await npm.preflight!(fake, "package-lock.json", 1000);
    assert.equal(tool, undefined);
    assert.match(note!, /changes packages unrelated to the task \(with the bundled npm: 300 removed, 0 added, 0 changed\)/);
    assert.match(note!, /No npm version reproduces it/);
    assert.equal(scripts.length, 5);
    for (const major of [10, 9, 8, 7]) assert.ok(scripts.some((script) => script.includes(`npx -y npm@${major} install`)));
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
