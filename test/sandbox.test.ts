import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Docker, type RunSpec } from "../src/fixer/sandbox/docker.ts";
import { Sandbox } from "../src/fixer/sandbox/sandbox.ts";

function fakeDocker(): { docker: Docker; runs: RunSpec[] } {
  const runs: RunSpec[] = [];
  const docker = {
    async imageExists() {
      return true;
    },
    async build() {},
    async networkCreate() {},
    async networkConnect() {},
    async networkRemove() {},
    async run(spec: RunSpec) {
      runs.push(spec);
      return spec.name;
    },
    async logs() {
      return "listening on 0.0.0.0:3128";
    },
    async rm() {},
  } as unknown as Docker;
  return { docker, runs };
}

function binary(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "proseco-fake-docker-")), "docker");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("Sandbox.start", () => {
  it("runs the repository container as uid 1000 with nothing from the host mounted", async () => {
    const { docker, runs } = fakeDocker();
    await Sandbox.start({ image: "img", attemptId: "t1", docker });
    const box = runs.find((spec) => spec.name === "proseco-box-t1")!;
    assert.equal(box.user, "1000:1000");
    assert.equal(box.workdir, "/work");
    assert.deepEqual(box.binds ?? [], []);
  });

  it("keeps loopback out of the proxy", async () => {
    const { docker, runs } = fakeDocker();
    await Sandbox.start({ image: "img", attemptId: "t1", docker });
    const env = runs.find((spec) => spec.name === "proseco-box-t1")!.env!;
    assert.equal(env["NO_PROXY"], "localhost,127.0.0.1,::1");
    assert.equal(env["no_proxy"], "localhost,127.0.0.1,::1");
    assert.match(env["HTTPS_PROXY"]!, /^http:\/\/proseco-proxy-t1:/);
  });
});

describe("Docker.exec output capture", () => {
  const writes = `i=0; while [ $i -lt 2000 ]; do printf 'line %04d aaaaaaaaaa\\n' $i; i=$((i+1)); done; echo "FAILED tests/t.py::last" >&2`;

  it("keeps the start of the output by default and says it truncated", async () => {
    const docker = new Docker(binary(writes));
    const result = await docker.exec("box", ["x"], 5000, { limit: 1000 });
    assert.equal(result.truncated, true);
    assert.match(result.stdout, /^line 0000/);
    assert.match(result.stdout, /\[output truncated at 1000 bytes\]$/);
    assert.doesNotMatch(result.stdout, /line 1999/);
  });

  it("keeps the start and the end when asked, so a summary printed last survives", async () => {
    const docker = new Docker(binary(writes));
    const result = await docker.exec("box", ["x"], 5000, { limit: 1000, keep: "headtail" });
    assert.equal(result.truncated, true);
    assert.match(result.stdout, /^line 0000/);
    assert.match(result.stdout, /bytes omitted from the middle of the output\]\n[^]*line 1999 aaaaaaaaaa\n$/);
    assert.ok(result.stdout.length < 1300);
    assert.equal(result.stderr, "FAILED tests/t.py::last\n");
    const whole = await docker.exec("box", ["x"], 5000, { limit: 1_000_000, keep: "headtail" });
    assert.equal(whole.truncated, false);
    assert.match(whole.stdout, /^line 0000[^]*line 1999 aaaaaaaaaa\n$/);
  });
});

describe("Docker.exec", () => {
  it("passes input on stdin, with --interactive, only when there is input", async () => {
    const docker = new Docker(binary(`echo "$@" >&2; [ "$2" = --interactive ] && cat`));
    const piped = await docker.exec("box", ["tar", "-xf", "-"], 1000, { input: "archive" });
    assert.equal(piped.stdout, "archive");
    assert.match(piped.stderr, /^exec --interactive box timeout/);
    const plain = await docker.exec("box", ["true"], 1000);
    assert.match(plain.stderr, /^exec box timeout/);
  });

  it("returns stdout as bytes, and fails on a non-zero exit or output over the limit", async () => {
    const docker = new Docker(binary(`printf '\\000\\377abc'; [ "$7" = fail ] && { echo broken >&2; exit 2; }; exit 0`));
    assert.deepEqual(await docker.execBytes("box", ["ok"], 1000, 100), Buffer.from([0, 255, 97, 98, 99]));
    await assert.rejects(docker.execBytes("box", ["fail"], 1000, 100), /fail in box exited with 2: broken/);
    await assert.rejects(docker.execBytes("box", ["ok"], 1000, 3), /wrote more than 3 bytes/);
  });
});
