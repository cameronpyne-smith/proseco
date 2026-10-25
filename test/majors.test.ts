import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { npm } from "../src/fixer/ecosystems/npm.ts";
import { forcedMajors } from "../src/fixer/majors.ts";

function lock(direct: Record<string, string>): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: Object.fromEntries(Object.keys(direct).map((name) => [name, "*"])) },
      ...Object.fromEntries(Object.entries(direct).map(([name, version]) => [`node_modules/${name}`, { version }])),
    },
  });
}

describe("forcedMajors", () => {
  it("flags a direct dependency that went from a stable release to a prerelease of the next major", () => {
    const found = forcedMajors(npm, lock({ "acme-press": "1.6.4", "acme-up": "3.1.0" }), lock({ "acme-press": "2.0.0-alpha.6", "acme-up": "5.0.0" }), "acme-up-core");
    assert.deepEqual(found.map((item) => [item.package, item.from, item.to]), [["acme-press", "1.6.4", "2.0.0-alpha.6"], ["acme-up", "3.1.0", "5.0.0"]]);
  });

  it("ignores the upgraded package, minor bumps, a prerelease of the same major and new dependencies", () => {
    const before = lock({ "acme-core": "1.0.0", "acme-a": "1.2.0", "acme-b": "2.0.0" });
    const after = lock({ "acme-core": "2.0.0", "acme-a": "1.9.0", "acme-b": "2.1.0-beta.1", "acme-c": "7.0.0" });
    assert.deepEqual(forcedMajors(npm, before, after, "acme-core"), []);
  });

  it("treats a 0.x minor as a major line", () => {
    const found = forcedMajors(npm, lock({ "acme-z": "0.2.4" }), lock({ "acme-z": "0.3.0" }), "acme-core");
    assert.deepEqual(found.map((item) => item.package), ["acme-z"]);
  });
});
