import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextLimit, runLoop, SHRUNK_OUTPUT, type LoopInput } from "../src/fixer/agent/loop.ts";
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
    commandTimeoutMs: 1000,
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

  it("hands every message to the recorder as it happens, thinking included", async () => {
    const recorded: ChatMessage[] = [];
    const model = scripted([{ thinking: "plan", tool_calls: [call("run", { command: "a" })] }, { tool_calls: [FINISH] }]);
    await runLoop(input(model, fakeEnv().env, { record: (message) => recorded.push(message) }));
    assert.deepEqual(recorded.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant", "tool"]);
    assert.equal(recorded[2]!.thinking, "plan");
  });

  it("sends a reply cut off before it said anything back without its thinking", async () => {
    const model = scripted([{ truncated: true, thinking: "a very long chain" }, { tool_calls: [FINISH] }]);
    await runLoop(input(model, fakeEnv().env));
    const cut = model.seen[1]!.find((message) => message.role === "assistant")!;
    assert.equal(cut.thinking, undefined);
  });

  describe("forced finish", () => {
    function finaliser(replies: string[]) {
      const calls: { messages: ChatMessage[]; tools: ToolDefinition[]; format: unknown }[] = [];
      return {
        calls,
        async chat(messages: ChatMessage[], tools: ToolDefinition[], format?: Record<string, unknown>): Promise<ChatResult> {
          calls.push({ messages: structuredClone(messages), tools, format });
          return { message: { role: "assistant", content: replies.shift() ?? "" }, usage: { promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false } };
        },
      };
    }
    const ANSWER = JSON.stringify({ summary: "Added an override.", changes: [{ package: "p", from: "1.0.0", to: "1.0.1", how: "override" }] });

    it("asks for the finish arguments with no tools and the finish schema when the model stalls", async () => {
      const model = scripted([{ thinking: "old", tool_calls: [call("run", { command: "a" })] }, { content: "hmm" }, { content: "still hmm" }]);
      const low = finaliser([ANSWER]);
      const result = await runLoop(input(model, fakeEnv().env, { finaliseWith: [low] }));
      assert.equal(result.outcome, "finished");
      assert.equal(result.forced, "stalled");
      assert.equal(result.finish!.summary, "Added an override.");
      assert.deepEqual(low.calls[0]!.tools, []);
      assert.deepEqual(low.calls[0]!.format, TOOL_DEFINITIONS.find((tool) => tool.function.name === "finish")!.function.parameters);
      assert.match(low.calls[0]!.messages.at(-1)!.content, /Produce the finish arguments as a JSON object/);
      assert.ok(low.calls[0]!.messages.every((message) => message.thinking === undefined));
    });

    it("tries the next client when an answer is not a valid finish object, then gives the original outcome when none is", async () => {
      const model = scripted([{ content: "a" }, { content: "b" }]);
      const low = finaliser(["not json"]);
      const off = finaliser([`\`\`\`json\n${ANSWER}\n\`\`\``]);
      const result = await runLoop(input(model, fakeEnv().env, { finaliseWith: [low, off] }));
      assert.equal(result.forced, "stalled");
      assert.match(off.calls[0]!.messages.at(-1)!.content, /not a valid finish object/);

      const failing = await runLoop(input(scripted([{ content: "a" }, { content: "b" }]), fakeEnv().env, { finaliseWith: [finaliser(["{}"]), finaliser(["nope"])] }));
      assert.equal(failing.outcome, "stalled");
      assert.equal(failing.finish, undefined);
    });

    it("forces a final answer at the tool-call cap and the time budget too", async () => {
      const capped = await runLoop(input(scripted([{ tool_calls: [call("run", { command: "a" }), call("run", { command: "b" })] }]), fakeEnv().env, { maxToolCalls: 1, finaliseWith: [finaliser([ANSWER])] }));
      assert.deepEqual([capped.outcome, capped.forced], ["finished", "budget"]);
      let clock = 0;
      const late = await runLoop(input(scripted([{ tool_calls: [call("run", { command: "a" })] }]), fakeEnv().env, { timeBudgetMs: 5000, now: () => (clock += 3000), finaliseWith: [finaliser([ANSWER])] }));
      assert.deepEqual([late.outcome, late.forced], ["finished", "budget"]);
    });
  });

  describe("repetition guard", () => {
    const same = () => ({ tool_calls: [call("run", { command: "npm test" })] });

    it("does not run the third identical call with an identical result, and says so", async () => {
      const env = fakeEnv();
      const model = scripted([same(), same(), same(), same(), { tool_calls: [FINISH] }]);
      const result = await runLoop(input(model, env.env));
      assert.equal(result.outcome, "finished");
      assert.deepEqual(env.ran, ["npm test", "npm test"]);
      const tools = model.seen.at(-1)!.filter((message) => message.role === "tool").map((message) => message.content);
      assert.equal(tools.length, 4);
      assert.match(tools[2]!, /already ran this exact call 2 times with the same result, so it was not run again/);
      assert.match(tools[3]!, /call finish/);
      assert.equal(result.stats.toolCalls, 4);
    });

    it("lets a repeat through when the result changed, when the arguments differ, or after the agent edited a file", async () => {
      let n = 0;
      const env = fakeEnv();
      env.env.run = async (command) => {
        env.ran.push(command[2]!);
        return { exitCode: 0, stdout: command[2] === "flaky" ? `out ${n++}` : "ok", stderr: "", truncated: false, timedOut: false };
      };
      const flaky = { tool_calls: [call("run", { command: "flaky" })] };
      const edit = { tool_calls: [call("write_file", { path: "a.txt", content: "x" })] };
      const model = scripted([flaky, flaky, flaky, same(), same(), edit, same(), same(), { tool_calls: [FINISH] }]);
      const result = await runLoop(input(model, env.env, { execute: (name, args) => (name === "write_file" ? Promise.resolve({ content: "wrote" }) : executeTool(env.env, name, args)) }));
      assert.equal(result.outcome, "finished");
      assert.equal(env.ran.filter((command) => command === "flaky").length, 3);
      assert.equal(env.ran.filter((command) => command === "npm test").length, 4);
    });

    it("forces a final answer as stalled when the agent keeps repeating blocked calls", async () => {
      const finish = { async chat(): Promise<ChatResult> { return { message: { role: "assistant", content: JSON.stringify({ summary: "Stuck.", changes: [{ package: "p", from: "1", to: "2", how: "override" }] }) }, usage: { promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false } }; } };
      const model = scripted(Array.from({ length: 12 }, same));
      const result = await runLoop(input(model, fakeEnv().env, { finaliseWith: [finish] }));
      assert.deepEqual([result.outcome, result.forced], ["finished", "stalled"]);
    });
  });

  describe("stall feedback", () => {
    const finaliser = (calls: { n: number }) => ({
      async chat(): Promise<ChatResult> {
        calls.n++;
        return { message: { role: "assistant", content: JSON.stringify({ summary: "Done.", changes: [{ package: "p", from: "1", to: "2", how: "override" }] }) }, usage: { promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false } };
      },
    });

    it("sends the lockfile status on the first stall and lets the agent carry on, forcing a finish only on the second", async () => {
      const calls = { n: 0 };
      let asked = 0;
      const status = async () => (++asked, "STATUS: tmp FAILING");
      const model = scripted([{ content: "hmm" }, { content: "hmm" }, { tool_calls: [FINISH] }]);
      const fed = await runLoop(input(model, fakeEnv().env, { status, finaliseWith: [finaliser(calls)] }));
      assert.deepEqual([fed.outcome, fed.forced, asked, calls.n], ["finished", undefined, 1, 0]);
      const fedMessage = model.seen[2]!.at(-1)!;
      assert.equal(fedMessage.role, "user");
      assert.match(fedMessage.content, /^STATUS: tmp FAILING\n\nYou are going round in circles\. Fix the failing checks above, or call finish if nothing more can be done\./);

      const again = await runLoop(input(scripted([{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }]), fakeEnv().env, { status, finaliseWith: [finaliser(calls)] }));
      assert.deepEqual([again.outcome, again.forced, asked, calls.n], ["finished", "stalled", 2, 1]);
    });

    it("does the same for the repetition guard's stall", async () => {
      const calls = { n: 0 };
      const same = { tool_calls: [call("run", { command: "npm test" })] };
      const model = scripted([...Array.from({ length: 6 }, () => same), { tool_calls: [FINISH] }]);
      const result = await runLoop(input(model, fakeEnv().env, { status: async () => "STATUS", finaliseWith: [finaliser(calls)] }));
      assert.deepEqual([result.outcome, result.forced, calls.n], ["finished", undefined, 0]);
      assert.ok(model.seen.some((messages) => messages.some((message) => message.role === "user" && message.content.startsWith("STATUS"))));
    });

    it("forces the finish at once when there is no status or it fails, and never feeds back for the budget", async () => {
      const calls = { n: 0 };
      const none = await runLoop(input(scripted([{ content: "a" }, { content: "b" }]), fakeEnv().env, { finaliseWith: [finaliser(calls)] }));
      assert.equal(none.forced, "stalled");
      const broken = await runLoop(input(scripted([{ content: "a" }, { content: "b" }]), fakeEnv().env, { status: async () => { throw new Error("x"); }, finaliseWith: [finaliser(calls)] }));
      assert.equal(broken.forced, "stalled");
      let asked = 0;
      const capped = await runLoop(input(scripted([{ tool_calls: [call("run", { command: "a" }), call("run", { command: "b" })] }]), fakeEnv().env, { maxToolCalls: 1, status: async () => (++asked, "s"), finaliseWith: [finaliser(calls)] }));
      assert.deepEqual([capped.forced, asked], ["budget", 0]);
    });
  });

  describe("lockfile_status in the repetition guard", () => {
    it("runs every time, because resolver commands change the answer without an edit", async () => {
      let n = 0;
      const execute = async (name: string) => (name === "lockfile_status" ? { content: "same" } : { content: `out ${n++}` });
      const status = { tool_calls: [call("lockfile_status")] };
      const model = scripted([status, status, status, status, { tool_calls: [FINISH] }]);
      let ran = 0;
      const result = await runLoop(input(model, fakeEnv().env, { execute: (name, args) => (name === "finish" ? executeTool(fakeEnv().env, name, args) : (ran++, execute(name))) }));
      assert.equal(result.outcome, "finished");
      assert.equal(ran, 4);
    });
  });

  describe("finish gate", () => {
    function gated(gate: () => Promise<string | null>, steps: Step[], overrides: Partial<LoopInput> = {}) {
      const model = scripted(steps);
      const recorded: ChatMessage[] = [];
      return runLoop(input(model, fakeEnv().env, { gate, record: (message) => recorded.push(message), ...overrides })).then((result) => ({ result, model, recorded }));
    }

    it("replaces the first finish with the review and accepts the second", async () => {
      let asked = 0;
      const { result, model, recorded } = await gated(async () => (++asked === 1 ? "Not accepted yet: review." : null), [{ tool_calls: [FINISH] }, { tool_calls: [FINISH] }]);
      assert.equal(result.outcome, "finished");
      assert.equal(asked, 2);
      assert.equal(result.stats.rounds, 2);
      assert.ok(model.seen[1]!.some((message) => message.role === "tool" && message.content === "Not accepted yet: review."));
      assert.ok(recorded.some((message) => message.role === "tool" && message.content === "Not accepted yet: review."));
    });

    it("asks the gate on every finish, but at most three times, then accepts", async () => {
      let asked = 0;
      const { result } = await gated(async () => (++asked, "Not accepted yet."), Array.from({ length: 5 }, () => ({ tool_calls: [FINISH] })));
      assert.equal(result.outcome, "finished");
      assert.equal(asked, 3);
      assert.equal(result.stats.rounds, 4);
    });

    it("accepts the finish at once when the gate has nothing to say", async () => {
      const { result } = await gated(async () => null, [{ tool_calls: [FINISH] }]);
      assert.equal(result.stats.rounds, 1);
      assert.equal(result.outcome, "finished");
    });

    it("does not gate when the tool-call budget or the time is used up", async () => {
      let asked = 0;
      const gate = async () => (++asked, "review");
      const spent = await gated(gate, [{ tool_calls: [call("run", { command: "a" }), FINISH] }], { maxToolCalls: 1 });
      assert.equal(spent.result.outcome, "finished");
      let clock = 0;
      const late = await gated(gate, [{ tool_calls: [call("run", { command: "a" })] }, { tool_calls: [FINISH] }], { timeBudgetMs: 5000, now: () => (clock += 3000) });
      assert.equal(asked, 0);
      assert.equal(late.result.outcome === "finished" || late.result.outcome === "budget", true);
    });
  });

  it("limits context to 80% of numCtx, or numCtx minus the output headroom when that is smaller", () => {
    assert.equal(contextLimit(131072, 12288), 104857);
    assert.equal(contextLimit(16384, 12288), 4096);
  });

  describe("shrinking", () => {
    function bulky(rounds: number) {
      const steps: Step[] = Array.from({ length: rounds }, (_, index) => ({ tool_calls: [call("run", { command: `cmd-${index}` })] }));
      steps.push({ tool_calls: [FINISH] });
      const outputs = Object.fromEntries(Array.from({ length: rounds }, (_, index) => [`cmd-${index}`, `out-${index} ${"x".repeat(4000)}`]));
      return { model: scripted(steps), env: fakeEnv(outputs).env };
    }

    it("replaces the oldest tool results with a placeholder once the estimate passes the context limit, keeping the last 8", async () => {
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

    it("cuts a single tool result that alone would not fit the context, so the user message is never pushed out", async () => {
      const steps: Step[] = [{ tool_calls: [call("run", { command: "huge" })] }, { tool_calls: [FINISH] }];
      const model = scripted(steps);
      const { env } = fakeEnv({ huge: "z".repeat(1_000_000) });
      const result = await runLoop(input(model, env, { numCtx: 9000, headroom: 1000 }));
      assert.equal(result.outcome, "finished");
      const tool = model.seen.at(-1)!.find((message) => message.role === "tool")!;
      const max = Math.floor((contextLimit(9000, 1000) * 3) / 4);
      assert.ok(tool.content.length < max + 200);
      assert.match(tool.content, /\[output cut at \d+ characters to fit the context/);
    });

    it("leaves a conversation under the limit untouched", async () => {
      const { model, env } = bulky(5);
      const result = await runLoop(input(model, env));
      assert.ok(model.seen.at(-1)!.filter((message) => message.role === "tool").every((message) => message.content.includes("out-")));
      assert.equal(result.stats.shrinks, 0);
    });

    it("trusts Ollama's prompt token count over the character estimate", async () => {
      const steps: Step[] = Array.from({ length: 10 }, (_, index) => ({ tool_calls: [call("run", { command: `cmd-${index}` })] }));
      steps.push({ tool_calls: [FINISH] });
      const outputs = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`cmd-${index}`, "x".repeat(1500)]));
      const seen: ChatMessage[][] = [];
      let index = 0;
      const model = {
        seen,
        async chat(messages: ChatMessage[]): Promise<ChatResult> {
          seen.push(structuredClone(messages));
          const step = steps[index++]!;
          return { message: { role: "assistant", content: "", tool_calls: step.tool_calls! }, usage: { promptTokens: messages.reduce((sum, message) => sum + message.content.length, 0), outputTokens: 1, durationMs: 1, truncated: false } };
        },
      };
      const result = await runLoop(input(model as ReturnType<typeof scripted>, fakeEnv(outputs).env, { numCtx: 16000, headroom: 1000 }));
      assert.ok(result.stats.shrinks > 0);
      assert.ok(seen.at(-1)!.some((message) => message.content === SHRUNK_OUTPUT));
    });

    it("stops replacing as soon as the estimate fits", async () => {
      const { model, env } = bulky(12);
      await runLoop(input(model, env, { numCtx: 19500, headroom: 1000 }));
      const tools = model.seen.at(-1)!.filter((message) => message.role === "tool");
      const replaced = tools.filter((message) => message.content === SHRUNK_OUTPUT).length;
      assert.ok(replaced > 0 && replaced < 4, `replaced ${replaced}`);
    });
  });
});
