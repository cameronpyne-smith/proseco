import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { npm } from "../src/fixer/ecosystems/npm.ts";
import { GitStore } from "../src/fixer/git.ts";
import { allowedFiles, commitAllowed, discardOthers, isAllowed, majorGuard, parseStatus, splitPaths } from "../src/fixer/publish.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
}

const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { "": { workspaces: ["packages/*"] }, "node_modules/a": { version: "1.0.0" }, "packages/app": { version: "1.0.0" }, "packages/lib": { version: "1.0.0" }, "node_modules/lib": { resolved: "packages/lib", link: true } } });

async function checkout(files: Record<string, string>, lockfileDirectory = ""): Promise<{ store: GitStore; path: string; base: string; lockfile: string; write(file: string, content: string): void }> {
  const origin = mkdtempSync(join(tmpdir(), "proseco-guard-origin-"));
  git(origin, "init", "-q", "-b", "main");
  const lockfile = lockfileDirectory ? `${lockfileDirectory}/package-lock.json` : "package-lock.json";
  const all = { [lockfile]: LOCK, [`${lockfileDirectory ? `${lockfileDirectory}/` : ""}package.json`]: "{}", "src/a.js": "a", ...files };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(dirname(join(origin, file)), { recursive: true });
    writeFileSync(join(origin, file), content);
  }
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "init");
  const cloneDir = mkdtempSync(join(tmpdir(), "proseco-guard-clones-"));
  const store = new GitStore({ cloneDir, remoteUrl: () => origin });
  await store.fetch("acme-api");
  const base = await store.headSha("acme-api");
  const path = await store.checkout("acme-api", base);
  return {
    store,
    path,
    base,
    lockfile,
    write(file, content) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), content);
    },
  };
}

describe("status parsing", () => {
  it("reads NUL-separated entries, including spaces, untracked files and both sides of a rename", () => {
    const status = [" M package.json", "?? new file.txt", "R  new.txt", "old.txt", " D gone.txt", ""].join("\0");
    assert.deepEqual(parseStatus(status), ["package.json", "new file.txt", "new.txt", "old.txt", "gone.txt"]);
    assert.deepEqual(parseStatus(""), []);
  });
});

describe("allowed files", () => {
  it("allows the manifest and lockfiles beside the lockfile and the package.json of each workspace member", () => {
    const allowed = allowedFiles(npm, "web/package-lock.json", LOCK);
    assert.deepEqual([...allowed].sort(), ["web/npm-shrinkwrap.json", "web/package-lock.json", "web/package.json", "web/packages/app/package.json", "web/packages/lib/package.json"]);
  });

  it("uses the repository root for a lockfile at the root", () => {
    assert.deepEqual([...allowedFiles(npm, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }))].sort(), ["npm-shrinkwrap.json", "package-lock.json", "package.json"]);
  });

  it("never allows anything under .github/workflows, even when the lockfile's directory is there", () => {
    const allowed = allowedFiles(npm, ".github/workflows/package-lock.json", LOCK);
    assert.equal(allowed.has(".github/workflows/package.json"), true);
    assert.equal(isAllowed(allowed, ".github/workflows/package.json"), false);
    assert.equal(isAllowed(allowed, ".github/workflows/ci.yml"), false);
    assert.equal(isAllowed(allowedFiles(npm, "package-lock.json", LOCK), "package.json"), true);
  });

  it("splits changed paths into allowed and discarded", () => {
    const allowed = allowedFiles(npm, "package-lock.json", LOCK);
    assert.deepEqual(splitPaths(["package.json", "src/a.js", "package-lock.json", ".github/workflows/ci.yml"], allowed), {
      allowed: ["package.json", "package-lock.json"],
      discarded: ["src/a.js", ".github/workflows/ci.yml"],
    });
  });
});

describe("commit guard", () => {
  it("restores changed and deleted files, removes new ones, keeps allowed changes, and lists what it discarded", async () => {
    const work = await checkout({ ".github/workflows/ci.yml": "on: push\n", "README.md": "readme" });
    work.write("package.json", '{"changed":true}');
    work.write("src/a.js", "tampered");
    work.write("src/new.js", "new");
    work.write(".github/workflows/ci.yml", "evil");
    execFileSync("rm", [join(work.path, "README.md")]);
    const allowed = allowedFiles(npm, work.lockfile, LOCK);
    const discarded = await discardOthers(work.store, work.path, work.base, allowed);
    assert.deepEqual([...discarded].sort(), [".github/workflows/ci.yml", "README.md", "src/a.js", "src/new.js"]);
    assert.equal(readFileSync(join(work.path, "src/a.js"), "utf8"), "a");
    assert.equal(readFileSync(join(work.path, "README.md"), "utf8"), "readme");
    assert.equal(readFileSync(join(work.path, ".github/workflows/ci.yml"), "utf8"), "on: push\n");
    assert.equal(existsSync(join(work.path, "src/new.js")), false);
    assert.equal(readFileSync(join(work.path, "package.json"), "utf8"), '{"changed":true}');
    assert.equal(git(work.path, "status", "--porcelain"), "M package.json");
  });

  it("undoes commits and staging the agent made inside the container", async () => {
    const work = await checkout({});
    work.write("src/a.js", "committed by agent");
    work.write("package.json", '{"x":1}');
    git(work.path, "add", ".");
    git(work.path, "commit", "-q", "-m", "agent commit");
    work.write("src/b.js", "staged");
    git(work.path, "add", "src/b.js");
    const discarded = await discardOthers(work.store, work.path, work.base, allowedFiles(npm, work.lockfile, LOCK));
    assert.deepEqual([...discarded].sort(), ["src/a.js", "src/b.js"]);
    assert.equal(git(work.path, "rev-parse", "HEAD"), work.base);
    assert.equal(git(work.path, "status", "--porcelain"), "M package.json");
  });

  it("discards untracked node_modules without listing every file in it", async () => {
    const work = await checkout({});
    for (let index = 0; index < 600; index++) work.write(`node_modules/pkg/f${index}.js`, "x");
    const discarded = await discardOthers(work.store, work.path, work.base, allowedFiles(npm, work.lockfile, LOCK));
    assert.equal(discarded.length, 600);
    assert.equal(existsSync(join(work.path, "node_modules")), false);
  });

  it("commits only the allowed files as the bot with the given message", async () => {
    const work = await checkout({});
    work.write("package.json", '{"bumped":true}');
    work.write("package-lock.json", LOCK.replace("1.0.0", "1.0.1"));
    work.write("src/a.js", "tampered");
    const allowed = allowedFiles(npm, work.lockfile, LOCK);
    await discardOthers(work.store, work.path, work.base, allowed);
    const commit = await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "Bump minimist to 1.2.6", allowed });
    assert.deepEqual(commit!.files.sort(), ["package-lock.json", "package.json"]);
    assert.equal(commit!.sha, git(work.path, "rev-parse", "HEAD"));
    assert.equal(git(work.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"), "acme-proseco[bot] <acme-proseco[bot]@users.noreply.github.com>|acme-proseco[bot] <acme-proseco[bot]@users.noreply.github.com>|Bump minimist to 1.2.6");
    assert.equal(git(work.path, "rev-parse", "HEAD~1"), work.base);
  });

  it("commits nothing when nothing allowed changed", async () => {
    const work = await checkout({});
    work.write("src/a.js", "tampered");
    const allowed = allowedFiles(npm, work.lockfile, LOCK);
    await discardOthers(work.store, work.path, work.base, allowed);
    assert.equal(await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "m", allowed }), null);
    assert.equal(git(work.path, "rev-parse", "HEAD"), work.base);
  });

  it("refuses to stage a workflow file even if the allowed set somehow lists it", async () => {
    const work = await checkout({ ".github/workflows/package.json": "{}" }, ".github/workflows");
    work.write(".github/workflows/package.json", '{"x":1}');
    const allowed = allowedFiles(npm, work.lockfile, LOCK);
    const discarded = await discardOthers(work.store, work.path, work.base, allowed);
    assert.deepEqual(discarded, [".github/workflows/package.json"]);
    assert.equal(await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "m", allowed }), null);
  });
});

describe("the commit guard for a major upgrade", () => {
  async function major(edits: Record<string, string>, written: string[] = Object.keys(edits)) {
    const work = await checkout({ "uv.lock": "x", "docs/notes.md": "old" });
    for (const [file, content] of Object.entries(edits)) work.write(file, content);
    const guard = majorGuard({ written: new Set(written), ecosystem: npm });
    const discarded = await discardOthers(work.store, work.path, work.base, guard);
    const commit = await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "Upgrade", allowed: guard });
    return { discarded: discarded.sort(), files: commit ? commit.files.sort() : null };
  }

  it("commits code, tests, docs and new source files along with the manifest and lockfile", async () => {
    const result = await major({ "package.json": '{"v":2}', "package-lock.json": LOCK.replace("1.0.0", "2.0.0"), "src/a.js": "changed", "src/new.mjs": "export {}", "test/a.test.js": "t", "docs/notes.md": "new" });
    assert.deepEqual(result.discarded, []);
    assert.deepEqual(result.files, ["docs/notes.md", "package-lock.json", "package.json", "src/a.js", "src/new.mjs", "test/a.test.js"]);
  });

  it("refuses workflows, node_modules and .venv wherever they are", async () => {
    const result = await major({ "src/a.js": "changed", ".github/workflows/ci.yml": "on: push", "node_modules/x/index.js": "x", "svc/node_modules/y.js": "y", ".venv/bin/python": "p" });
    assert.deepEqual(result.discarded, [".github/workflows/ci.yml", ".venv/bin/python", "node_modules/x/index.js", "svc/node_modules/y.js"]);
    assert.deepEqual(result.files, ["src/a.js"]);
  });

  it("refuses the lockfiles and manifests of other ecosystems but not its own", async () => {
    const result = await major({ "uv.lock": "changed", "pyproject.toml": "[project]", "requirements-dev.txt": "x==1", "svc/Api.csproj": "<Project/>", "package.json": '{"v":2}', "src/a.js": "c" });
    assert.deepEqual(result.discarded, ["pyproject.toml", "requirements-dev.txt", "svc/Api.csproj", "uv.lock"]);
    assert.deepEqual(result.files, ["package.json", "src/a.js"]);
  });

  it("refuses package-manager configuration in any directory but allows ordinary source", async () => {
    const result = await major({ ".npmrc": "registry=https://example.invalid/", "sub/.npmrc": "ignore-scripts=false", "sub/NuGet.Config": "<configuration/>", "pip.conf": "[global]", "src/index.js": "c" });
    assert.deepEqual(result.discarded, [".npmrc", "pip.conf", "sub/.npmrc", "sub/NuGet.Config"]);
    assert.deepEqual(result.files, ["src/index.js"]);
  });

  it("keeps a new file only when the agent wrote it with the file tools, and keeps any change to a tracked file", async () => {
    const result = await major({ "src/a.js": "changed by a codemod", "src/new.mjs": "export {}", "dist/index.html": "<html>", "dist/assets/app.js": "built" }, ["src/new.mjs"]);
    assert.deepEqual(result.discarded, ["dist/assets/app.js", "dist/index.html"]);
    assert.deepEqual(result.files, ["src/a.js", "src/new.mjs"]);
  });

  it("commits nothing when only refused paths changed", async () => {
    const result = await major({ ".github/workflows/ci.yml": "x" });
    assert.equal(result.files, null);
  });

  it("does not stage what the repository's .gitignore ignores", async () => {
    const result = await major({ ".gitignore": "dist/\n", "dist/out.js": "built", "src/a.js": "c" });
    assert.deepEqual(result.discarded, []);
    assert.deepEqual(result.files, [".gitignore", "src/a.js"]);
  });

  it("leaves the lockfile unit's guard exactly as it was", async () => {
    const work = await checkout({});
    work.write("src/a.js", "tampered");
    work.write("package.json", '{"v":2}');
    const discarded = await discardOthers(work.store, work.path, work.base, allowedFiles(npm, work.lockfile, LOCK));
    assert.deepEqual(discarded, ["src/a.js"]);
  });
});
