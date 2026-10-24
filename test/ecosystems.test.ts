import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ecosystemFor } from "../src/fixer/ecosystems/ecosystem.ts";
import { parseToml } from "../src/fixer/ecosystems/toml.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");
}

function ecosystem(path: string) {
  const found = ecosystemFor(path);
  assert.ok(found, `no ecosystem for ${path}`);
  return found;
}

describe("ecosystem detection", () => {
  it("picks the ecosystem from the lockfile name, in any directory", () => {
    assert.equal(ecosystemFor("package-lock.json")?.name, "npm");
    assert.equal(ecosystemFor("web/package-lock.json")?.name, "npm");
    assert.equal(ecosystemFor("services/api/uv.lock")?.name, "uv");
    assert.equal(ecosystemFor("requirements.txt")?.name, "requirements");
    assert.equal(ecosystemFor("api/requirements-dev.txt")?.name, "requirements");
  });

  it("returns null for a lockfile it cannot work on", () => {
    assert.equal(ecosystemFor("yarn.lock"), null);
    assert.equal(ecosystemFor("src/Acme.csproj"), null);
  });

  it("reports the ecosystem name Dependabot uses in findings", () => {
    assert.equal(ecosystem("package-lock.json").findingEcosystem, "npm");
    assert.equal(ecosystem("uv.lock").findingEcosystem, "pip");
    assert.equal(ecosystem("requirements.txt").findingEcosystem, "pip");
  });
});

describe("npm", () => {
  const npm = ecosystem("package-lock.json");
  const lock = fixture("acme-package-lock.json");

  it("names a direct dependency as its own chain", () => {
    assert.deepEqual(npm.parentChain(lock, "acme-web", "2.1.0"), ["acme-web"]);
    assert.deepEqual(npm.parentChain(lock, "@acme/ui", "1.2.0"), ["@acme/ui"]);
  });

  it("walks to the shortest chain from a direct dependency, resolving the nearest copy", () => {
    assert.deepEqual(npm.parentChain(lock, "acme-parse", "1.0.2"), ["@acme/ui", "acme-parse"]);
    assert.deepEqual(npm.parentChain(lock, "acme-http", "1.4.0"), ["acme-web", "acme-http"]);
  });

  it("finds a nested copy through the package that shadows the hoisted one", () => {
    assert.deepEqual(npm.parentChain(lock, "acme-parse", "0.9.1"), ["acme-web", "acme-parse"]);
  });

  it("follows development dependencies from the root", () => {
    assert.deepEqual(npm.parentChain(lock, "acme-lint", "1.1.0"), ["acme-test", "acme-lint"]);
  });

  it("returns null for a package or version the lockfile does not hold", () => {
    assert.equal(npm.parentChain(lock, "acme-parse", "9.9.9"), null);
    assert.equal(npm.parentChain(lock, "absent", "1.0.0"), null);
  });

  it("lists every installed version of each package, including nested copies", () => {
    const installed = npm.installedVersions(lock);
    assert.deepEqual(installed.get("acme-parse"), ["0.9.1", "1.0.2"]);
    assert.deepEqual(installed.get("@acme/ui"), ["1.2.0"]);
    assert.equal(installed.has(""), false);
  });

  it("fails on text that is not a lockfile", () => {
    assert.throws(() => npm.installedVersions("{}"), /package-lock\.json has no packages/);
  });

  it("reads the toolchain from .nvmrc, then engines.node", () => {
    assert.deepEqual(npm.toolchainFiles, [".nvmrc", "package.json"]);
    assert.equal(npm.toolchainVersion({ ".nvmrc": "v20.11.0\n", "package.json": '{"engines":{"node":">=18"}}' }), "v20.11.0");
    assert.equal(npm.toolchainVersion({ "package.json": '{"engines":{"node":">=18"}}' }), ">=18");
    assert.equal(npm.toolchainVersion({ "package.json": "{}" }), null);
    assert.equal(npm.toolchainVersion({}), null);
  });
});

describe("uv", () => {
  const uv = ecosystem("uv.lock");
  const lock = fixture("acme-uv.lock");

  it("names a direct dependency as its own chain, including dev dependencies", () => {
    assert.deepEqual(uv.parentChain(lock, "acme-client", "1.5.0"), ["acme-client"]);
    assert.deepEqual(uv.parentChain(lock, "acme-pytest", "8.0.0"), ["acme-pytest"]);
  });

  it("walks dependencies to the direct parent", () => {
    assert.deepEqual(uv.parentChain(lock, "acme-urllib", "2.0.1"), ["acme-client", "acme-urllib"]);
  });

  it("matches package names the way Python does", () => {
    assert.deepEqual(uv.parentChain(lock, "Acme_Urllib", "2.0.1"), ["acme-client", "acme-urllib"]);
  });

  it("does not treat the project itself as a dependency", () => {
    assert.equal(uv.parentChain(lock, "acme-api", "0.1.0"), null);
  });

  it("returns null when the version is not locked", () => {
    assert.equal(uv.parentChain(lock, "acme-urllib", "1.0.0"), null);
  });

  it("lists installed versions by normalised name", () => {
    const installed = uv.installedVersions(lock);
    assert.deepEqual(installed.get("acme-urllib"), ["2.0.1"]);
    assert.deepEqual(installed.get("acme-yaml"), ["6.0.0"]);
  });

  it("reads the toolchain from .python-version, then requires-python", () => {
    assert.deepEqual(uv.toolchainFiles, [".python-version", "pyproject.toml"]);
    assert.equal(uv.toolchainVersion({ ".python-version": "3.12\n" }), "3.12");
    assert.equal(uv.toolchainVersion({ "pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.11"\n' }), ">=3.11");
    assert.equal(uv.toolchainVersion({ "pyproject.toml": "[project]\n" }), null);
  });
});

describe("requirements.txt", () => {
  const requirements = ecosystem("requirements.txt");
  const text = fixture("acme-requirements.txt");

  it("reads exact pins past hashes, markers, comments and options", () => {
    const installed = requirements.installedVersions(text);
    assert.deepEqual([...installed], [
      ["acme-client", ["1.5.0"]],
      ["acme-urllib", ["2.0.1"]],
      ["acme-yaml", ["6.0.0"]],
    ]);
  });

  it("treats every pin as direct, with no chain above it", () => {
    assert.deepEqual(requirements.parentChain(text, "acme-urllib", "2.0.1"), ["acme-urllib"]);
    assert.deepEqual(requirements.parentChain(text, "Acme.Client", "1.5.0"), ["acme-client"]);
    assert.equal(requirements.parentChain(text, "acme-client", "9.9.9"), null);
  });

  it("shares the python toolchain rules", () => {
    assert.equal(requirements.toolchainVersion({ ".python-version": "3.13" }), "3.13");
  });
});

describe("the TOML subset of uv.lock", () => {
  it("parses tables, arrays of tables, inline tables, arrays and scalars", () => {
    const data = parseToml(
      [
        "# comment",
        'version = 1',
        'flag = true',
        "[a.b]",
        'name = "x\\ty"',
        "literal = 'c:\\raw'",
        "list = [",
        "  { name = \"one\", n = 2 },",
        "  \"two\", # trailing",
        "]",
        "[[p]]",
        'n = "first"',
        "[p.sub]",
        "k = 1",
        "[[p]]",
        'n = "second"',
        "",
      ].join("\n"),
    );
    assert.deepEqual(data, {
      version: 1,
      flag: true,
      a: { b: { name: "x\ty", literal: "c:\\raw", list: [{ name: "one", n: 2 }, "two"] } },
      p: [{ n: "first", sub: { k: 1 } }, { n: "second" }],
    });
  });

  it("fails loudly, with the line, on syntax outside the subset", () => {
    assert.throws(() => parseToml('a = 1.5'), /line 1.*unsupported/);
    assert.throws(() => parseToml('ok = 1\nb = """multi"""'), /line 2.*multi-line strings/);
    assert.throws(() => parseToml("a = 1979-05-27"), /line 1.*unsupported/);
    assert.throws(() => parseToml("a = \n"), /line 1/);
    assert.throws(() => parseToml('a = "unterminated'), /line 1.*unterminated/);
    assert.throws(() => parseToml("a = 1\na = 2"), /line 2.*duplicate key a/);
  });
});

describe("real lockfiles", () => {
  it("reads a generated package-lock.json", () => {
    const npm = ecosystem("package-lock.json");
    const lock = fixture("real-package-lock.json");
    const installed = npm.installedVersions(lock);
    assert.equal(installed.size, 185);
    assert.deepEqual(installed.get("express"), ["4.18.2"]);
    assert.deepEqual(installed.get("qs"), ["6.11.0"]);
    assert.deepEqual(npm.parentChain(lock, "qs", "6.11.0"), ["express", "qs"]);
    assert.deepEqual(npm.parentChain(lock, "vitest", "1.6.0"), ["vitest"]);
  });

  it("reads a generated uv.lock", () => {
    const uv = ecosystem("uv.lock");
    const lock = fixture("real-uv.lock");
    const installed = uv.installedVersions(lock);
    assert.equal(installed.size, 12);
    assert.deepEqual(installed.get("urllib3"), ["2.8.0"]);
    assert.deepEqual(installed.get("pillow"), ["10.2.0"]);
    assert.deepEqual(uv.parentChain(lock, "urllib3", "2.8.0"), ["requests", "urllib3"]);
    assert.deepEqual(uv.parentChain(lock, "pytest", "9.1.1"), ["pytest"]);
  });
});
