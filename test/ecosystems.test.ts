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
    for (const path of ["requirements/base.txt", "svc/Requirements/dev/test.txt"]) assert.equal(ecosystemFor(path)?.name, "requirements", path);
    for (const path of ["docs/notes.txt", "requirements/README.md", "requirement/base.txt"]) assert.equal(ecosystemFor(path), null, path);
    assert.equal(ecosystemFor("api/requirements-dev.txt")?.name, "requirements");
    for (const path of ["scripts/parity-requirements.txt", "dev_requirements.txt", "tools/test.requirements.txt", "requirements_test.txt", "Requirements.txt"]) {
      assert.equal(ecosystemFor(path)?.name, "requirements", path);
    }
    for (const path of ["notes.txt", "robots.txt", "my-requirementsfoo.txt", "requirements.md", "requirements", "docs/prerequirements.txt"]) {
      assert.equal(ecosystemFor(path), null, path);
    }
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

  it("lists the version each direct dependency resolves to", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "acme-a": "^2.0.0" }, devDependencies: { "acme-b": "^1.0.0" }, workspaces: ["packages/app"] },
        "packages/app": { dependencies: { "acme-c": "^1.0.0" } },
        "node_modules/acme-a": { version: "2.1.0" },
        "node_modules/acme-b": { version: "1.0.0" },
        "node_modules/acme-d": { version: "9.0.0" },
        "packages/app/node_modules/acme-c": { version: "1.4.0" },
      },
    });
    assert.deepEqual([...npm.directVersions(text)].sort(), [["acme-a", "2.1.0"], ["acme-b", "1.0.0"], ["acme-c", "1.4.0"]]);
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
    assert.equal(npm.toolchainVersion({ "package.json": "not json" }), null);
    assert.equal(npm.toolchainVersion({ ".nvmrc": "20\n", "package.json": "not json" }), "20");
    assert.equal(npm.toolchainVersion({ "package.json": '{"engines":{"node":">=20"}}' }), ">=20");
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

  it("lists the locked version of each direct dependency and dev dependency", () => {
    const direct = uv.directVersions(lock);
    assert.equal(direct.get("acme-client"), "1.5.0");
    assert.equal(direct.get("acme-pytest"), "8.0.0");
    assert.equal(direct.has("acme-urllib"), false);
    assert.equal(direct.has("acme-api"), false);
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

describe("allowed files", () => {
  it("allows npm's manifest and lockfiles beside the lockfile and each workspace member's package.json", () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "packages/app": {}, "node_modules/x": { version: "1.0.0" } } });
    assert.deepEqual(ecosystem("web/package-lock.json").allowedFiles("web/package-lock.json", lock).sort(), ["web/npm-shrinkwrap.json", "web/package-lock.json", "web/package.json", "web/packages/app/package.json"]);
  });

  it("allows pyproject.toml and uv.lock beside the lockfile, and the pyproject.toml of workspace members only", () => {
    const lock = [
      "version = 1",
      "[manifest]",
      'members = ["root-app", "lib-one", "tool"]',
      "[[package]]",
      'name = "root-app"',
      'version = "0.1.0"',
      'source = { virtual = "." }',
      "[[package]]",
      'name = "lib-one"',
      'version = "0.1.0"',
      'source = { editable = "packages/lib-one" }',
      "[[package]]",
      'name = "tool"',
      'version = "0.1.0"',
      'source = { virtual = "tools/tool" }',
      "[[package]]",
      'name = "outsider"',
      'version = "1.0.0"',
      'source = { editable = "elsewhere" }',
      "",
    ].join("\n");
    assert.deepEqual(ecosystem("svc/uv.lock").allowedFiles("svc/uv.lock", lock).sort(), ["svc/packages/lib-one/pyproject.toml", "svc/pyproject.toml", "svc/tools/tool/pyproject.toml", "svc/uv.lock"]);
    assert.deepEqual(ecosystem("uv.lock").allowedFiles("uv.lock", fixture("acme-uv.lock")).sort(), ["pyproject.toml", "uv.lock"]);
  });

  it("allows only the requirements file itself", () => {
    assert.deepEqual(ecosystem("svc/requirements.txt").allowedFiles("svc/requirements.txt", "requests==2.31.0\n"), ["svc/requirements.txt"]);
    assert.deepEqual(ecosystem("requirements-dev.txt").allowedFiles("requirements-dev.txt", ""), ["requirements-dev.txt"]);
  });
});

describe("harness", () => {
  const reading = (files: Record<string, string>) => (path: string) => files[path] ?? null;

  it("runs npm ci and npm test, and finds tests only when package.json has a test script", () => {
    const harness = ecosystem("web/package-lock.json").harness("web/package-lock.json");
    assert.equal(harness.install, "npm ci --no-audit --no-fund");
    assert.equal(harness.test, "npm test --if-present");
    assert.equal(harness.hasTests(reading({ "web/package.json": '{"scripts":{"test":"node t.js"}}' })), true);
    assert.equal(harness.hasTests(reading({ "web/package.json": '{"scripts":{}}' })), false);
    assert.equal(harness.hasTests(reading({ "package.json": '{"scripts":{"test":"x"}}' })), false);
    assert.equal(harness.hasTests(reading({ "web/package.json": "not json" })), false);
  });

  it("runs uv sync and uv run pytest, and finds tests only when pytest is locked", () => {
    const harness = ecosystem("uv.lock").harness("uv.lock");
    assert.equal(harness.install, "uv sync --frozen --all-extras --all-groups");
    assert.equal(harness.test, "uv run pytest -q -rfE");
    const locked = (name: string) => `version = 1\n[[package]]\nname = "${name}"\nversion = "8.0.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
    assert.equal(harness.hasTests(reading({ "uv.lock": locked("pytest") })), true);
    assert.equal(harness.hasTests(reading({ "uv.lock": locked("pytest-cov") })), false);
    assert.equal(harness.hasTests(reading({})), false);
    assert.equal(harness.hasTests(reading({ "uv.lock": "garbage = [" })), false);
  });

  it("installs the requirements file from its directory, and finds tests only when pytest is pinned in it", () => {
    const harness = ecosystem("svc/requirements.txt").harness("svc/requirements.txt");
    assert.equal(harness.install, "python -m pip install -r requirements.txt");
    assert.equal(harness.test, "python -m pytest -q -rfE");
    assert.equal(harness.hasTests(reading({ "svc/requirements.txt": "requests==2.31.0\nPyTest==8.3.3 ; python_version > '3'\n" })), true);
    assert.equal(harness.hasTests(reading({ "svc/requirements.txt": "requests==2.31.0\n" })), false);
    assert.equal(harness.hasTests(reading({ "requirements.txt": "pytest==8.3.3\n" })), false);
  });
});

describe("unsupported files", () => {
  it("rejects a hash-pinned requirements file and nothing else", () => {
    const requirements = ecosystem("requirements.txt");
    assert.match(requirements.unsupported("requests==2.31.0 \\\n    --hash=sha256:abc\n")!, /hash-pinned/);
    assert.match(requirements.unsupported("requests==2.31.0 --hash=sha256:abc\n")!, /hash-pinned/);
    assert.equal(requirements.unsupported("requests==2.31.0\npytest==8.3.3\n"), null);
    assert.equal(ecosystem("uv.lock").unsupported("x"), null);
    const npmLock = ecosystem("package-lock.json");
    assert.equal(npmLock.unsupported(JSON.stringify({ lockfileVersion: 3, packages: {} })), null);
    assert.match(npmLock.unsupported(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))!, /lockfileVersion 1 and no packages map: only lockfileVersion 2 and 3 are supported/);
    assert.match(npmLock.unsupported("not json")!, /not valid JSON/);
  });
});
