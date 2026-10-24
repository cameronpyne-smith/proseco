export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type Think = boolean | "low" | "medium" | "high";

export interface OllamaOptions {
  url: string;
  model: string;
  numCtx: number;
  numPredict: number;
  think: Think;
  timeoutMs: number;
  temperature?: number;
  keepAlive?: string;
}

export interface Usage {
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
  truncated: boolean;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
}

interface ChatResponse {
  message?: ChatMessage;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

const DEFAULT_TEMPERATURE = 0.6;
const DEFAULT_KEEP_ALIVE = "15m";
const MAX_ERROR_BODY = 300;

export class OllamaClient {
  readonly options: OllamaOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options;
    this.#fetch = fetchImpl;
  }

  withThink(think: Think): OllamaClient {
    return new OllamaClient({ ...this.options, think }, this.#fetch);
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], format?: Record<string, unknown>): Promise<ChatResult> {
    const { model, url, timeoutMs } = this.options;
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      think: this.options.think,
      keep_alive: this.options.keepAlive ?? DEFAULT_KEEP_ALIVE,
      options: { num_ctx: this.options.numCtx, num_predict: this.options.numPredict, temperature: this.options.temperature ?? DEFAULT_TEMPERATURE },
    };
    if (tools.length > 0) body["tools"] = tools;
    if (format) body["format"] = format;
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000} s` : (error as Error).message;
      throw new Error(`ollama model ${model} at ${url}: ${reason}`);
    }
    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(text) as ChatResponse;
    } catch {
      throw new Error(`ollama model ${model}: ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`);
    }
    if (parsed.error) throw new Error(`ollama model ${model}: ${parsed.error}`);
    if (!response.ok || !parsed.message) throw new Error(`ollama model ${model}: ${response.status} ${text.slice(0, MAX_ERROR_BODY)}`);
    return {
      message: parsed.message,
      usage: {
        promptTokens: parsed.prompt_eval_count ?? 0,
        outputTokens: parsed.eval_count ?? 0,
        durationMs: Math.round((parsed.total_duration ?? 0) / 1e6),
        truncated: parsed.done_reason === "length",
      },
    };
  }
}
