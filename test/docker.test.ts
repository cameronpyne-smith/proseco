import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildArgs, execArgs, networkCreateArgs, runArgs } from "../src/fixer/sandbox/docker.ts";

describe("docker arguments", () => {
  it("labels and isolates an internal network", () => {
    assert.deepEqual(networkCreateArgs("proseco-a1", true, "a1"), ["network", "create", "--label", "proseco.attempt=a1", "--internal", "proseco-a1"]);
    assert.deepEqual(networkCreateArgs("proseco-a1", false, "a1"), ["network", "create", "--label", "proseco.attempt=a1", "proseco-a1"]);
  });

  it("builds a hardened detached run", () => {
    const args = runArgs({
      name: "box",
      image: "proseco/node:24",
      network: "proseco-a1",
      attempt: "a1",
      user: "1000:1001",
      workdir: "/work",
      env: { HTTPS_PROXY: "http://p:3128" },
      binds: ["/tmp/w:/work"],
      tmpfs: ["/tmp:exec"],
      memory: "8g",
      cpus: 4,
      pidsLimit: 2048,
      command: ["sleep", "infinity"],
    });
    assert.deepEqual(args, [
      "run", "-d", "--name", "box", "--network", "proseco-a1", "--label", "proseco.attempt=a1",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1001", "--workdir", "/work",
      "--env", "HTTPS_PROXY=http://p:3128",
      "--volume", "/tmp/w:/work", "--tmpfs", "/tmp:exec",
      "--memory", "8g", "--cpus", "4", "--pids-limit", "2048",
      "proseco/node:24", "sleep", "infinity",
    ]);
  });

  it("omits optional run flags that are not given", () => {
    const args = runArgs({ name: "p", image: "proseco/proxy:dev", network: "n", attempt: "a", command: [] });
    assert.deepEqual(args, ["run", "-d", "--name", "p", "--network", "n", "--label", "proseco.attempt=a", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "proseco/proxy:dev"]);
  });

  it("wraps an exec in timeout so the whole process group dies", () => {
    assert.deepEqual(execArgs("box", ["npm", "ci"], 90_000), ["exec", "box", "timeout", "-k", "1", "90s", "npm", "ci"]);
    assert.deepEqual(execArgs("box", ["sleep", "5"], 1500), ["exec", "box", "timeout", "-k", "1", "1.5s", "sleep", "5"]);
  });

  it("builds an image with build args and a context", () => {
    assert.deepEqual(buildArgs({ tag: "proseco/node:24", dockerfile: "/d/Dockerfile", context: "/d", buildArgs: { NODE_MAJOR: "24" } }), [
      "build", "--tag", "proseco/node:24", "--file", "/d/Dockerfile", "--build-arg", "NODE_MAJOR=24", "/d",
    ]);
  });
});
