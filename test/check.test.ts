import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkLockfile, checkPassed } from "../src/fixer/check.ts";
import { requirements } from "../src/fixer/ecosystems/requirements.ts";
import { npm } from "../src/fixer/ecosystems/npm.ts";
import { uv } from "../src/fixer/ecosystems/uv.ts";

function lock(packages: Record<string, string>): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { name: "root" }, ...Object.fromEntries(Object.entries(packages).map(([path, version]) => [path, { version }])) },
  });
}

describe("lockfile check", () => {
  it("passes a package installed at or above the lowest target", () => {
    const results = checkLockfile(npm, lock({ "node_modules/minimist": "1.2.8" }), [{ package: "minimist", target: ["1.2.6"] }]);
    assert.deepEqual(results, [{ package: "minimist", installed: ["1.2.8"], ok: true, reason: "installed 1.2.8 is at or above 1.2.6" }]);
    assert.equal(checkPassed(results), true);
  });

  it("fails when any installed copy is below the target, naming the copy", () => {
    const text = lock({ "node_modules/minimist": "1.2.8", "node_modules/a/node_modules/minimist": "1.2.5" });
    const [result] = checkLockfile(npm, text, [{ package: "minimist", target: ["1.2.6"] }]);
    assert.equal(result!.ok, false);
    assert.deepEqual(result!.installed, ["1.2.5", "1.2.8"]);
    assert.match(result!.reason, /1\.2\.5 is below 1\.2\.6/);
  });

  it("passes a package that is no longer in the lockfile", () => {
    const [result] = checkLockfile(npm, lock({ "node_modules/other": "1.0.0" }), [{ package: "minimist", target: ["1.2.6"] }]);
    assert.deepEqual(result, { package: "minimist", installed: [], ok: true, reason: "absent from the lockfile" });
  });

  it("compares a copy with the target on its own major line, or the highest target", () => {
    const text = lock({ "node_modules/x": "2.0.7" });
    assert.equal(checkLockfile(npm, text, [{ package: "x", target: ["2.0.5", "1.9.9"] }])[0]!.ok, true);
    assert.equal(checkLockfile(npm, text, [{ package: "x", target: ["2.0.9", "1.9.9"] }])[0]!.ok, false);
    assert.equal(checkLockfile(npm, lock({ "node_modules/x": "3.0.0" }), [{ package: "x", target: ["2.0.5", "1.9.9"] }])[0]!.ok, true);
    assert.equal(checkLockfile(npm, lock({ "node_modules/x": "1.9.0" }), [{ package: "x", target: ["2.0.5", "1.9.9"] }])[0]!.ok, false);
  });

  describe("a package with several major lines in the same ticket", () => {
    const text = lock({
      "node_modules/acme-brace": "1.1.21",
      "node_modules/a/node_modules/acme-brace": "2.1.7",
      "node_modules/acme-glob": "3.1.5",
      "node_modules/b/node_modules/acme-glob": "5.1.9",
      "node_modules/c/node_modules/acme-glob": "9.0.9",
    });
    const fixes = [
      { package: "acme-brace", installed: "1.1.12", target: ["1.1.20"] },
      { package: "acme-brace", installed: "2.0.2", target: ["2.1.6"] },
      { package: "acme-glob", installed: "3.1.2", target: ["3.1.4"] },
      { package: "acme-glob", installed: "5.1.6", target: ["5.1.8"] },
      { package: "acme-glob", installed: "9.0.5", target: ["9.0.7"] },
    ];

    it("passes when each copy is at or above the target of its own line, and each row names only its copies", () => {
      const results = checkLockfile(npm, text, fixes);
      assert.equal(checkPassed(results), true);
      assert.deepEqual(results.map((result) => [result.package, result.from, result.installed]), [
        ["acme-brace", "1.1.12", ["1.1.21"]],
        ["acme-brace", "2.0.2", ["2.1.7"]],
        ["acme-glob", "3.1.2", ["3.1.5"]],
        ["acme-glob", "5.1.6", ["5.1.9"]],
        ["acme-glob", "9.0.5", ["9.0.9"]],
      ]);
      assert.equal(results[1]!.reason, "installed 2.1.7 is at or above 2.1.6");
    });

    it("fails only the line whose copy is still below its target", () => {
      const stale = lock({ "node_modules/acme-brace": "1.1.21", "node_modules/a/node_modules/acme-brace": "2.1.5" });
      const results = checkLockfile(npm, stale, fixes.slice(0, 2));
      assert.deepEqual(results.map((result) => result.ok), [true, false]);
      assert.match(results[1]!.reason, /2\.1\.5 is below 2\.1\.6/);
    });

    it("treats a 0.x minor as its own line", () => {
      const zero = lock({ "node_modules/z": "0.2.9", "node_modules/a/node_modules/z": "0.3.1" });
      const results = checkLockfile(npm, zero, [{ package: "z", installed: "0.2.1", target: ["0.2.5"] }, { package: "z", installed: "0.3.0", target: ["0.3.2"] }]);
      assert.deepEqual(results.map((result) => result.ok), [true, false]);
      assert.deepEqual(results[0]!.installed, ["0.2.9"]);
    });

    it("lets a copy that moved past every line pass", () => {
      const results = checkLockfile(npm, lock({ "node_modules/acme-brace": "3.0.0" }), fixes.slice(0, 2));
      assert.equal(checkPassed(results), true);
    });
  });

  it("treats a pre-release below its release as too low", () => {
    const [result] = checkLockfile(npm, lock({ "node_modules/x": "2.0.0-rc.1" }), [{ package: "x", target: ["2.0.0"] }]);
    assert.equal(result!.ok, false);
  });

  it("fails rather than guesses when a version cannot be compared or there is no target", () => {
    const [unreadable] = checkLockfile(npm, lock({ "node_modules/x": "git+https://example.invalid/x" }), [{ package: "x", target: ["1.0.0"] }]);
    assert.equal(unreadable!.ok, false);
    assert.match(unreadable!.reason, /cannot compare/);
    const [none] = checkLockfile(npm, lock({ "node_modules/x": "1.0.0" }), [{ package: "x", target: [] }]);
    assert.equal(none!.ok, false);
    assert.match(none!.reason, /no target version/);
  });

  it("rejects the unit when one package of several fails", () => {
    const text = lock({ "node_modules/a": "1.0.0", "node_modules/b": "1.0.0" });
    const results = checkLockfile(npm, text, [{ package: "a", target: ["1.0.0"] }, { package: "b", target: ["1.0.1"] }]);
    assert.deepEqual(results.map((result) => result.ok), [true, false]);
    assert.equal(checkPassed(results), false);
  });

  it("looks pip packages up by their normalised name", () => {
    const text = '[[package]]\nname = "Zope-Interface"\nversion = "5.0.0"\n';
    const [result] = checkLockfile(uv, text, [{ package: "zope.interface", target: ["5.0.1"] }]);
    assert.equal(result!.ok, false);
    assert.deepEqual(result!.installed, ["5.0.0"]);
  });

  describe("copies the advisory says were never vulnerable", () => {
    const text = lock({ "node_modules/acme-brace": "1.1.20", "node_modules/a/node_modules/acme-brace": "1.0.5" });
    const fix = { package: "acme-brace", installed: "1.1.12", target: ["1.1.20"] };

    it("passes a copy outside every known vulnerable range, whatever its line", () => {
      const [result] = checkLockfile(npm, text, [{ ...fix, vulnerable: [">= 1.1.0, < 1.1.20"] }]);
      assert.equal(result!.ok, true);
      assert.deepEqual(result!.installed, ["1.0.5", "1.1.20"]);
    });

    it("still fails a copy inside a vulnerable range", () => {
      const [result] = checkLockfile(npm, text, [{ ...fix, vulnerable: ["< 1.1.20"] }]);
      assert.equal(result!.ok, false);
      assert.match(result!.reason, /1\.0\.5 is below 1\.1\.20/);
    });

    it("falls back to the line rule when no range is known, or when any fix of the package lacks one", () => {
      assert.equal(checkLockfile(npm, text, [fix])[0]!.ok, false);
      assert.equal(checkLockfile(npm, text, [{ ...fix, vulnerable: null }])[0]!.ok, false);
      assert.equal(checkLockfile(npm, text, [{ ...fix, vulnerable: [">= 1.1.0, < 1.1.20"] }, { package: "acme-brace", installed: "2.0.2", target: ["2.1.6"], vulnerable: null }])[0]!.ok, false);
    });

    it("uses the ranges of every fix of the package together", () => {
      const both = lock({ "node_modules/acme-brace": "1.1.20", "node_modules/a/node_modules/acme-brace": "2.0.5" });
      const results = checkLockfile(npm, both, [{ ...fix, vulnerable: [">= 1.1.0, < 1.1.20"] }, { package: "acme-brace", installed: "2.0.2", target: ["2.1.6"], vulnerable: [">= 2.0.0, < 2.1.6"] }]);
      assert.deepEqual(results.map((result) => result.ok), [true, false]);
    });
  });

  describe("a file that must keep the package pinned", () => {
    it("fails when the pin is gone or no longer ==, but a lockfile may drop the package", () => {
      const pinned = { ...requirements, absentIsFixed: false };
      const [gone] = checkLockfile(pinned, "other==1.0\n", [{ package: "requests", target: ["2.32.0"] }]);
      assert.equal(gone!.ok, false);
      assert.match(gone!.reason, /the pin for requests is gone/);
      assert.equal(checkLockfile(pinned, "requests>=2.32\n", [{ package: "requests", target: ["2.32.0"] }])[0]!.ok, false);
      assert.equal(checkLockfile(pinned, "requests==2.32.0\n", [{ package: "requests", target: ["2.32.0"] }])[0]!.ok, true);
      assert.equal(requirements.absentIsFixed, false);
      assert.equal(npm.absentIsFixed && uv.absentIsFixed, true);
      assert.equal(checkLockfile(npm, lock({}), [{ package: "requests", target: ["2.32.0"] }])[0]!.ok, true);
    });
  });
});
