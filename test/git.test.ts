import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { GitStore, gitEnvironment } from "../src/fixer/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
}

function origin(): { dir: string; commit(file: string, content: string): string } {
  const dir = mkdtempSync(join(tmpdir(), "proseco-origin-"));
  git(dir, "init", "-q", "-b", "main");
  return {
    dir,
    commit(file, content) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
      git(dir, "add", file);
      git(dir, "commit", "-q", "-m", `change ${file}`);
      return git(dir, "rev-parse", "HEAD");
    },
  };
}

function store(remote: string, token?: string): { store: GitStore; cloneDir: string } {
  const cloneDir = mkdtempSync(join(tmpdir(), "proseco-clones-"));
  return { store: new GitStore({ cloneDir, remoteUrl: () => remote, token }), cloneDir };
}

describe("git environment", () => {
  const env = gitEnvironment("/empty-home", "ghs_secret");

  it("ignores system and user configuration and never prompts", () => {
    assert.equal(env["GIT_CONFIG_NOSYSTEM"], "1");
    assert.equal(env["GIT_CONFIG_GLOBAL"], "/dev/null");
    assert.equal(env["HOME"], "/empty-home");
    assert.equal(env["GIT_TERMINAL_PROMPT"], "0");
  });

  it("passes the token only as an extra header through the environment", () => {
    const count = Number(env["GIT_CONFIG_COUNT"]);
    const entries = Array.from({ length: count }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]);
    const header = entries.find(([key]) => key === "http.extraheader");
    assert.equal(header?.[1], `Authorization: Basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`);
    assert.deepEqual(entries.find(([key]) => key === "credential.helper"), ["credential.helper", ""]);
    const others = Object.entries(env).filter(([key]) => !key.startsWith("GIT_CONFIG_VALUE_"));
    assert.equal(others.some(([, value]) => value?.includes("ghs_secret")), false);
  });

  it("sets no header without a token", () => {
    const bare = gitEnvironment("/empty-home", undefined);
    assert.equal(Object.values(bare).some((value) => value?.startsWith("Authorization")), false);
  });
});

describe("git store", () => {
  it("clones a bare store named for the repo, fetches the default branch and reports its head", async () => {
    const remote = origin();
    const first = remote.commit("a.txt", "one");
    const { store: clones, cloneDir } = store(remote.dir);
    await clones.fetch("acme-api");
    assert.equal(existsSync(join(cloneDir, "acme-api.git", "HEAD")), true);
    assert.equal(git(join(cloneDir, "acme-api.git"), "rev-parse", "--is-bare-repository"), "true");
    assert.equal(await clones.headSha("acme-api"), first);
  });

  it("picks up new commits on the next fetch", async () => {
    const remote = origin();
    remote.commit("a.txt", "one");
    const { store: clones } = store(remote.dir);
    await clones.fetch("acme-api");
    const second = remote.commit("a.txt", "two");
    await clones.fetch("acme-api");
    assert.equal(await clones.headSha("acme-api"), second);
  });

  it("reads a file at a sha, and says so when the file is missing", async () => {
    const remote = origin();
    const first = remote.commit("dir/a.txt", "one");
    remote.commit("dir/a.txt", "two");
    const { store: clones } = store(remote.dir);
    await clones.fetch("acme-api");
    assert.equal(await clones.show("acme-api", first, "dir/a.txt"), "one");
    await assert.rejects(clones.show("acme-api", first, "nope.txt"), /nope\.txt does not exist at /);
    assert.equal(await clones.tryShow("acme-api", first, "nope.txt"), null);
    assert.equal(await clones.tryShow("acme-api", first, "dir/a.txt"), "one");
  });

  it("adds a detached worktree at a sha and removes it with its directory", async () => {
    const remote = origin();
    const first = remote.commit("a.txt", "one");
    remote.commit("a.txt", "two");
    const { store: clones, cloneDir } = store(remote.dir);
    await clones.fetch("acme-api");
    const path = await clones.worktreeAdd("acme-api", first);
    assert.equal(readFileSync(join(path, "a.txt"), "utf8"), "one");
    assert.equal(git(path, "rev-parse", "HEAD"), first);
    assert.equal(git(path, "status", "--porcelain"), "");
    await clones.worktreeRemove("acme-api", path);
    assert.equal(existsSync(path), false);
    assert.equal(git(join(cloneDir, "acme-api.git"), "worktree", "list").split("\n").length, 1);
  });

  it("keeps the token out of the clone's files", async () => {
    const remote = origin();
    remote.commit("a.txt", "one");
    const { store: clones, cloneDir } = store(remote.dir, "ghs_secret_token");
    await clones.fetch("acme-api");
    const config = readFileSync(join(cloneDir, "acme-api.git", "config"), "utf8");
    assert.equal(config.includes("ghs_secret_token"), false);
    assert.equal(config.includes("extraheader"), false);
  });

  it("refuses a repo name that could leave the clone directory", async () => {
    const { store: clones } = store("/nowhere");
    await assert.rejects(clones.fetch("../escape"), /not a valid repository name/);
  });

  it("names the repo when the remote cannot be fetched", async () => {
    const { store: clones } = store(join(tmpdir(), "proseco-no-such-remote"));
    await assert.rejects(clones.fetch("acme-api"), /git fetch for acme-api failed/);
  });
});
