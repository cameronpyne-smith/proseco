import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bodyHash, decide, emptyState, feedbackRounds, forgetClosedTickets, isIgnored, lastAttempt, lastCommentId, loadState, pendingAnnouncement, recordAttempt, recordComment, recordFeedback, recordShown, shownInComment, recordIgnored, saveState, withAnnouncement, withoutPulls, withPull, pullState, type Attempt, type PendingAnnouncement } from "../src/fixer/state.ts";

const BODY = "<!-- proseco:acme-api -->\n\nrows";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    bodyHash: bodyHash(BODY),
    headSha: "a".repeat(40),
    attemptedAt: "2026-10-01T10:00:00.000Z",
    outcome: "pr-opened",
    prUrls: ["https://github.com/acme-org/acme-api/pull/7"],
    ...overrides,
  };
}

const PR = "https://github.com/acme-org/acme-api/pull/7";

describe("body hash", () => {
  it("is the sha256 of the body", () => {
    assert.equal(bodyHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("state decisions", () => {
  const now = bodyHash(BODY);
  const changed = bodyHash(`${BODY} changed`);

  it("attempts a ticket that was never attempted", () => {
    assert.deepEqual(decide(undefined, { bodyHash: now, force: false, prs: [] }), { attempt: true, reason: "never attempted" });
  });

  it("skips while an open proseco PR exists for the ticket, even when the body changed", () => {
    const decision = decide(attempt(), { bodyHash: changed, force: false, prs: [{ url: PR, state: "open" }] });
    assert.equal(decision.attempt, false);
    assert.match(decision.reason, /open pull request/);
  });

  it("skips a ticket whose body is the one already attempted and where the fixer gave up", () => {
    const decision = decide(attempt({ outcome: "gave-up", prUrls: [] }), { bodyHash: now, force: false, prs: [] });
    assert.equal(decision.attempt, false);
    assert.match(decision.reason, /already attempted.*gave-up/);
  });

  it("attempts again when the body changed after the fixer gave up", () => {
    const decision = decide(attempt({ outcome: "gave-up", prUrls: [] }), { bodyHash: changed, force: false, prs: [] });
    assert.deepEqual(decision, { attempt: true, reason: "body changed since the last attempt" });
  });

  it("attempts again when the body changed after the PR was merged", () => {
    const decision = decide(attempt(), { bodyHash: changed, force: false, prs: [{ url: PR, state: "merged" }] });
    assert.equal(decision.attempt, true);
  });

  it("skips a merged PR's ticket while the body is unchanged", () => {
    const decision = decide(attempt(), { bodyHash: now, force: false, prs: [{ url: PR, state: "merged" }] });
    assert.equal(decision.attempt, false);
  });

  it("does not retry a PR closed without merging, even when the body changed", () => {
    const decision = decide(attempt(), { bodyHash: changed, force: false, prs: [{ url: PR, state: "closed" }] });
    assert.equal(decision.attempt, false);
    assert.match(decision.reason, /closed without merging.*fix command/);
  });

  it("lets a comment command override every skip, including an open PR", () => {
    for (const prs of [[{ url: PR, state: "open" as const }], [{ url: PR, state: "closed" as const }], []]) {
      const decision = decide(attempt(), { bodyHash: now, force: true, prs });
      assert.deepEqual(decision, { attempt: true, reason: "a comment command forces a new attempt" });
    }
  });
});

describe("ignored tickets", () => {
  it("skips an ignored ticket before any other rule", () => {
    const query = { bodyHash: "h", force: false, prs: [], ignored: true };
    assert.deepEqual(decide(undefined, query), { attempt: false, reason: "ignored by a comment command" });
    assert.deepEqual(decide(attempt(), { ...query, prs: [{ url: PR, state: "open" }] }), { attempt: false, reason: "ignored by a comment command" });
  });

  it("records and clears the flag beside the attempt and comment", () => {
    const state = recordIgnored(recordComment(recordAttempt(emptyState(), 12, attempt()), 12, 5), 12, true);
    assert.equal(isIgnored(state, 12), true);
    assert.equal(isIgnored(state, 13), false);
    assert.equal(lastCommentId(state, 12), 5);
    assert.deepEqual(lastAttempt(state, 12), attempt());
    assert.equal(isIgnored(recordIgnored(state, 12, false), 12), false);
  });

  it("round-trips through the file, and reads a file written before the flag existed as not ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-state-"));
    const file = join(dir, "state.json");
    saveState(file, recordIgnored(emptyState(), 3, true));
    assert.equal(isIgnored(loadState(file), 3), true);
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "3": { attempt: null, lastCommentId: 4 } } }));
    assert.equal(isIgnored(loadState(file), 3), false);
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "3": { attempt: null, lastCommentId: 4, ignored: "yes" } } }));
    assert.throws(() => loadState(file), /malformed ignored/);
  });
});

describe("state file", () => {
  it("records an attempt without changing the earlier state", () => {
    const before = emptyState();
    const after = recordAttempt(before, 12, attempt());
    assert.deepEqual(before, emptyState());
    assert.deepEqual(lastAttempt(after, 12), attempt());
    assert.equal(lastAttempt(after, 99), undefined);
  });

  it("records the last seen comment beside the attempt without losing either", () => {
    const withAttempt = recordAttempt(emptyState(), 12, attempt());
    const both = recordComment(withAttempt, 12, 555);
    assert.equal(lastCommentId(both, 12), 555);
    assert.deepEqual(lastAttempt(both, 12), attempt());
    assert.equal(lastCommentId(both, 13), null);
    const reversed = recordAttempt(recordComment(emptyState(), 12, 555), 12, attempt());
    assert.deepEqual(reversed, both);
    assert.equal(lastCommentId(withAttempt, 12), null);
  });

  it("starts empty when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-state-"));
    assert.deepEqual(loadState(join(dir, "state.json")), emptyState());
  });

  it("round-trips through the file and leaves no temporary file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-state-"));
    const file = join(dir, "state.json");
    const state = recordAttempt(emptyState(), 12, attempt());
    saveState(file, state);
    saveState(file, recordAttempt(state, 13, attempt({ outcome: "gave-up", prUrls: [] })));
    const loaded = loadState(file);
    assert.deepEqual(Object.keys(loaded.tickets), ["12", "13"]);
    assert.deepEqual(readdirSync(dir), ["state.json"]);
  });

  it("creates the directory for the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-state-"));
    const file = join(dir, "nested", "state.json");
    saveState(file, emptyState());
    assert.equal(existsSync(file), true);
  });

  it("refuses a file that is not state, naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-state-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ version: 2, tickets: {} }));
    assert.throws(() => loadState(file), /state\.json.*version/);
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "1": { attempt: { bodyHash: 3 }, lastCommentId: null } } }));
    assert.throws(() => loadState(file), /state\.json.*ticket 1/);
    writeFileSync(file, "not json");
    assert.throws(() => loadState(file), /state\.json/);
    assert.equal(readFileSync(file, "utf8"), "not json");
  });
});

describe("pending announcements", () => {
  const pending: PendingAnnouncement = {
    prs: [{ url: PR, facts: { title: "Bump a to 1.0.1", major: false, lockfile: "package-lock.json", packages: [{ name: "a", from: "1.0.0", to: "1.0.1" }] } }],
    queuedAt: "2026-10-01T10:00:00.000Z",
    attempts: 0,
    nextAt: "2026-10-01T10:00:00.000Z",
    lastError: null,
  };

  it("sets and clears an announcement beside the attempt", () => {
    const withBoth = withAnnouncement(recordAttempt(emptyState(), 12, attempt()), 12, pending);
    assert.deepEqual(pendingAnnouncement(withBoth, 12), pending);
    const cleared = withAnnouncement(withBoth, 12, null);
    assert.equal(pendingAnnouncement(cleared, 12), undefined);
    assert.equal("announcement" in cleared.tickets["12"]!, false);
    assert.deepEqual(lastAttempt(cleared, 12), attempt());
  });

  it("round-trips through the file and refuses a malformed one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "proseco-state-")), "state.json");
    saveState(file, withAnnouncement(emptyState(), 12, pending));
    assert.deepEqual(pendingAnnouncement(loadState(file), 12), pending);
    for (const bad of [{ ...pending, prs: [{ ...pending.prs[0], url: 3 }] }, { ...pending, attempts: "1" }, { ...pending, prs: [{ ...pending.prs[0], facts: { title: "t" } }] }, { ...pending, lastError: 3 }]) {
      writeFileSync(file, JSON.stringify({ version: 1, tickets: { "12": { attempt: null, lastCommentId: null, announcement: bad } } }));
      assert.throws(() => loadState(file), /malformed announcement/);
    }
  });
});

describe("forgetting closed tickets", () => {
  it("drops the entries of tickets no longer open, keeps open ones and any with an announcement still to post", () => {
    const pending: PendingAnnouncement = { prs: [], queuedAt: "t", attempts: 0, nextAt: "t", lastError: null };
    const state = withAnnouncement(recordIgnored(recordAttempt(recordAttempt(emptyState(), 12, attempt()), 13, attempt()), 14, true), 15, pending);
    const forgot = forgetClosedTickets(state, new Set([12]));
    assert.deepEqual(forgot.forgotten, [13, 14]);
    assert.deepEqual(Object.keys(forgot.state.tickets), ["12", "15"]);
    assert.deepEqual(lastAttempt(forgot.state, 12), attempt());
    const kept = forgetClosedTickets(forgot.state, new Set([12]));
    assert.equal(kept.state, forgot.state);
  });
});

describe("review feedback", () => {
  it("counts feedback rounds per pull request, keeps them through the file and refuses a malformed record", () => {
    const once = recordFeedback(emptyState(), 12, [PR]);
    assert.deepEqual(feedbackRounds(once, 12), { [PR]: 1 });
    assert.deepEqual(feedbackRounds(recordFeedback(once, 12, [PR, "https://github.com/acme-org/acme-api/pull/8"]), 12), { [PR]: 2, "https://github.com/acme-org/acme-api/pull/8": 1 });
    assert.equal(recordFeedback(once, 12, []), once);
    assert.deepEqual(feedbackRounds(once, 13), {});
    const file = join(mkdtempSync(join(tmpdir(), "proseco-state-")), "state.json");
    saveState(file, once);
    assert.deepEqual(feedbackRounds(loadState(file), 12), { [PR]: 1 });
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "12": { attempt: null, lastCommentId: null, feedback: { [PR]: "1" } } } }));
    assert.throws(() => loadState(file), /malformed feedback record/);
  });

  it("records what the ticket comment shows, clears it with null, and refuses a malformed record", () => {
    const shown = recordShown(emptyState(), 12, `${PR} merged`);
    assert.equal(shownInComment(shown, 12), `${PR} merged`);
    assert.equal(shownInComment(recordShown(shown, 12, null), 12), null);
    assert.equal("shown" in recordShown(shown, 12, null).tickets["12"]!, false);
    const file = join(mkdtempSync(join(tmpdir(), "proseco-state-")), "state.json");
    saveState(file, shown);
    assert.equal(shownInComment(loadState(file), 12), `${PR} merged`);
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "12": { attempt: null, lastCommentId: null, shown: 3 } } }));
    assert.throws(() => loadState(file), /malformed shown record/);
  });
});

describe("pull request records", () => {
  it("keeps a cursor and a refreshed head per pull request, removes them by url, and round-trips through the file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "proseco-state-")), "state.json");
    const state = withPull(withPull(recordAttempt(emptyState(), 12, attempt()), PR, { lastCommentId: 5 }), `${PR}0`, { refreshedHead: "abc" });
    assert.deepEqual(pullState(state, PR), { lastCommentId: 5 });
    assert.deepEqual(pullState(state, "https://github.com/acme-org/acme-api/pull/1"), {});
    assert.deepEqual(lastAttempt(state, 12), attempt());
    saveState(file, state);
    assert.deepEqual(loadState(file), state);
    assert.deepEqual(Object.keys(withoutPulls(state, (url) => url === PR).pulls!), [`${PR}0`]);
    for (const bad of [[], { [PR]: { lastCommentId: "5" } }, { [PR]: { refreshedHead: 3 } }, { [PR]: null }]) {
      writeFileSync(file, JSON.stringify({ version: 1, tickets: {}, pulls: bad }));
      assert.throws(() => loadState(file), /malformed pull requests record/);
    }
  });
});
