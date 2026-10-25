import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareTests, isRegression } from "../src/fixer/baseline.ts";
import type { PreflightBox } from "../src/fixer/ecosystems/ecosystem.ts";
import { npm } from "../src/fixer/ecosystems/npm.ts";
import { pytestFailures, pythonReview } from "../src/fixer/ecosystems/pytest.ts";
import { requirements } from "../src/fixer/ecosystems/requirements.ts";
import { uv } from "../src/fixer/ecosystems/uv.ts";
import type { TestOutcome } from "../src/fixer/pr.ts";
import { crossedMajors, reviewMessage } from "../src/fixer/review.ts";

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
    assert.deepEqual(await npm.preflight!(fake, "web/package-lock.json", 1000), []);
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
    const [note, ...more] = await npm.preflight!(fake, "package-lock.json", 1000);
    assert.equal(more.length, 0);
    assert.match(note!, /300 removed, 0 added, 2 changed/);
    assert.match(note!, /`npx -y npm@8 install --package-lock-only --no-audit --no-fund`/);
    assert.match(note!, /in place of `npm` for every resolver command/);
    assert.equal(scripts.length, 4);
  });

  it("says re-resolving changes unrelated packages when no npm reproduces the lockfile", async () => {
    const { fake, scripts } = box({ npm: { removed: 300, added: 0, changed: 0 } });
    const [note] = await npm.preflight!(fake, "package-lock.json", 1000);
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

  it("gives the npm and python ecosystems their own search commands", () => {
    const [grep, readme] = npm.reviewCommands!("acme-ui", "web");
    assert.match(grep!, /grep -rhoiE .*no longer\|has been removed\|removed in\|was removed.* web\/node_modules\/acme-ui --exclude-dir=node_modules \| sort -u/);
    assert.match(readme!, /ls web\/node_modules\/acme-ui \| grep -iE "readme\|changelog\|migrat/);
    assert.deepEqual(npm.reviewCommands!("bad; rm -rf /", "."), []);
    assert.match(uv.reviewCommands!("acme-lib", ".")[0]!, /cd \/work && uv run python -c .*distribution\(sys\.argv\[1\]\).* acme-lib/);
    assert.match(requirements.reviewCommands!("acme-lib", "api")[0]!, /cd \/work\/api && python -c/);
    assert.deepEqual(pythonReview("x y", ".", "python"), []);
  });

  it("builds a message that names each package, the search, the entry points and the second finish", () => {
    const message = reviewMessage([{ package: "acme-ui", from: "4.0.0", to: "5.2.0" }], (pkg) => [`search ${pkg}`]);
    assert.match(message, /^Not accepted yet/);
    assert.match(message, /- acme-ui 4\.0\.0 → 5\.2\.0/);
    assert.match(message, /acme-ui: search acme-ui/);
    assert.match(message, /entry points such as main\.js or index\.ts/);
    assert.match(message, /second finish is accepted/);
  });
});
