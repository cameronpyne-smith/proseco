import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Docker, type RunSpec } from "../src/fixer/sandbox/docker.ts";
import { Sandbox } from "../src/fixer/sandbox/sandbox.ts";

function fakeDocker(rootless: boolean): { docker: Docker; runs: RunSpec[] } {
  const runs: RunSpec[] = [];
  const docker = {
    async rootless() {
      return rootless;
    },
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

async function startBox(rootless: boolean): Promise<RunSpec> {
  const { docker, runs } = fakeDocker(rootless);
  await Sandbox.start({ worktree: "/w", image: "img", attemptId: "t1", uid: 1234, gid: 5678, docker });
  return runs.find((spec) => spec.name === "proseco-box-t1")!;
}

describe("Sandbox.start user", () => {
  it("runs the repository container as 0:0 under a rootless daemon", async () => {
    assert.equal((await startBox(true)).user, "0:0");
  });

  it("keeps the given uid and gid under a rootful daemon", async () => {
    assert.equal((await startBox(false)).user, "1234:5678");
  });
});

describe("Docker.rootless", () => {
  function binary(securityOptions: string): string {
    const dir = mkdtempSync(join(tmpdir(), "proseco-fake-docker-"));
    const path = join(dir, "docker");
    writeFileSync(path, `#!/bin/sh\necho x >> "${dir}/calls"\necho '${securityOptions}'\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("is true when the security options name rootless, and false otherwise", async () => {
    assert.equal(await new Docker(binary("[name=seccomp,profile=builtin name=rootless name=cgroupns]")).rootless(), true);
    assert.equal(await new Docker(binary("[name=seccomp,profile=builtin name=cgroupns]")).rootless(), false);
  });

  it("asks the daemon once per instance", async () => {
    const path = binary("[name=rootless]");
    const docker = new Docker(path);
    await docker.rootless();
    await docker.rootless();
    assert.equal(readFileSync(join(path, "..", "calls"), "utf8").trim().split("\n").length, 1);
  });
});
