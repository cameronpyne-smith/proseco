import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TicketComment } from "../src/core/types.ts";
import { appendToComment, renderComment, upsertComment, type CommentWriter, type UnitReport } from "../src/fixer/comment.ts";

const REPORTS: UnitReport[] = [
  { label: "`package-lock.json`", outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/7", draft: false } },
  { label: "`web/package-lock.json`", outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/8", draft: true } },
  { label: "`uv.lock`", outcome: { kind: "none", reason: "unsupported ecosystem: uv" } },
  { label: "`package-lock.json` (minimist, major)", outcome: { kind: "none", reason: "major upgrades are not attempted yet" } },
];

function comment(id: number, author: string, body: string): TicketComment {
  return { id, author, authorType: author.endsWith("[bot]") ? "Bot" : "User", body, createdAt: "2026-01-01T00:00:00Z" };
}

function writer(existing: TicketComment[]): CommentWriter & { created: string[]; edited: [number, string][] } {
  const created: string[] = [];
  const edited: [number, string][] = [];
  return {
    created,
    edited,
    comments: async () => existing,
    comment: async (_number, body) => void created.push(body),
    editComment: async (id, body) => void edited.push([id, body]),
  };
}

describe("ticket comment", () => {
  it("starts with the attempt marker and the body hash, then lists each unit's pull request or the reason there is none", () => {
    const body = renderComment("abc123", REPORTS);
    assert.equal(body.split("\n")[0], "<!-- proseco:attempt abc123 -->");
    assert.match(body, /- `package-lock\.json`: ready for review: https:\/\/github\.com\/acme-org\/acme-api\/pull\/7/);
    assert.match(body, /- `web\/package-lock\.json`: draft: https:\/\/github\.com\/acme-org\/acme-api\/pull\/8/);
    assert.match(body, /- `uv\.lock`: no pull request: unsupported ecosystem: uv/);
    assert.match(body, /major upgrades are not attempted yet/);
  });

  it("says so when there was nothing to attempt", () => {
    assert.match(renderComment("h", []), /nothing to attempt/i);
  });

  it("creates the comment when the bot has none", async () => {
    const api = writer([comment(1, "a-person", "<!-- proseco:attempt zzz --> pretend"), comment(2, "acme-proseco[bot]", "unrelated")]);
    assert.equal(await upsertComment(api, 5, "acme-proseco", "<!-- proseco:attempt h -->\nbody"), "created");
    assert.deepEqual(api.created, ["<!-- proseco:attempt h -->\nbody"]);
    assert.deepEqual(api.edited, []);
  });

  it("edits the bot's marked comment in place, whatever hash it carries", async () => {
    const api = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt old -->\nold body"), comment(9, "a-person", "hello")]);
    assert.equal(await upsertComment(api, 5, "acme-proseco", "<!-- proseco:attempt new -->\nnew body"), "edited");
    assert.deepEqual(api.edited, [[3, "<!-- proseco:attempt new -->\nnew body"]]);
    assert.deepEqual(api.created, []);
  });

  it("does not edit a comment that already says the same thing", async () => {
    const api = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt h -->\nbody")]);
    assert.equal(await upsertComment(api, 5, "acme-proseco", "<!-- proseco:attempt h -->\nbody"), "unchanged");
    assert.deepEqual(api.edited, []);
    assert.deepEqual(api.created, []);
  });

  it("ignores a marked comment written by anyone but the bot", async () => {
    const api = writer([comment(3, "someone-else[bot]", "<!-- proseco:attempt old -->\nx"), comment(4, "a-person", "<!-- proseco:attempt old -->\ny")]);
    assert.equal(await upsertComment(api, 5, "acme-proseco", "<!-- proseco:attempt h -->\nb"), "created");
  });

  it("edits the newest when the bot somehow has several", async () => {
    const api = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt a -->"), comment(8, "acme-proseco[bot]", "<!-- proseco:attempt b -->")]);
    await upsertComment(api, 5, "acme-proseco", "<!-- proseco:attempt c -->\nx");
    assert.equal(api.edited[0]![0], 8);
  });

  it("appends a line to the bot's newest marked comment, and writes nothing when there is none", async () => {
    const api = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt a -->\n- one\n"), comment(4, "a-person", "<!-- proseco:attempt b -->")]);
    await appendToComment(api, 5, "acme-proseco", "- Not announced in Teams: `x`");
    assert.deepEqual(api.edited, [[3, "<!-- proseco:attempt a -->\n- one\n- Not announced in Teams: `x`\n"]]);
    const none = writer([comment(4, "a-person", "<!-- proseco:attempt b -->")]);
    await appendToComment(none, 5, "acme-proseco", "- line");
    assert.deepEqual(none.edited, []);
    assert.deepEqual(none.created, []);
  });
});
