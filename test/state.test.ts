import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bodyHash, decide, emptyState, loadState, recordAttempt, saveState, type Attempt } from "../src/fixer/state.ts";

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
    assert.match(decision.reason, /closed without merging.*fix label/);
  });

  it("lets the fix label override every skip, including an open PR", () => {
    for (const prs of [[{ url: PR, state: "open" as const }], [{ url: PR, state: "closed" as const }], []]) {
      const decision = decide(attempt(), { bodyHash: now, force: true, prs });
      assert.deepEqual(decision, { attempt: true, reason: "the fix label forces a new attempt" });
    }
  });
});

describe("state file", () => {
  it("records an attempt without changing the earlier state", () => {
    const before = emptyState();
    const after = recordAttempt(before, 12, attempt());
    assert.deepEqual(before, emptyState());
    assert.deepEqual(after.tickets["12"], attempt());
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
    writeFileSync(file, JSON.stringify({ version: 1, tickets: { "1": { bodyHash: 3 } } }));
    assert.throws(() => loadState(file), /state\.json.*ticket 1/);
    writeFileSync(file, "not json");
    assert.throws(() => loadState(file), /state\.json/);
    assert.equal(readFileSync(file, "utf8"), "not json");
  });
});
