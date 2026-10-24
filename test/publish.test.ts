import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { GitStore } from "../src/fixer/git.ts";
import { allowedFiles, commitAllowed, discardOthers, isAllowed, parseStatus, splitPaths } from "../src/fixer/publish.ts";

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
  it("allows the manifest, lockfiles and .npmrc beside the lockfile and the package.json of each workspace member", () => {
    const allowed = allowedFiles("web/package-lock.json", LOCK);
    assert.deepEqual([...allowed].sort(), ["web/.npmrc", "web/npm-shrinkwrap.json", "web/package-lock.json", "web/package.json", "web/packages/app/package.json", "web/packages/lib/package.json"]);
  });

  it("uses the repository root for a lockfile at the root", () => {
    assert.deepEqual([...allowedFiles("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }))].sort(), [".npmrc", "npm-shrinkwrap.json", "package-lock.json", "package.json"]);
  });

  it("never allows anything under .github/workflows, even when the lockfile's directory is there", () => {
    const allowed = allowedFiles(".github/workflows/package-lock.json", LOCK);
    assert.equal(allowed.has(".github/workflows/package.json"), true);
    assert.equal(isAllowed(allowed, ".github/workflows/package.json"), false);
    assert.equal(isAllowed(allowed, ".github/workflows/ci.yml"), false);
    assert.equal(isAllowed(allowedFiles("package-lock.json", LOCK), "package.json"), true);
  });

  it("splits changed paths into allowed and discarded", () => {
    const allowed = allowedFiles("package-lock.json", LOCK);
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
    const allowed = allowedFiles(work.lockfile, LOCK);
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
    const discarded = await discardOthers(work.store, work.path, work.base, allowedFiles(work.lockfile, LOCK));
    assert.deepEqual([...discarded].sort(), ["src/a.js", "src/b.js"]);
    assert.equal(git(work.path, "rev-parse", "HEAD"), work.base);
    assert.equal(git(work.path, "status", "--porcelain"), "M package.json");
  });

  it("discards untracked node_modules without listing every file in it", async () => {
    const work = await checkout({});
    for (let index = 0; index < 600; index++) work.write(`node_modules/pkg/f${index}.js`, "x");
    const discarded = await discardOthers(work.store, work.path, work.base, allowedFiles(work.lockfile, LOCK));
    assert.equal(discarded.length, 600);
    assert.equal(existsSync(join(work.path, "node_modules")), false);
  });

  it("commits only the allowed files as the bot with the given message", async () => {
    const work = await checkout({});
    work.write("package.json", '{"bumped":true}');
    work.write("package-lock.json", LOCK.replace("1.0.0", "1.0.1"));
    work.write("src/a.js", "tampered");
    const allowed = allowedFiles(work.lockfile, LOCK);
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
    const allowed = allowedFiles(work.lockfile, LOCK);
    await discardOthers(work.store, work.path, work.base, allowed);
    assert.equal(await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "m", allowed }), null);
    assert.equal(git(work.path, "rev-parse", "HEAD"), work.base);
  });

  it("refuses to stage a workflow file even if the allowed set somehow lists it", async () => {
    const work = await checkout({ ".github/workflows/package.json": "{}" }, ".github/workflows");
    work.write(".github/workflows/package.json", '{"x":1}');
    const allowed = allowedFiles(work.lockfile, LOCK);
    const discarded = await discardOthers(work.store, work.path, work.base, allowed);
    assert.deepEqual(discarded, [".github/workflows/package.json"]);
    assert.equal(await commitAllowed(work.store, work.path, { bot: "acme-proseco", message: "m", allowed }), null);
  });
});
