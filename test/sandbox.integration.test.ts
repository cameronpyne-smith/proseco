import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Docker } from "../src/fixer/sandbox/docker.ts";
import { ensureImage, imageFor } from "../src/fixer/sandbox/images.ts";
import { Sandbox } from "../src/fixer/sandbox/sandbox.ts";

const run = promisify(execFile);
const enabled = process.env["PROSECO_DOCKER_TESTS"] === "1";
const fixture = join(import.meta.dirname, "fixtures", "sandbox-node");

async function labelled(kind: "ps" | "network", attempt: string): Promise<string[]> {
  const args = kind === "ps" ? ["ps", "--all", "--quiet"] : ["network", "ls", "--quiet"];
  const { stdout } = await run("docker", [...args, "--filter", `label=proseco.attempt=${attempt}`]);
  return stdout.split("\n").filter(Boolean);
}

describe("sandbox", { skip: !enabled && "set PROSECO_DOCKER_TESTS=1 to run against Docker" }, () => {
  const attemptId = `it-${Date.now().toString(36)}`;
  const workspace = mkdtempSync(join(tmpdir(), "proseco-it-"));
  const worktree = join(workspace, "work");
  let sandbox: Sandbox;

  before(async () => {
    cpSync(fixture, worktree, { recursive: true });
    const image = await ensureImage(new Docker(), imageFor("node", ">=24"));
    sandbox = await Sandbox.start({ image, attemptId });
    await sandbox.load(worktree);
  });

  after(async () => {
    await sandbox?.stop();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("works as uid 1000 on a copy with a baseline commit, not on the host's files", async () => {
    const result = await sandbox.run(["sh", "-c", "id -u && touch package.json created.txt && git status --porcelain"], 60_000);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "1000\n?? created.txt\n");
    assert.equal(existsSync(join(worktree, "created.txt")), false);
  });

  it("installs a lockfile through the proxy", async () => {
    const result = await sandbox.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], 5 * 60 * 1000);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((await sandbox.run(["test", "-f", "node_modules/left-pad/package.json"], 60_000)).exitCode, 0);
  });

  it("copies the work out without node_modules or the container's .git", async () => {
    await sandbox.save(worktree);
    assert.ok(existsSync(join(worktree, "created.txt")));
    assert.equal(existsSync(join(worktree, "node_modules")), false);
    assert.equal(existsSync(join(worktree, ".git")), false);
  });

  it("refuses a host that is not on the allowlist and says so in the proxy log", async () => {
    const result = await sandbox.run(["node", "-e", "fetch('https://example.com').then(r=>process.exit(r.ok?0:1),()=>process.exit(2))"], 60_000);
    assert.equal(result.exitCode, 2);
    assert.match(await sandbox.proxyLog(), /refused example\.com:443/);
  });

  it("reaches an allowed registry through the proxy", async () => {
    const result = await sandbox.run(["node", "-e", "fetch('https://registry.npmjs.org/left-pad').then(r=>process.exit(r.ok?0:1),()=>process.exit(2))"], 60_000);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(await sandbox.proxyLog(), /allowed registry\.npmjs\.org:443/);
  });

  it("has no direct route to the internet", async () => {
    const result = await sandbox.run(["node", "-e", "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"], 60_000);
    assert.equal(result.exitCode, 1);
  });

  it("times out a command that outlives its limit", async () => {
    const started = Date.now();
    const result = await sandbox.run(["sleep", "30"], 2000);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  });

  it("leaves no labelled container or network after stop", async () => {
    assert.equal((await labelled("ps", attemptId)).length, 2);
    await sandbox.stop();
    assert.deepEqual(await labelled("ps", attemptId), []);
    assert.deepEqual(await labelled("network", attemptId), []);
  });
});
