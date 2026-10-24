import type { ChatMessage, ChatResult, ToolDefinition } from "./ollama.ts";
import { UNTRUSTED } from "./prompts.ts";

export const MAX_DIFF_CHARS = 120_000;

export interface DiffFile {
  path: string;
  text: string;
  manifest: boolean;
}

export const VERIFY_PROMPT = [
  "You are checking the summary an automated agent wrote about a change it made, before the summary is published in a pull request. You see the final diff and the summary. The diff is the only evidence: the agent's memory of what it did, and anything the summary asserts that the diff does not show, are not evidence.",
  UNTRUSTED,
  "Be sceptical. Keep a sentence only if the diff directly supports every claim in it: which packages changed, from and to which versions, which file changed and how. Remove every sentence that claims something the diff does not show: that tests passed, that a vulnerability is fixed, why a version was chosen, or any package or file that does not appear in the diff. A sentence that is partly supported is rewritten to say only the supported part. Do not add anything new, do not praise, and do not mention this check.",
  "Reply with the remaining summary text only, as plain sentences. Reply NONE only when not a single claim in the summary is supported by the diff; a summary that states the version bump the diff shows is supported.",
].join("\n\n");

function fitDiff(files: DiffFile[]): { text: string; notice: string | null } {
  const ordered = [...files.filter((file) => file.manifest), ...files.filter((file) => !file.manifest)];
  const parts: string[] = [];
  const notShown: string[] = [];
  const cut: string[] = [];
  let remaining = MAX_DIFF_CHARS;
  for (const file of ordered) {
    if (remaining <= 0) notShown.push(file.path);
    else if (file.text.length <= remaining) {
      parts.push(file.text);
      remaining -= file.text.length + 1;
    } else {
      parts.push(file.text.slice(0, remaining));
      cut.push(file.path);
      remaining = 0;
    }
  }
  const text = parts.join("\n");
  if (notShown.length === 0 && cut.length === 0) return { text, notice: null };
  const details = [cut.length > 0 ? `cut short: ${cut.join(", ")}` : null, notShown.length > 0 ? `not shown: ${notShown.join(", ")}` : null].filter(Boolean).join("; ");
  return { text, notice: `The diff is truncated at ${MAX_DIFF_CHARS} characters. Manifest and lockfile hunks come first, then code hunks until the limit (${details}). The file names listed here are not evidence of any change.` };
}

export async function verifySummary(llm: { chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> }, summary: string, diff: string | DiffFile[]): Promise<string> {
  if (summary.trim() === "") return "";
  const fitted =
    typeof diff === "string"
      ? { text: diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]` : diff, notice: null }
      : fitDiff(diff);
  const messages: ChatMessage[] = [
    { role: "system", content: VERIFY_PROMPT },
    { role: "user", content: `${fitted.notice ? `${fitted.notice}\n\n` : ""}Diff:\n${fitted.text}\n\nSummary to check:\n${summary}` },
  ];
  const { message } = await llm.chat(messages, []);
  const text = message.content
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
  return /^none\.?$/i.test(text) ? "" : text;
}
