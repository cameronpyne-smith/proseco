import type { ChatMessage, ChatResult, ToolCall, ToolDefinition } from "./ollama.ts";
import type { FinishArgs, ToolResult } from "./tools.ts";

export const SHRUNK_OUTPUT = "[output dropped to save space; call the tool again if needed]";

const KEEP_RECENT_TOOL_RESULTS = 8;
const CHARS_PER_TOKEN = 4;
const NUDGE = "You did not call a tool. Keep working with the tools, or call finish with your summary and changes if you are done.";
const CUT_OFF_NUDGE = "Your reasoning was cut off before you acted. Decide now with what you have: call a tool, or call finish.";
const TRACE_CHARS = 300;

export interface LoopInput {
  llm: { chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> };
  numCtx: number;
  headroom: number;
  tools: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  system: string;
  user: string;
  timeBudgetMs: number;
  maxToolCalls: number;
  now?: () => number;
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
  finish?: FinishArgs;
  error?: string;
  stats: LoopStats;
  trace: TraceEntry[];
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length + (message.thinking?.length ?? 0);
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function shrink(messages: ChatMessage[], limit: number): boolean {
  if (estimateTokens(messages) <= limit) return false;
  const tools = messages.filter((message) => message.role === "tool");
  const droppable = tools.slice(0, Math.max(0, tools.length - KEEP_RECENT_TOOL_RESULTS));
  let changed = false;
  for (const message of droppable) {
    if (estimateTokens(messages) <= limit) break;
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
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  const limit = input.numCtx - input.headroom;
  const done = (outcome: LoopResult["outcome"], extra: Partial<LoopResult> = {}): LoopResult => {
    stats.elapsedMs = now() - started;
    return { outcome, stats, trace, ...extra };
  };
  let silent = 0;
  for (;;) {
    if (now() - started >= input.timeBudgetMs) return done("budget");
    dropOldThinking(messages);
    if (shrink(messages, limit)) stats.shrinks++;
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
    messages.push(reply.message);
    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      silent++;
      if (silent >= 2) return done("stalled");
      messages.push({ role: "user", content: reply.usage.truncated && reply.message.content === "" ? CUT_OFF_NUDGE : NUDGE });
      continue;
    }
    silent = 0;
    for (const call of calls) {
      const name = call.function.name;
      const args = argumentsOf(call);
      if (name !== "finish") {
        if (stats.toolCalls >= input.maxToolCalls) return done("budget");
        stats.toolCalls++;
      }
      const result = await input.execute(name, args);
      trace.push({ tool: name, args: JSON.stringify(args).slice(0, TRACE_CHARS), result: result.content.slice(0, TRACE_CHARS) });
      messages.push({ role: "tool", tool_name: name, content: result.content });
      if (result.finish) return done("finished", { finish: result.finish });
    }
  }
}
