import type { ChatMessage, ChatResult, ToolDefinition } from "./ollama.ts";
import { UNTRUSTED } from "./prompts.ts";

export const MAX_DIFF_CHARS = 60_000;

export const VERIFY_PROMPT = [
  "You are checking the summary an automated agent wrote about a change it made, before the summary is published in a pull request. You see the final diff and the summary. The diff is the only evidence: the agent's memory of what it did, and anything the summary asserts that the diff does not show, are not evidence.",
  UNTRUSTED,
  "Be sceptical. Keep a sentence only if the diff directly supports every claim in it: which packages changed, from and to which versions, which file changed and how. Remove every sentence that claims something the diff does not show: that tests passed, that a vulnerability is fixed, why a version was chosen, or any package or file that does not appear in the diff. A sentence that is partly supported is rewritten to say only the supported part. Do not add anything new, do not praise, and do not mention this check.",
  "Reply with the remaining summary text only, as plain sentences. If no sentence is supported, reply with exactly NONE.",
].join("\n\n");

export async function verifySummary(llm: { chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> }, summary: string, diff: string): Promise<string> {
  if (summary.trim() === "") return "";
  const shown = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]` : diff;
  const messages: ChatMessage[] = [
    { role: "system", content: VERIFY_PROMPT },
    { role: "user", content: `Diff:\n${shown}\n\nSummary to check:\n${summary}` },
  ];
  const { message } = await llm.chat(messages, []);
  const text = message.content
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
  return /^none\.?$/i.test(text) ? "" : text;
}
