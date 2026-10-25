import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OllamaClient, type ChatMessage } from "../src/fixer/agent/ollama.ts";

interface Captured {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function fakeFetch(reply: () => Response, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal });
    return reply();
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OPTIONS = { url: "http://ollama.test:11434", model: "m:1b", numCtx: 8192, numPredict: 512, think: true, timeoutMs: 60_000 };
const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("ollama client", () => {
  it("posts a non-streaming chat with tools, think, options and keep_alive, and returns message and usage", async () => {
    const captured: Captured[] = [];
    const client = new OllamaClient(
      OPTIONS,
      fakeFetch(
        () =>
          json({
            message: { role: "assistant", content: "ok", tool_calls: [{ function: { name: "read_file", arguments: { path: "a" } } }] },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 120,
            eval_count: 30,
            total_duration: 2_500_000_000,
          }),
        captured,
      ),
    );
    const tools = [{ type: "function" as const, function: { name: "read_file", description: "d", parameters: { type: "object", properties: {} } } }];
    const { message, usage } = await client.chat(messages, tools);
    assert.equal(captured[0]!.url, "http://ollama.test:11434/api/chat");
    assert.deepEqual(captured[0]!.body, {
      model: "m:1b",
      messages,
      tools,
      stream: false,
      think: true,
      keep_alive: "15m",
      options: { num_ctx: 8192, num_predict: 512, temperature: 0.2 },
    });
    assert.equal(message.tool_calls![0]!.function.name, "read_file");
    assert.deepEqual(usage, { promptTokens: 120, outputTokens: 30, durationMs: 2500, truncated: false });
  });

  it("sends a format schema only when given, and omits tools when there are none", async () => {
    const captured: Captured[] = [];
    const client = new OllamaClient({ ...OPTIONS, think: false, temperature: 0.3 }, fakeFetch(() => json({ message: { role: "assistant", content: "{}" }, done: true }), captured));
    await client.chat(messages, [], { type: "object" });
    assert.deepEqual(captured[0]!.body["format"], { type: "object" });
    assert.equal("tools" in captured[0]!.body, false);
    assert.equal(captured[0]!.body["think"], false);
    assert.equal((captured[0]!.body["options"] as Record<string, unknown>)["temperature"], 0.3);
  });

  it("reports a truncated reply when done_reason is length", async () => {
    const client = new OllamaClient(OPTIONS, fakeFetch(() => json({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", eval_count: 512 })));
    assert.equal((await client.chat(messages, [])).usage.truncated, true);
  });

  it("names the model when ollama reports an error", async () => {
    const client = new OllamaClient(OPTIONS, fakeFetch(() => json({ error: "model 'm:1b' not found" }, 404)));
    await assert.rejects(client.chat(messages, []), /ollama model m:1b: model 'm:1b' not found/);
  });

  it("names the model when the body is not JSON", async () => {
    const client = new OllamaClient(OPTIONS, fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 })));
    await assert.rejects(client.chat(messages, []), /ollama model m:1b: 502/);
  });

  it("names the model and url when the server is unreachable", async () => {
    const client = new OllamaClient(OPTIONS, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await assert.rejects(client.chat(messages, []), /ollama model m:1b at http:\/\/ollama\.test:11434: fetch failed/);
  });

  it("aborts a call that outlives its timeout", async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const client = new OllamaClient({ ...OPTIONS, timeoutMs: 30 }, hang);
    await assert.rejects(client.chat(messages, []), /ollama model m:1b .*timed out after 0\.03 s/);
  });

  it("derives a client with another temperature", async () => {
    const captured: Captured[] = [];
    const client = new OllamaClient(OPTIONS, fakeFetch(() => json({ message: { role: "assistant", content: "" }, done: true }), captured));
    await client.withTemperature(0).chat(messages, []);
    assert.equal((captured[0]!.body["options"] as Record<string, unknown>)["temperature"], 0);
  });

  it("derives a client with another think setting without changing the original", async () => {
    const captured: Captured[] = [];
    const client = new OllamaClient(OPTIONS, fakeFetch(() => json({ message: { role: "assistant", content: "" }, done: true }), captured));
    await client.withThink(false).chat(messages, []);
    await client.chat(messages, []);
    assert.deepEqual(captured.map((call) => call.body["think"]), [false, true]);
  });
});
