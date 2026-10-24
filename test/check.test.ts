import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkLockfile, checkPassed } from "../src/fixer/check.ts";
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

  it("compares against the lowest of several targets", () => {
    const text = lock({ "node_modules/x": "2.0.1" });
    assert.equal(checkLockfile(npm, text, [{ package: "x", target: ["2.0.5", "1.9.9"] }])[0]!.ok, true);
    assert.equal(checkLockfile(npm, text, [{ package: "x", target: ["2.0.5"] }])[0]!.ok, false);
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
});
