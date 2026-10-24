import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLoop, SHRUNK_OUTPUT, type LoopInput } from "../src/fixer/agent/loop.ts";
import type { ChatMessage, ChatResult, ToolDefinition } from "../src/fixer/agent/ollama.ts";
import { executeTool, TOOL_DEFINITIONS, type ToolEnv } from "../src/fixer/agent/tools.ts";

type Step = Partial<ChatMessage> & { error?: string; truncated?: boolean };

function call(name: string, args: Record<string, unknown> = {}) {
  return { function: { name, arguments: args } };
}

const FINISH = call("finish", { summary: "Done.", changes: [{ package: "p", from: "1.0.0", to: "1.0.1", how: "direct-bump" }] });

function scripted(steps: Step[]) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  return {
    seen,
    async chat(messages: ChatMessage[], _tools?: ToolDefinition[]): Promise<ChatResult> {
      seen.push(structuredClone(messages));
      const step = steps[index++] ?? { content: "" };
      if (step.error) throw new Error(step.error);
      return {
        message: { role: "assistant", content: step.content ?? "", ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}), ...(step.thinking ? { thinking: step.thinking } : {}) },
        usage: { promptTokens: 100 * index, outputTokens: 10, durationMs: 1000, truncated: step.truncated ?? false },
      };
    },
  };
}

function fakeEnv(outputs: Record<string, string> = {}): { env: ToolEnv; ran: string[] } {
  const ran: string[] = [];
  const env: ToolEnv = {
    root: "/nonexistent",
    commandTimeoutMs: 1000,
    git: async () => "",
    run: async (command) => {
      ran.push(command[2]!);
      return { exitCode: 0, stdout: outputs[command[2]!] ?? "ok", stderr: "", truncated: false, timedOut: false };
    },
  };
  return { env, ran };
}

function input(model: ReturnType<typeof scripted>, env: ToolEnv, overrides: Partial<LoopInput> = {}): LoopInput {
  return {
    llm: model,
    numCtx: 65536,
    headroom: 12288,
    tools: TOOL_DEFINITIONS,
    execute: (name, args) => executeTool(env, name, args),
    system: "system",
    user: "user",
    timeBudgetMs: 60_000,
    maxToolCalls: 50,
    now: () => 0,
    ...overrides,
  };
}

describe("agent loop", () => {
  it("finishes when the model calls finish, returning its arguments and the stats", async () => {
    const model = scripted([{ tool_calls: [call("run", { command: "npm ls" })] }, { tool_calls: [FINISH] }]);
    const { env, ran } = fakeEnv();
    const result = await runLoop(input(model, env));
    assert.equal(result.outcome, "finished");
    assert.equal(result.finish!.summary, "Done.");
    assert.deepEqual(ran, ["npm ls"]);
    assert.equal(result.stats.toolCalls, 1);
    assert.equal(result.stats.rounds, 2);
    assert.equal(result.stats.outputTokens, 20);
    assert.equal(result.stats.promptTokens, 200);
    assert.equal(result.stats.modelMs, 2000);
    assert.deepEqual(result.trace.map((entry) => entry.tool), ["run", "finish"]);
  });

  it("starts the conversation with the system and user prompts and offers the tools", async () => {
    const model = scripted([{ tool_calls: [FINISH] }]);
    const seenTools: unknown[] = [];
    const original = model.chat;
    model.chat = async (messages, tools) => {
      seenTools.push(tools);
      return original(messages);
    };
    await runLoop(input(model, fakeEnv().env));
    assert.deepEqual(model.seen[0], [{ role: "system", content: "system" }, { role: "user", content: "user" }]);
    assert.equal(seenTools[0], TOOL_DEFINITIONS);
  });

  it("executes every tool call of a message in order and appends each result", async () => {
    const model = scripted([{ tool_calls: [call("run", { command: "a" }), call("run", { command: "b" })] }, { tool_calls: [FINISH] }]);
    const { env, ran } = fakeEnv({ a: "A-out", b: "B-out" });
    await runLoop(input(model, env));
    assert.deepEqual(ran, ["a", "b"]);
    const second = model.seen[1]!;
    assert.deepEqual(second.slice(-2).map((message) => [message.role, message.tool_name, message.content.includes("-out")]), [["tool", "run", true], ["tool", "run", true]]);
    assert.ok(second.at(-2)!.content.includes("A-out"));
    assert.ok(second.at(-1)!.content.includes("B-out"));
  });

  it("stops at the tool-call cap without running the call that would exceed it", async () => {
    const model = scripted([{ tool_calls: [call("run", { command: "a" }), call("run", { command: "b" }), call("run", { command: "c" })] }]);
    const { env, ran } = fakeEnv();
    const result = await runLoop(input(model, env, { maxToolCalls: 2 }));
    assert.equal(result.outcome, "budget");
    assert.deepEqual(ran, ["a", "b"]);
    assert.equal(result.stats.toolCalls, 2);
  });

  it("stops when the time budget is spent, before asking the model again", async () => {
    let clock = 0;
    const model = scripted([{ tool_calls: [call("run", { command: "a" })] }, { tool_calls: [FINISH] }]);
    const { env } = fakeEnv();
    const result = await runLoop(input(model, env, { timeBudgetMs: 5000, now: () => (clock += 3000) }));
    assert.equal(result.outcome, "budget");
    assert.equal(model.seen.length <= 2, true);
    assert.equal(result.finish, undefined);
  });

  it("nudges once when the model answers without a tool call, then accepts a finish", async () => {
    const model = scripted([{ content: "I think I am done." }, { tool_calls: [FINISH] }]);
    const result = await runLoop(input(model, fakeEnv().env));
    assert.equal(result.outcome, "finished");
    const nudge = model.seen[1]!.at(-1)!;
    assert.equal(nudge.role, "user");
    assert.match(nudge.content, /call finish/);
  });

  it("is stalled when the model answers without a tool call twice in a row", async () => {
    const model = scripted([{ content: "hmm" }, { content: "still hmm" }, { tool_calls: [FINISH] }]);
    const result = await runLoop(input(model, fakeEnv().env));
    assert.equal(result.outcome, "stalled");
    assert.equal(model.seen.length, 2);
  });

  it("does not count two empty answers separated by a tool call as a stall", async () => {
    const model = scripted([{ content: "a" }, { tool_calls: [call("run", { command: "x" })] }, { content: "b" }, { tool_calls: [FINISH] }]);
    assert.equal((await runLoop(input(model, fakeEnv().env))).outcome, "finished");
  });

  it("tells the model its reasoning was cut off when a reply is truncated and empty", async () => {
    const model = scripted([{ truncated: true }, { tool_calls: [FINISH] }]);
    await runLoop(input(model, fakeEnv().env));
    assert.match(model.seen[1]!.at(-1)!.content, /cut off/);
  });

  it("keeps going after a finish call with invalid arguments", async () => {
    const model = scripted([{ tool_calls: [call("finish", { summary: "" })] }, { tool_calls: [FINISH] }]);
    const result = await runLoop(input(model, fakeEnv().env));
    assert.equal(result.outcome, "finished");
    assert.match(model.seen[1]!.at(-1)!.content, /invalid finish arguments/);
  });

  it("reports a model error with the stats so far", async () => {
    const model = scripted([{ tool_calls: [call("run", { command: "a" })] }, { error: "ollama model m: boom" }]);
    const result = await runLoop(input(model, fakeEnv().env));
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "ollama model m: boom");
    assert.equal(result.stats.toolCalls, 1);
  });

  it("drops thinking from every assistant message except the newest", async () => {
    const model = scripted([{ thinking: "first thoughts", tool_calls: [call("run", { command: "a" })] }, { thinking: "second thoughts", tool_calls: [call("run", { command: "b" })] }, { tool_calls: [FINISH] }]);
    await runLoop(input(model, fakeEnv().env));
    const last = model.seen[2]!.filter((message) => message.role === "assistant");
    assert.equal(last[0]!.thinking, undefined);
    assert.equal(last[1]!.thinking, "second thoughts");
  });

  describe("shrinking", () => {
    function bulky(rounds: number) {
      const steps: Step[] = Array.from({ length: rounds }, (_, index) => ({ tool_calls: [call("run", { command: `cmd-${index}` })] }));
      steps.push({ tool_calls: [FINISH] });
      const outputs = Object.fromEntries(Array.from({ length: rounds }, (_, index) => [`cmd-${index}`, `out-${index} ${"x".repeat(4000)}`]));
      return { model: scripted(steps), env: fakeEnv(outputs).env };
    }

    it("replaces the oldest tool results with a placeholder once the estimate passes numCtx minus headroom, keeping the last 8", async () => {
      const { model, env } = bulky(20);
      const result = await runLoop(input(model, env, { numCtx: 9000, headroom: 1000 }));
      assert.equal(result.outcome, "finished");
      const last = model.seen.at(-1)!;
      const tools = last.filter((message) => message.role === "tool");
      assert.equal(tools.length, 20);
      const kept = tools.slice(-8);
      assert.ok(kept.every((message) => message.content.includes("out-")));
      const dropped = tools.slice(0, -8);
      assert.ok(dropped.every((message) => message.content === SHRUNK_OUTPUT));
      assert.equal(dropped.length, 12);
      assert.equal(tools[0]!.content, SHRUNK_OUTPUT);
      assert.deepEqual(last.slice(0, 2).map((message) => message.content), ["system", "user"]);
      assert.ok(result.stats.shrinks > 0);
    });

    it("leaves a conversation under the limit untouched", async () => {
      const { model, env } = bulky(5);
      const result = await runLoop(input(model, env));
      assert.ok(model.seen.at(-1)!.filter((message) => message.role === "tool").every((message) => message.content.includes("out-")));
      assert.equal(result.stats.shrinks, 0);
    });

    it("stops replacing as soon as the estimate fits", async () => {
      const { model, env } = bulky(12);
      await runLoop(input(model, env, { numCtx: 11500, headroom: 1000 }));
      const tools = model.seen.at(-1)!.filter((message) => message.role === "tool");
      const replaced = tools.filter((message) => message.content === SHRUNK_OUTPUT).length;
      assert.ok(replaced > 0 && replaced < 4, `replaced ${replaced}`);
    });
  });
});
