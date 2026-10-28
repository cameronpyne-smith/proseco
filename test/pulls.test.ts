import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullInfo, PullReview } from "../src/core/github.ts";
import type { TicketComment } from "../src/core/types.ts";
import { redoReply, scanPulls, ticketOfPull, type PullRedo, type PullSource } from "../src/fixer/pulls.ts";
import type { FixRequest } from "../src/fixer/requests.ts";
import { emptyState, pullState, recordFeedback, withPull, type State } from "../src/fixer/state.ts";

const BOT = "acme-proseco";
const OPTIONS = { org: "acme-org", ticketsRepo: "acme-tickets", bot: BOT, acknowledge: true };

function pull(number: number, overrides: Partial<PullInfo> = {}): PullInfo {
  return {
    number,
    url: `https://github.com/acme-org/acme-api/pull/${number}`,
    state: "open",
    branch: `proseco/branch-${number}`,
    headSha: `head${number}`,
    author: `${BOT}[bot]`,
    body: "Summary\n\nPart of acme-org/acme-tickets#4\n",
    ...overrides,
  };
}

function comment(id: number, body: string, author = "ana"): TicketComment {
  return { id, author, authorType: "User", body, createdAt: "2026-10-01T10:00:00Z" };
}

function request(overrides: Partial<FixRequest> = {}): FixRequest {
  return { number: 4, key: "acme-api", repo: "acme-api", force: false, ignored: false, commentId: null, pulls: [], ...overrides };
}

function verdict(number: number, value: string, author = "acme-reviewer[bot]"): PullReview {
  return { id: number, author, state: "COMMENTED", commitId: `head${number}`, body: `<!-- reviewdo verdict=${value} -->` };
}

function source(pulls: PullInfo[], comments: Record<number, TicketComment[]> = {}, conflicted: number[] = [], reviews: Record<number, PullReview[]> = {}) {
  const log = { reactions: [] as number[], replies: [] as [number, string][], conflictChecks: [] as number[] };
  const api: PullSource = {
    openPulls: async () => pulls,
    conflicted: async (_repo, number) => (log.conflictChecks.push(number), conflicted.includes(number)),
    reviews: async (_repo, number) => reviews[number] ?? [],
    comments: async (_repo, number) => comments[number] ?? [],
    react: async (_repo, id) => void log.reactions.push(id),
    reply: async (_repo, number, body) => void log.replies.push([number, body]),
    canWrite: async (_repo, login) => login !== "mallory",
  };
  return { api, log };
}

async function scan(api: PullSource, state: State = emptyState(), requests = [request()], acknowledge = true, reviewer?: string) {
  return scanPulls(requests, api, state, { ...OPTIONS, acknowledge, ...(reviewer ? { reviewer } : {}) });
}

describe("finding a pull request's ticket", () => {
  it("reads the Part of line for the configured tickets repository only", () => {
    assert.equal(ticketOfPull("x\n\nPart of acme-org/acme-tickets#4321\n", "acme-org", "acme-tickets"), 4321);
    assert.equal(ticketOfPull("Part of acme-org/other#3", "acme-org", "acme-tickets"), null);
    assert.equal(ticketOfPull("see Part of acme-org/acme-tickets#3", "acme-org", "acme-tickets"), null);
  });
});

describe("pull request commands", () => {
  it("turns a fix command on a fixer pull request into a redo with its note, reacts and records the comment", async () => {
    const { api, log } = source([pull(7)], { 7: [comment(30, "@acme-proseco fix keep vite on 6")] });
    const result = await scan(api);
    assert.deepEqual(result.requests[0]!.pulls, [{ url: pull(7).url, number: 7, branch: "proseco/branch-7", headSha: "head7", reason: "command", requester: "ana", note: "keep vite on 6" }]);
    assert.deepEqual(log.reactions, [30]);
    assert.deepEqual(pullState(result.state, pull(7).url), { lastCommentId: 30 });
    const again = await scan(api, result.state);
    assert.deepEqual(again.requests[0]!.pulls, []);
    assert.deepEqual(log.reactions, [30]);
  });

  it("acts on nothing from someone who cannot write, and on no pull request the fixer did not open", async () => {
    const { api, log } = source([pull(7), pull(8, { author: "ana" }), pull(9, { branch: "feature/x" })], {
      7: [comment(30, "@acme-proseco fix", "mallory")],
      8: [comment(31, "@acme-proseco fix")],
      9: [comment(32, "@acme-proseco fix")],
    });
    const result = await scan(api);
    assert.deepEqual(result.requests[0]!.pulls, []);
    assert.deepEqual([log.reactions, log.replies], [[], []]);
  });

  it("answers ignore, a closed ticket and an ignored ticket instead of redoing", async () => {
    const { api, log } = source([pull(7), pull(8, { body: "Part of acme-org/acme-tickets#99" }), pull(9, { body: "no ticket" })], {
      7: [comment(30, "@acme-proseco ignore")],
      8: [comment(31, "@acme-proseco fix")],
      9: [comment(32, "@acme-proseco fix")],
    });
    const result = await scan(api);
    assert.deepEqual(result.requests[0]!.pulls, []);
    assert.deepEqual(log.reactions, [30, 31, 32]);
    assert.deepEqual(log.replies, [
      [7, "`@acme-proseco ignore` works on the ticket, not on a pull request: comment it on acme-org/acme-tickets#4."],
      [8, "acme-org/acme-tickets#99 is closed or is not a proseco ticket, so there is nothing to redo."],
      [9, "This pull request does not name its ticket, so there is nothing to redo."],
    ]);
    const ignored = source([pull(7)], { 7: [comment(30, "@acme-proseco fix")] });
    await scan(ignored.api, emptyState(), [request({ ignored: true })]);
    assert.deepEqual(ignored.log.replies, [[7, "acme-org/acme-tickets#4 is ignored. Comment `@acme-proseco fix` on the ticket to resume it."]]);
  });

  it("leaves alone the pull requests of tickets outside the ones it was limited to", async () => {
    const { api, log } = source([pull(7), pull(8, { body: "Part of acme-org/acme-tickets#5" }), pull(9, { body: "no ticket" })], {
      7: [comment(30, "@acme-proseco fix")],
      8: [comment(31, "@acme-proseco fix")],
      9: [comment(32, "@acme-proseco fix")],
    }, [8]);
    const result = await scanPulls([request()], api, emptyState(), { ...OPTIONS, only: new Set([4]) });
    assert.deepEqual(result.requests[0]!.pulls.map((redo) => redo.number), [7]);
    assert.deepEqual([log.reactions, log.replies, log.conflictChecks], [[30], [], []]);
    assert.deepEqual(Object.keys(result.state.pulls!), [pull(7).url]);
  });

  it("neither reacts, replies nor records when not acknowledging", async () => {
    const { api, log } = source([pull(7), pull(8)], { 7: [comment(30, "@acme-proseco fix")], 8: [comment(31, "@acme-proseco ignore")] }, [7]);
    const result = await scan(api, emptyState(), [request()], false);
    assert.equal(result.requests[0]!.pulls.length, 1);
    assert.deepEqual([log.reactions, log.replies, result.state], [[], [], emptyState()]);
  });
});

describe("conflicted pull requests", () => {
  it("redoes a conflicted pull request once per head, and checks only its own open ones", async () => {
    const { api, log } = source([pull(7), pull(8)], {}, [7]);
    const result = await scan(api);
    assert.deepEqual(result.requests[0]!.pulls.map((redo) => [redo.number, redo.reason]), [[7, "conflict"]]);
    assert.deepEqual(pullState(result.state, pull(7).url), { refreshedHead: "head7" });
    const again = await scan(api, result.state);
    assert.deepEqual(again.requests[0]!.pulls, []);
    const moved = source([pull(7, { headSha: "head7b" })], {}, [7]);
    assert.equal((await scan(moved.api, result.state)).requests[0]!.pulls.length, 1);
    const other = source([pull(7, { body: "Part of acme-org/acme-tickets#99" })], {}, [7]);
    await scan(other.api);
    assert.deepEqual(other.log.conflictChecks, []);
    assert.deepEqual(log.conflictChecks, [7, 8, 8]);
  });

  it("does not also redo for a conflict when a command already asked", async () => {
    const { api } = source([pull(7)], { 7: [comment(30, "@acme-proseco fix")] }, [7]);
    assert.deepEqual((await scan(api)).requests[0]!.pulls.map((redo) => redo.reason), ["command"]);
  });

  it("forgets pull requests of a scanned repository that are no longer open", async () => {
    const closed = "https://github.com/acme-org/acme-api/pull/3";
    const elsewhere = "https://github.com/acme-org/acme-web/pull/3";
    const state = withPull(withPull(emptyState(), closed, { lastCommentId: 1 }), elsewhere, { lastCommentId: 2 });
    const { api } = source([pull(7)]);
    assert.deepEqual(Object.keys((await scan(api, state)).state.pulls!), [elsewhere]);
  });
});

describe("reviewed pull requests", () => {
  it("redoes a pull request whose head the reviewer marked caution or blocked, once per head and before checking for a conflict", async () => {
    const { api, log } = source([pull(7), pull(8), pull(9)], {}, [7], { 7: [verdict(7, "caution")], 8: [verdict(8, "blocked")], 9: [verdict(9, "ready")] });
    const result = await scan(api, emptyState(), [request()], true, "acme-reviewer");
    assert.deepEqual(result.requests[0]!.pulls.map((redo) => [redo.number, redo.reason]), [[7, "review"], [8, "review"]]);
    assert.deepEqual(pullState(result.state, pull(7).url), { refreshedHead: "head7" });
    assert.deepEqual(log.conflictChecks, [9]);
    assert.deepEqual((await scan(api, result.state, [request()], true, "acme-reviewer")).requests[0]!.pulls, []);
  });

  it("stops after the feedback round, ignores other authors' verdicts and older heads, and needs a configured reviewer", async () => {
    const once = recordFeedback(emptyState(), 4, [pull(7).url]);
    const reviews = { 7: [verdict(7, "caution")], 8: [verdict(8, "blocked", "ana")], 9: [{ ...verdict(9, "blocked"), commitId: "old" }] };
    const { api } = source([pull(7), pull(8), pull(9)], {}, [], reviews);
    assert.deepEqual((await scan(api, once, [request()], true, "acme-reviewer")).requests[0]!.pulls, []);
    assert.deepEqual((await scan(source([pull(7)], {}, [], reviews).api)).requests[0]!.pulls, []);
  });
});

describe("redo reply", () => {
  const redo: PullRedo = { url: pull(7).url, number: 7, branch: "proseco/branch-7", headSha: "head7", reason: "command", requester: "ana", note: null };

  it("says why and what came of it", () => {
    assert.equal(redoReply(redo, "abcdef1234", { kind: "pr", url: redo.url, draft: false }), "proseco redid this pull request from the default branch at abcdef1, as ana asked.\n\nResult: ready for review.\n");
    assert.match(redoReply({ ...redo, reason: "conflict" }, "abcdef1234", { kind: "none", reason: "already fixed on the default branch" }), /because it conflicted with the default branch\.\n\nResult: already fixed on the default branch, so this pull request is no longer needed and can be closed\./);
    assert.match(redoReply({ ...redo, reason: "review" }, "abcdef1234", { kind: "none", reason: "tests failed" }), /to address the reviewer's findings\.\n\nResult: not updated: tests failed/);
    assert.match(redoReply({ ...redo, reason: "manual" }, "abcdef1234", { kind: "none", reason: "tests failed" }), /by hand\.\n\nResult: not updated: tests failed/);
    assert.equal(redoReply(redo, "abcdef1234", null), "proseco did not redo this pull request: its findings are no longer on the ticket, so it can be closed.\n");
  });
});
