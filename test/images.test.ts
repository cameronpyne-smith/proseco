import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageFor, proxyImageTag, UV_VERSION } from "../src/fixer/sandbox/images.ts";

describe("imageFor node", () => {
  const cases: [string | null, string][] = [
    ["20", "20"],
    [">=20", "20"],
    ["^22.1", "22"],
    ["v22.3.0", "22"],
    [">=18.0.0 <21", "18"],
    ["lts/*", "24"],
    ["lts/iron", "24"],
    ["node", "24"],
    [null, "24"],
  ];
  for (const [declared, major] of cases) {
    it(`resolves ${JSON.stringify(declared)} to node ${major}`, () => {
      const image = imageFor("node", declared);
      assert.equal(image.name, "proseco/node");
      assert.equal(image.tag, major);
      assert.deepEqual(image.buildArgs, { NODE_MAJOR: major });
      assert.match(image.dockerfile, /images\/node\/Dockerfile$/);
    });
  }
});

describe("imageFor python", () => {
  const cases: [string | null, string][] = [
    ["3.12", "3.12"],
    ["3.12.4", "3.12"],
    [">=3.11", "3.11"],
    ["~=3.12.0", "3.12"],
    [">=3.10,<4", "3.10"],
    ["cpython-3.11.9", "3.11"],
    ["3", "3.13"],
    [null, "3.13"],
  ];
  for (const [declared, version] of cases) {
    it(`resolves ${JSON.stringify(declared)} to python ${version}`, () => {
      const image = imageFor("python", declared);
      assert.equal(image.name, "proseco/python");
      assert.equal(image.tag, version);
      assert.deepEqual(image.buildArgs, { PYTHON_VERSION: version, UV_VERSION });
      assert.match(image.dockerfile, /images\/python\/Dockerfile$/);
    });
  }
});

describe("proxyImageTag", () => {
  it("is the first 12 hex characters of the sha256 of proxy.ts", async () => {
    const expected = createHash("sha256").update(readFileSync(join(import.meta.dirname, "..", "src", "fixer", "sandbox", "proxy.ts"))).digest("hex").slice(0, 12);
    assert.match(expected, /^[0-9a-f]{12}$/);
    assert.equal(await proxyImageTag(), expected);
  });
});
