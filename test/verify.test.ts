import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ChatResult } from "../src/fixer/agent/ollama.ts";
import { MAX_DIFF_CHARS, VERIFY_PROMPT, verifySummary, type DiffFile } from "../src/fixer/agent/verify.ts";

function llm(reply: string, seen: { messages: ChatMessage[]; tools: unknown[] }[] = []) {
  return {
    async chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatResult> {
      seen.push({ messages, tools });
      return { message: { role: "assistant", content: reply }, usage: { promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false } };
    },
  };
}

describe("summary verification", () => {
  it("shows the model the diff and the summary, with no tools, under a sceptical prompt", async () => {
    const seen: { messages: ChatMessage[]; tools: unknown[] }[] = [];
    await verifySummary(llm("kept", seen), "Bumped minimist. Also fixed lodash.", "diff --git a/package.json");
    assert.deepEqual(seen[0]!.tools, []);
    assert.deepEqual(seen[0]!.messages[0], { role: "system", content: VERIFY_PROMPT });
    const user = seen[0]!.messages[1]!.content;
    assert.ok(user.includes("diff --git a/package.json"));
    assert.ok(user.includes("Bumped minimist. Also fixed lodash."));
    assert.match(VERIFY_PROMPT, /diff is the only evidence/i);
    assert.match(VERIFY_PROMPT, /remove every sentence/i);
    assert.match(VERIFY_PROMPT, /NONE/);
  });

  it("returns what the model kept, trimmed and unfenced", async () => {
    assert.equal(await verifySummary(llm("  Bumped minimist to 1.2.8.\n"), "s", "d"), "Bumped minimist to 1.2.8.");
    assert.equal(await verifySummary(llm("```\nBumped minimist.\n```"), "s", "d"), "Bumped minimist.");
  });

  it("returns an empty summary when the model says nothing is supported", async () => {
    assert.equal(await verifySummary(llm("NONE"), "s", "d"), "");
    assert.equal(await verifySummary(llm("none."), "s", "d"), "");
    assert.equal(await verifySummary(llm(""), "s", "d"), "");
  });

  it("does not call the model for an empty summary", async () => {
    const seen: { messages: ChatMessage[]; tools: unknown[] }[] = [];
    assert.equal(await verifySummary(llm("x", seen), "  ", "d"), "");
    assert.equal(seen.length, 0);
  });

  it("truncates a huge diff and says so", async () => {
    const seen: { messages: ChatMessage[]; tools: unknown[] }[] = [];
    await verifySummary(llm("kept", seen), "s", "x".repeat(MAX_DIFF_CHARS + 5000));
    const user = seen[0]!.messages[1]!.content;
    assert.ok(user.length < MAX_DIFF_CHARS + 2000);
    assert.match(user, /diff truncated at/);
  });

  it("puts the diff before the summary so a long diff cannot push the summary out", async () => {
    const seen: { messages: ChatMessage[]; tools: unknown[] }[] = [];
    await verifySummary(llm("kept", seen), "THE-SUMMARY", "THE-DIFF");
    const user = seen[0]!.messages[1]!.content;
    assert.ok(user.indexOf("THE-DIFF") < user.indexOf("THE-SUMMARY"));
  });

  it("allows a diff of up to 120,000 characters", () => {
    assert.equal(MAX_DIFF_CHARS, 120_000);
  });

  describe("a diff made of files", () => {
    const file = (path: string, size: number, manifest = false): DiffFile => ({ path, text: `diff ${path}\n${"x".repeat(size)}`, manifest });

    async function shown(files: DiffFile[]): Promise<string> {
      const seen: { messages: ChatMessage[]; tools: unknown[] }[] = [];
      await verifySummary(llm("kept", seen), "s", files);
      return seen[0]!.messages[1]!.content;
    }

    it("shows everything, in the order given, when it fits, with no truncation notice", async () => {
      const user = await shown([file("package.json", 10, true), file("src/a.js", 10)]);
      assert.ok(user.indexOf("diff package.json") < user.indexOf("diff src/a.js"));
      assert.ok(!/truncated/i.test(user));
    });

    it("shows manifest and lockfile hunks first, then code hunks until the cap, and says the diff is truncated", async () => {
      const user = await shown([file("src/a.js", 50_000), file("package-lock.json", 40_000, true), file("src/b.js", 50_000), file("package.json", 100, true), file("src/c.js", 50_000)]);
      assert.ok(user.indexOf("diff package-lock.json") < user.indexOf("diff src/a.js"));
      assert.ok(user.indexOf("diff package.json") < user.indexOf("diff src/a.js"));
      assert.ok(user.includes("diff src/a.js"));
      assert.ok(!user.includes("diff src/c.js"));
      assert.match(user, /diff is truncated/i);
      assert.match(user, /not shown[^]*src\/c\.js/);
      assert.ok(user.length < MAX_DIFF_CHARS + 2000);
    });

    it("keeps a manifest and lockfile hunk even when it alone exceeds the cap, cut at the cap", async () => {
      const user = await shown([file("package-lock.json", MAX_DIFF_CHARS + 5000, true), file("src/a.js", 10)]);
      assert.ok(user.includes("diff package-lock.json"));
      assert.ok(!user.includes("diff src/a.js"));
      assert.ok(user.length < MAX_DIFF_CHARS + 2000);
    });
  });
});
