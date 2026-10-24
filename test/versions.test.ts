import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions, highestVersion, isMajorUpgrade, packageKey } from "../src/core/versions.ts";

describe("highest fixed-in version", () => {
  it("compares version parts as numbers, not text", () => {
    assert.deepEqual(highestVersion(["4.3.2", "4.3.10", "4.3.9"]), ["4.3.10"]);
  });

  it("orders calendar versions", () => {
    assert.deepEqual(highestVersion(["2026.1.4", "2026.10.19", "2026.9.30"]), ["2026.10.19"]);
  });

  it("treats a missing trailing part as zero", () => {
    assert.deepEqual(highestVersion(["1.2", "1.1.9"]), ["1.2"]);
  });

  it("lists every version instead of guessing when one cannot be read", () => {
    assert.deepEqual(highestVersion(["2.0.0", "2.0.0-rc.1", "1.9.0"]), ["1.9.0", "2.0.0", "2.0.0-rc.1"]);
  });

  it("returns a single repeated version once", () => {
    assert.deepEqual(highestVersion(["13.0.0", "13.0.0"]), ["13.0.0"]);
  });
});

describe("major upgrade", () => {
  it("is a major upgrade when the major version changes", () => {
    assert.equal(isMajorUpgrade("12.3.0", ["13.0.0"]), true);
    assert.equal(isMajorUpgrade("5.4.19", ["6.4.4"]), true);
  });

  it("is not a major upgrade within the same major version", () => {
    assert.equal(isMajorUpgrade("4.17.21", ["4.18.0"]), false);
    assert.equal(isMajorUpgrade("2026.1.4", ["2026.10.19"]), false);
  });

  it("treats a change in the first non-zero part of a 0.x version as major", () => {
    assert.equal(isMajorUpgrade("0.50.0", ["1.1.0"]), true);
    assert.equal(isMajorUpgrade("0.5.1", ["0.6.0"]), true);
    assert.equal(isMajorUpgrade("0.0.22", ["0.0.30"]), true);
    assert.equal(isMajorUpgrade("0.5.1", ["0.5.9"]), false);
  });

  it("is unknown when a version cannot be read or there is no single target", () => {
    assert.equal(isMajorUpgrade("^1.2.3", ["1.3.0"]), null);
    assert.equal(isMajorUpgrade("1.0.0", ["2.0.0-rc.1"]), null);
    assert.equal(isMajorUpgrade("1.0.0", ["1.1.0", "2.0.0-rc.1"]), null);
  });
});

describe("package identity", () => {
  it("matches pip names regardless of case and separators", () => {
    assert.equal(packageKey("pip", "Pillow"), packageKey("pip", "pillow"));
    assert.equal(packageKey("pip", "python_multipart"), packageKey("pip", "Python-Multipart"));
  });

  it("matches NuGet names regardless of case", () => {
    assert.equal(packageKey("nuget", "Newtonsoft.Json"), packageKey("nuget", "newtonsoft.json"));
  });

  it("keeps npm and unknown-ecosystem names exact", () => {
    assert.notEqual(packageKey("npm", "JSONStream"), packageKey("npm", "jsonstream"));
    assert.notEqual(packageKey(null, "OpenSSL"), packageKey(null, "openssl"));
  });
});

describe("version comparison", () => {
  const order = (versions: string[]) => [...versions].sort((a, b) => compareVersions(a, b)!);

  it("orders semver releases numerically and ignores build metadata", () => {
    assert.deepEqual(order(["1.10.0", "1.2.0", "1.2.10", "1.2.9"]), ["1.2.0", "1.2.9", "1.2.10", "1.10.0"]);
    assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
  });

  it("puts semver pre-releases before the release and orders their tags", () => {
    assert.deepEqual(order(["1.0.0", "1.0.0-rc.1", "1.0.0-beta.2", "1.0.0-alpha", "1.0.0-beta.10"]), ["1.0.0-alpha", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0"]);
    assert.ok(compareVersions("1.0.1-beta", "1.0.0")! > 0);
  });

  it("orders PEP 440 development, pre, release, post and epoch", () => {
    assert.deepEqual(order(["1.0.post1", "1.0", "1.0rc1", "1.0b2", "1.0a1", "1.0.dev3"]), ["1.0.dev3", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1"]);
    assert.ok(compareVersions("1!1.0", "2.0")! > 0);
    assert.equal(compareVersions("1.0.0rc1", "1.0.0-rc.1"), 0);
  });

  it("treats an unknown semver pre-release tag as a pre-release", () => {
    assert.ok(compareVersions("2.0.0-canary.4", "2.0.0")! < 0);
    assert.ok(compareVersions("2.0.0-canary.4", "2.0.0-canary.10")! < 0);
  });

  it("returns null for a version it cannot read", () => {
    assert.equal(compareVersions("latest", "1.0.0"), null);
    assert.equal(compareVersions("1.0.0", ""), null);
  });
});
