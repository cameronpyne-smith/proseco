import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allPassed, checkOllama, formatChecks, runChecks } from "../src/fixer/startup.ts";

function tags(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("startup checks", () => {
  it("runs every check, reporting each as ok or with its reason", async () => {
    const results = await runChecks([
      { name: "config", run: async () => "loaded" },
      { name: "docker", run: async () => Promise.reject(new Error("Cannot connect to the Docker daemon")) },
      { name: "ollama", run: async () => "answers" },
    ]);
    assert.equal(allPassed(results), false);
    assert.equal(formatChecks(results), ["ok config: loaded", "FAILED docker: Cannot connect to the Docker daemon", "ok ollama: answers"].join("\n"));
  });

  it("stops at a failed required check, since the rest depend on it", async () => {
    const results = await runChecks([
      { name: "config", required: true, run: async () => Promise.reject(new Error("bad config")) },
      { name: "docker", run: async () => "ok" },
    ]);
    assert.deepEqual(results.map((result) => result.name), ["config"]);
  });

  it("passes when every check does", async () => {
    assert.equal(allPassed(await runChecks([{ name: "a", run: async () => "fine" }])), true);
  });
});

describe("the Ollama check", () => {
  it("accepts a server that lists the model", async () => {
    assert.match(await checkOllama("http://gpu.example.test:11434/", "qwen3.8:27b", tags({ models: [{ name: "llama3:8b" }, { name: "qwen3.8:27b" }] })), /has qwen3\.8:27b/);
  });

  it("treats a model name without a tag as :latest", async () => {
    await checkOllama("http://x", "tiny", tags({ models: [{ name: "tiny:latest" }] }));
    await assert.rejects(checkOllama("http://x", "tiny", tags({ models: [{ name: "tiny:1b" }] })), /does not have the model tiny/);
  });

  it("names the models it does have when the wanted one is missing", async () => {
    await assert.rejects(checkOllama("http://x", "qwen3.8:27b", tags({ models: [{ name: "llama3:8b" }] })), /does not have the model qwen3\.8:27b \(it has llama3:8b\)/);
    await assert.rejects(checkOllama("http://x", "m:1", tags({})), /it has none/);
  });

  it("fails when the server does not answer or answers with an error", async () => {
    const down = (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await assert.rejects(checkOllama("http://x", "m:1", down), /does not answer at http:\/\/x: fetch failed/);
    await assert.rejects(checkOllama("http://x", "m:1", tags({}, 500)), /answered \/api\/tags with 500/);
  });
});
