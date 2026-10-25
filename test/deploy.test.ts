import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_BUDGET, DEFAULT_OLLAMA, DEFAULT_POLL_MINUTES, DEFAULT_PROXY_ALLOW, DEFAULT_SANDBOX_LIMITS, loadConfig } from "../src/core/config.ts";

const DEPLOY = join(import.meta.dirname, "..", "deploy");

function installed(): string {
  const dir = mkdtempSync(join(tmpdir(), "proseco-deploy-"));
  copyFileSync(join(DEPLOY, "config.example.json"), join(dir, "config.json"));
  return dir;
}

describe("deploy examples", () => {
  it("the example config loads as a fixer-only config", () => {
    const config = loadConfig(join(installed(), "config.json"));
    assert.ok(config.fixer);
    assert.equal(config.sources, null);
  });

  it("the example config states every fixer default explicitly", () => {
    const fixer = loadConfig(join(installed(), "config.json")).fixer!;
    const raw = JSON.parse(readFileSync(join(DEPLOY, "config.example.json"), "utf8")).fixer;
    assert.equal(raw.pollMinutes, DEFAULT_POLL_MINUTES);
    assert.deepEqual(raw.proxy.allow, [...DEFAULT_PROXY_ALLOW]);
    assert.deepEqual(raw.sandbox, DEFAULT_SANDBOX_LIMITS);
    assert.deepEqual(raw.ollama, DEFAULT_OLLAMA);
    assert.deepEqual(raw.budget, DEFAULT_BUDGET);
    assert.equal(fixer.cloneDir, "/var/lib/proseco/clones");
    assert.equal(fixer.stateFile, "/var/lib/proseco/state.json");
  });
});
