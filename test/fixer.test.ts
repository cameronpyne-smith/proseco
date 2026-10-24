import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TicketRepo } from "../src/core/github.ts";
import type { ExistingTicket, TicketComment } from "../src/core/types.ts";
import { applyCommands, commandComment, fixRequests, requestFilters, type CommentApi } from "../src/fixer/requests.ts";
import { emptyState, recordComment } from "../src/fixer/state.ts";

const CREATORS = ["proseco-bot[bot]"];

function ticket(number: number, overrides: Partial<ExistingTicket> = {}): ExistingTicket {
  return {
    number,
    nodeId: `I_${number}`,
    state: "open",
    stateReason: null,
    title: `Vulnerabilities: Acme.Repo${number}`,
    body: `<!-- proseco:Acme.Repo${number} -->\n\nbody`,
    author: "proseco-bot[bot]",
    labels: ["Security"],
    ...overrides,
  };
}

function comment(id: number, body: string, overrides: Partial<TicketComment> = {}): TicketComment {
  return { id, author: "alice", authorType: "User", body, createdAt: "2026-10-01T10:00:00Z", ...overrides };
}

describe("finding fix requests", () => {
  it("lists open tickets by every label and creator that can find a proseco ticket", () => {
    assert.deepEqual(requestFilters({ labels: ["Security", "team"], creators: ["proseco-bot[bot]"] }), [
      { labels: "Security", state: "open" },
      { labels: "team", state: "open" },
      { creator: "proseco-bot[bot]", state: "open" },
    ]);
  });

  it("requests every open proseco ticket in ticket order, unforced until a comment says otherwise", () => {
    assert.deepEqual(fixRequests([ticket(9), ticket(3)], CREATORS), [
      { number: 3, repo: "Acme.Repo3", force: false, commentId: null },
      { number: 9, repo: "Acme.Repo9", force: false, commentId: null },
    ]);
  });

  it("ignores a ticket someone else wrote, even with the marker", () => {
    assert.deepEqual(fixRequests([ticket(1, { author: "someone" })], CREATORS), []);
  });

  it("ignores a ticket that only quotes the marker below its first line", () => {
    assert.deepEqual(fixRequests([ticket(1, { body: "Spec:\n<!-- proseco:Acme.Repo1 -->" })], CREATORS), []);
  });

  it("ignores closed tickets and the unmapped images ticket, which has no repo to fix", () => {
    assert.deepEqual(fixRequests([ticket(1, { state: "closed" }), ticket(2, { body: "<!-- proseco:unmapped -->" })], CREATORS), []);
  });
});

describe("comment command", () => {
  it("matches the bot and fix, case-insensitively, anywhere after whitespace", () => {
    for (const body of ["@acme-proseco fix", "@Acme-Proseco FIX please", "thanks!\n@acme-proseco   fix this", "ok @acme-proseco fix."]) {
      assert.equal(commandComment([comment(5, body)], "acme-proseco", null)?.id, 5, body);
    }
  });

  it("ignores a mention without fix, another bot, or text glued to the mention", () => {
    for (const body of ["@acme-proseco look at this", "@acme-proseco fixes nothing", "@other-bot fix", "x@acme-proseco fix", "@acme-proseco-bot fix", "acme-proseco fix"]) {
      assert.equal(commandComment([comment(5, body)], "acme-proseco", null), null, body);
    }
  });

  it("ignores bot authors", () => {
    assert.equal(commandComment([comment(5, "@acme-proseco fix", { author: "ci[bot]", authorType: "Bot" })], "acme-proseco", null), null);
    assert.equal(commandComment([comment(5, "@acme-proseco fix", { author: "ci[bot]" })], "acme-proseco", null), null);
  });

  it("ignores comments at or before the last seen id and returns the newest of those after", () => {
    const comments = [comment(5, "@acme-proseco fix"), comment(8, "@acme-proseco fix"), comment(9, "unrelated")];
    assert.equal(commandComment(comments, "acme-proseco", 8), null);
    assert.equal(commandComment(comments, "acme-proseco", 5)?.id, 8);
    assert.equal(commandComment(comments, "acme-proseco", null)?.id, 8);
  });

  it("takes the bot name literally, not as a pattern", () => {
    assert.equal(commandComment([comment(1, "@acmeXproseco fix")], "acme.proseco", null), null);
  });
});

describe("acknowledging commands", () => {
  function api(byTicket: Record<number, TicketComment[]>) {
    const reactions: [number, string][] = [];
    const source: CommentApi = {
      comments: async (number) => byTicket[number] ?? [],
      react: async (id, content) => {
        reactions.push([id, content]);
      },
    };
    return { source, reactions };
  }

  const requests = fixRequests([ticket(1), ticket(2)], CREATORS);

  it("forces the ticket, reacts with eyes on the command comment and records its id", async () => {
    const { source, reactions } = api({ 1: [comment(10, "@acme-proseco fix")], 2: [comment(11, "hello")] });
    const result = await applyCommands(requests, source, "acme-proseco", emptyState(), true);
    assert.deepEqual(result.requests.map((request) => [request.number, request.force, request.commentId]), [
      [1, true, 10],
      [2, false, null],
    ]);
    assert.deepEqual(reactions, [[10, "eyes"]]);
    assert.equal(result.state.tickets["1"]?.lastCommentId, 10);
    assert.equal(result.state.tickets["2"], undefined);
  });

  it("acts on each command once: a second poll with the recorded state does nothing", async () => {
    const { source, reactions } = api({ 1: [comment(10, "@acme-proseco fix")] });
    const first = await applyCommands(requests, source, "acme-proseco", emptyState(), true);
    const second = await applyCommands(requests, source, "acme-proseco", first.state, true);
    assert.equal(second.requests[0]!.force, false);
    assert.equal(reactions.length, 1);
  });

  it("acts on a newer command after an earlier one was handled", async () => {
    const { source, reactions } = api({ 1: [comment(10, "@acme-proseco fix"), comment(12, "@acme-proseco fix")] });
    const result = await applyCommands(requests, source, "acme-proseco", recordComment(emptyState(), 1, 10), true);
    assert.equal(result.requests[0]!.commentId, 12);
    assert.deepEqual(reactions, [[12, "eyes"]]);
  });

  it("reports the command without reacting or recording when not acknowledging", async () => {
    const { source, reactions } = api({ 1: [comment(10, "@acme-proseco fix")] });
    const state = emptyState();
    const result = await applyCommands(requests, source, "acme-proseco", state, false);
    assert.equal(result.requests[0]!.force, true);
    assert.deepEqual(reactions, []);
    assert.deepEqual(result.state, state);
  });

  it("does not record a command whose reaction failed, so the next poll retries it", async () => {
    const source: CommentApi = {
      comments: async () => [comment(10, "@acme-proseco fix")],
      react: async () => {
        throw new Error("react failed");
      },
    };
    await assert.rejects(applyCommands(requests, source, "acme-proseco", emptyState(), true), /react failed/);
  });
});

describe("ticket comments over HTTP", () => {
  function repo(responses: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses(url, init);
    }) as unknown as typeof fetch;
    return { tickets: new TicketRepo("token", "acme-org", "acme-tickets", fetchImpl), calls };
  }

  it("lists comments, following pagination, with the author type", async () => {
    const { tickets, calls } = repo((url) =>
      url.includes("page=2")
        ? new Response(JSON.stringify([{ id: 2, body: "b", created_at: "t2", user: { login: "ci[bot]", type: "Bot" } }]))
        : new Response(JSON.stringify([{ id: 1, body: null, created_at: "t1", user: { login: "alice", type: "User" } }]), {
            headers: { link: '<https://api.github.com/repos/acme-org/acme-tickets/issues/7/comments?per_page=100&page=2>; rel="next"' },
          }),
    );
    assert.deepEqual(await tickets.comments(7), [
      { id: 1, author: "alice", authorType: "User", body: "", createdAt: "t1" },
      { id: 2, author: "ci[bot]", authorType: "Bot", body: "b", createdAt: "t2" },
    ]);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-tickets/issues/7/comments?per_page=100");
  });

  it("posts an eyes reaction to the comment", async () => {
    const { tickets, calls } = repo(() => new Response("{}", { status: 201 }));
    await tickets.react(99, "eyes");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-tickets/issues/comments/99/reactions");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { content: "eyes" });
  });

  it("names the comment when the reaction fails", async () => {
    const { tickets } = repo(() => new Response("no", { status: 403, statusText: "Forbidden" }));
    await assert.rejects(tickets.react(99, "eyes"), /react to comment 99 failed: 403/);
  });
});
