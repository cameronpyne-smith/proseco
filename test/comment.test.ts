import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TicketComment } from "../src/core/types.ts";
import { appendToComment, editStatus, mergeIntoComment, mergeUnitLines, renderComment, statusLine, upsertComment, withPulls, withStatus, WORKING, type CommentWriter, type UnitReport } from "../src/fixer/comment.ts";

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
    const body = renderComment("abc123", REPORTS, "**Status**");
    assert.equal(body.split("\n")[0], "<!-- proseco:attempt abc123 -->");
    assert.match(body, /- `package-lock\.json`: ready for review: https:\/\/github\.com\/acme-org\/acme-api\/pull\/7/);
    assert.match(body, /- `web\/package-lock\.json`: draft: https:\/\/github\.com\/acme-org\/acme-api\/pull\/8/);
    assert.match(body, /- `uv\.lock`: no pull request: unsupported ecosystem: uv/);
    assert.match(body, /major upgrades are not attempted yet/);
  });

  it("says so when there was nothing to attempt", () => {
    assert.match(renderComment("h", [], "**Status**"), /nothing to attempt/i);
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

describe("merging a redo into the ticket comment", () => {
  const existing = `${renderComment("h", REPORTS, "**Status**")}- Not announced in Teams: \`timeout\`\n`;
  const redone: UnitReport = { label: "`web/package-lock.json`", outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/8", draft: false } };

  it("replaces only the redone unit's line and keeps the rest, including later notes", () => {
    const merged = mergeUnitLines(existing, [redone])!;
    assert.equal(merged, existing.replace("- `web/package-lock.json`: draft: https", "- `web/package-lock.json`: ready for review: https"));
    assert.notEqual(merged, existing);
  });

  it("adds a unit that had no line after the last unit line", () => {
    const added: UnitReport = { label: "`api/package-lock.json`", outcome: { kind: "none", reason: "already fixed on the default branch" } };
    const lines = mergeUnitLines(existing, [added])!.trimEnd().split("\n");
    assert.equal(lines.at(-2), "- `api/package-lock.json`: no pull request: already fixed on the default branch");
    assert.equal(lines.at(-1), "- Not announced in Teams: `timeout`");
  });

  it("writes a fresh comment when there is none or it has no unit lines, and edits only on a change", async () => {
    const none = writer([]);
    await mergeIntoComment(none, 12, "acme-proseco", [redone], "fresh", "**Status**");
    assert.deepEqual(none.created, ["fresh"]);
    const empty = writer([comment(3, "acme-proseco[bot]", renderComment("h", [], "**Status**"))]);
    await mergeIntoComment(empty, 12, "acme-proseco", [redone], "fresh", "**Status**");
    assert.deepEqual(empty.edited, [[3, "fresh"]]);
    const same = writer([comment(3, "acme-proseco[bot]", existing)]);
    await mergeIntoComment(same, 12, "acme-proseco", [REPORTS[1]!], "fresh", "**Status**");
    assert.deepEqual([same.created, same.edited], [[], []]);
    const changed = writer([comment(3, "acme-proseco[bot]", existing)]);
    await mergeIntoComment(changed, 12, "acme-proseco", [redone], "fresh", "**Status**");
    assert.deepEqual(changed.edited, [[3, mergeUnitLines(existing, [redone])]]);
  });
});

describe("ticket comment status", () => {
  const PR7 = "https://github.com/acme-org/acme-api/pull/7";
  const PR8 = "https://github.com/acme-org/acme-api/pull/8";

  it("waits while any pull request is open, is done once none is open and one merged, and otherwise points at the reasons", () => {
    assert.match(statusLine([{ url: PR7, state: "merged", draft: false }, { url: PR8, state: "open", draft: true }]), /^\*\*Waiting for review:\*\*/);
    assert.match(statusLine([{ url: PR7, state: "merged", draft: false }, { url: PR8, state: "closed", draft: false }]), /^\*\*Done on proseco's side:\*\* nothing is left open\. This ticket closes when the scanner no longer sees its alerts\.$/);
    assert.match(statusLine([{ url: PR8, state: "closed", draft: false }]), /^\*\*No pull request open:\*\*/);
    assert.match(statusLine([]), /^\*\*No pull request open:\*\*/);
  });

  it("puts the status on the line after the marker, replacing the old header or status", () => {
    const body = renderComment("h", REPORTS, "**Waiting**");
    assert.deepEqual(body.split("\n").slice(0, 4), ["<!-- proseco:attempt h -->", "", "**Waiting**", ""]);
    assert.equal(withStatus(body, WORKING), body.replace("**Waiting**", WORKING));
    assert.equal(withStatus("<!-- proseco:attempt h -->\n\nproseco attempted this ticket:\n\n- `a`: draft: x\n", "**Done**"), "<!-- proseco:attempt h -->\n\n**Done**\n\n- `a`: draft: x\n");
    assert.equal(withStatus("<!-- proseco:attempt h -->", "**Done**"), "<!-- proseco:attempt h -->\n\n**Done**\n");
  });

  it("rewrites each pull request's line to its current state and leaves other lines alone", () => {
    const body = `${renderComment("h", REPORTS, "**Waiting**")}- Not announced in Teams: \`timeout\`\n`;
    const next = withPulls(body, [{ url: PR7, state: "merged", draft: false }, { url: PR8, state: "closed", draft: true }]);
    assert.equal(next, body.replace(`ready for review: ${PR7}`, `merged: ${PR7}`).replace(`draft: ${PR8}`, `closed without merging: ${PR8}`));
    assert.equal(withPulls(next, [{ url: PR7, state: "open", draft: true }]), next.replace(`merged: ${PR7}`, `draft: ${PR7}`));
  });

  it("edits the bot's comment only on a change, and creates one only when given a fresh body", async () => {
    const existing = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt h -->\n\n**Waiting**\n")]);
    await editStatus(existing, 5, "acme-proseco", (body) => withStatus(body, WORKING), "fresh");
    assert.deepEqual([existing.edited, existing.created], [[[3, `<!-- proseco:attempt h -->\n\n${WORKING}\n`]], []]);
    const same = writer([comment(3, "acme-proseco[bot]", "<!-- proseco:attempt h -->\n\n**Waiting**\n")]);
    await editStatus(same, 5, "acme-proseco", (body) => withStatus(body, "**Waiting**"), "fresh");
    assert.deepEqual(same.edited, []);
    const none = writer([]);
    await editStatus(none, 5, "acme-proseco", (body) => body, null);
    await editStatus(none, 5, "acme-proseco", (body) => body, "fresh");
    assert.deepEqual(none.created, ["fresh"]);
  });

  it("sets the status when merging a redo into the comment", async () => {
    const redone: UnitReport = { label: "`web/package-lock.json`", outcome: { kind: "pr", url: PR8, draft: false } };
    const api = writer([comment(3, "acme-proseco[bot]", renderComment("h", REPORTS, WORKING))]);
    await mergeIntoComment(api, 12, "acme-proseco", [redone], "fresh", "**Waiting**");
    assert.equal(api.edited[0]![1].split("\n")[2], "**Waiting**");
    assert.match(api.edited[0]![1], /`web\/package-lock\.json`: ready for review/);
  });
});
