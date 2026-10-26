import type { ChatMessage, ChatResult, ToolCall, ToolDefinition } from "./ollama.ts";
import type { FinishArgs, ToolResult } from "./tools.ts";

export const SHRUNK_OUTPUT = "[output dropped to save space; call the tool again if needed]";

const KEEP_RECENT_TOOL_RESULTS = 8;
const CHARS_PER_TOKEN = 3;
const CONTEXT_SHARE = 0.8;
const NUDGE = "You did not call a tool. Keep working with the tools, or call finish with your summary and changes if you are done.";
const CUT_OFF_NUDGE = "Your reasoning was cut off before you acted. Decide now with what you have: call a tool, or call finish.";
const FINALISE = "Stop working now. Produce the finish arguments as a JSON object: summary, stating only what you changed and verified and what is still unresolved, and changes, every package version change you made. No tool calls, no prose.";
const NOT_JSON = "That was not a valid finish object. Output only the JSON object.";
const TRACE_CHARS = 300;
const RESULT_SHARE = 4;
const MAX_GATE_CALLS = 3;
const REPEAT_WINDOW = 10;
const REPEAT_LIMIT = 3;
const REPEAT_STALL_ROUNDS = 3;
const MUTATING = new Set(["write_file", "edit_file"]);

type Chat = { chat(messages: ChatMessage[], tools: ToolDefinition[], format?: Record<string, unknown>): Promise<ChatResult> };

export interface LoopInput {
  llm: Chat;
  finaliseWith?: Chat[];
  numCtx: number;
  headroom: number;
  tools: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  system: string;
  user: string;
  timeBudgetMs: number;
  maxToolCalls: number;
  gate?(): Promise<string | null>;
  now?: () => number;
  record?(message: ChatMessage): void;
}

export interface LoopStats {
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  outputTokens: number;
  modelMs: number;
  elapsedMs: number;
  shrinks: number;
}

export interface TraceEntry {
  tool: string;
  args: string;
  result: string;
}

export interface LoopResult {
  outcome: "finished" | "budget" | "stalled" | "error";
  forced?: "budget" | "stalled";
  finish?: FinishArgs;
  error?: string;
  stats: LoopStats;
  trace: TraceEntry[];
}

export function repeatNotice(times: number): string {
  return `You already ran this exact call ${times} times with the same result, so it was not run again. Change your approach, or call finish if you cannot make further progress.`;
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length + (message.thinking?.length ?? 0);
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function contextLimit(numCtx: number, headroom: number): number {
  return Math.min(numCtx - headroom, Math.floor(numCtx * CONTEXT_SHARE));
}

export function capResult(content: string, limit: number): string {
  const max = Math.floor((limit * CHARS_PER_TOKEN) / RESULT_SHARE);
  return content.length <= max ? content : `${content.slice(0, max)}\n[output cut at ${max} characters to fit the context; narrow the request]`;
}

function shrink(messages: ChatMessage[], limit: number, scale: number, keep = KEEP_RECENT_TOOL_RESULTS): boolean {
  const used = () => estimateTokens(messages) * scale;
  if (used() <= limit) return false;
  const tools = messages.filter((message) => message.role === "tool");
  const droppable = tools.slice(0, Math.max(0, tools.length - keep));
  let changed = false;
  for (const message of droppable) {
    if (used() <= limit) break;
    if (message.content === SHRUNK_OUTPUT) continue;
    message.content = SHRUNK_OUTPUT;
    changed = true;
  }
  return changed;
}

function dropOldThinking(messages: ChatMessage[]): void {
  let newest = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant") newest = index;
  });
  messages.forEach((message, index) => {
    if (message.role === "assistant" && index !== newest) delete message.thinking;
  });
}

function extractJson(text: string): Record<string, unknown> | null {
  const body = text.replace(/^[\s\S]*<\/think>/, "").replace(/```(?:json)?/g, "").trim();
  const start = body.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, body.lastIndexOf("}") + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function argumentsOf(call: ToolCall): Record<string, unknown> {
  const raw: unknown = call.function.arguments;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const stats: LoopStats = { rounds: 0, toolCalls: 0, promptTokens: 0, outputTokens: 0, modelMs: 0, elapsedMs: 0, shrinks: 0 };
  const trace: TraceEntry[] = [];
  const messages: ChatMessage[] = [];
  const append = (message: ChatMessage) => {
    messages.push(message);
    input.record?.(structuredClone(message));
  };
  append({ role: "system", content: input.system });
  append({ role: "user", content: input.user });
  const limit = contextLimit(input.numCtx, input.headroom);
  let scale = 1;
  const done = (outcome: LoopResult["outcome"], extra: Partial<LoopResult> = {}): LoopResult => {
    stats.elapsedMs = now() - started;
    return { outcome, stats, trace, ...extra };
  };
  const finalise = async (reason: "budget" | "stalled"): Promise<LoopResult> => {
    const finish = input.tools.find((tool) => tool.function.name === "finish");
    if (!finish || !input.finaliseWith?.length) return done(reason);
    dropOldThinking(messages);
    for (const message of messages) if (message.role === "assistant") delete message.thinking;
    shrink(messages, limit, scale, 2);
    append({ role: "user", content: FINALISE });
    for (const client of input.finaliseWith) {
      let reply: ChatResult;
      try {
        reply = await client.chat(messages, [], finish.function.parameters);
      } catch (error) {
        return done(reason, { error: (error as Error).message });
      }
      stats.rounds++;
      stats.outputTokens += reply.usage.outputTokens;
      stats.modelMs += reply.usage.durationMs;
      input.record?.(structuredClone(reply.message));
      const args = extractJson(reply.message.content);
      const result = args ? await input.execute("finish", args) : null;
      if (result?.finish) {
        trace.push({ tool: "finish", args: JSON.stringify(args).slice(0, TRACE_CHARS), result: result.content.slice(0, TRACE_CHARS) });
        return done("finished", { forced: reason, finish: result.finish });
      }
      messages.push({ role: "assistant", content: reply.message.content });
      append({ role: "user", content: result ? `${result.content}. ${NOT_JSON}` : NOT_JSON });
    }
    return done(reason);
  };
  let silent = 0;
  let repeated = 0;
  let gateCalls = 0;
  const history: { key: string; result: string }[] = [];
  for (;;) {
    if (now() - started >= input.timeBudgetMs) return finalise("budget");
    dropOldThinking(messages);
    if (shrink(messages, limit, scale)) stats.shrinks++;
    const sent = estimateTokens(messages);
    let reply: ChatResult;
    try {
      reply = await input.llm.chat(messages, input.tools);
    } catch (error) {
      return done("error", { error: (error as Error).message });
    }
    stats.rounds++;
    stats.promptTokens = Math.max(stats.promptTokens, reply.usage.promptTokens);
    stats.outputTokens += reply.usage.outputTokens;
    stats.modelMs += reply.usage.durationMs;
    if (sent > 0 && reply.usage.promptTokens > 0) scale = Math.max(1, reply.usage.promptTokens / sent);
    const calls = reply.message.tool_calls ?? [];
    const cutOff = reply.usage.truncated && reply.message.content === "" && calls.length === 0;
    input.record?.(structuredClone(reply.message));
    if (cutOff) delete reply.message.thinking;
    messages.push(reply.message);
    if (calls.length === 0) {
      silent++;
      if (silent >= 2) return finalise("stalled");
      append({ role: "user", content: cutOff ? CUT_OFF_NUDGE : NUDGE });
      continue;
    }
    silent = 0;
    let executed = 0;
    for (const call of calls) {
      const name = call.function.name;
      const args = argumentsOf(call);
      if (name !== "finish") {
        if (stats.toolCalls >= input.maxToolCalls) return finalise("budget");
        stats.toolCalls++;
        const key = `${name}\n${JSON.stringify(args)}`;
        const same = history.slice(-REPEAT_WINDOW).filter((entry) => entry.key === key);
        const last = same.at(-1);
        const times = last ? same.filter((entry) => entry.result === last.result).length : 0;
        if (times >= REPEAT_LIMIT - 1) {
          const notice = repeatNotice(times);
          trace.push({ tool: name, args: JSON.stringify(args).slice(0, TRACE_CHARS), result: notice });
          append({ role: "tool", tool_name: name, content: notice });
          continue;
        }
      }
      executed++;
      const result = await input.execute(name, args);
      if (name !== "finish") {
        if (MUTATING.has(name)) history.length = 0;
        else history.push({ key: `${name}\n${JSON.stringify(args)}`, result: result.content });
      }
      trace.push({ tool: name, args: JSON.stringify(args).slice(0, TRACE_CHARS), result: result.content.slice(0, TRACE_CHARS) });
      if (result.finish && input.gate && gateCalls < MAX_GATE_CALLS && now() - started < input.timeBudgetMs && stats.toolCalls < input.maxToolCalls) {
        gateCalls++;
        const review = await input.gate();
        if (review) {
          append({ role: "tool", tool_name: name, content: capResult(review, limit) });
          continue;
        }
      }
      append({ role: "tool", tool_name: name, content: capResult(result.content, limit) });
      if (result.finish) return done("finished", { finish: result.finish });
    }
    repeated = executed === 0 ? repeated + 1 : 0;
    if (repeated >= REPEAT_STALL_ROUNDS) return finalise("stalled");
  }
}
