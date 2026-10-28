import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RepoApi, TicketRepo } from "../src/core/github.ts";

interface Call {
  method: string;
  url: string;
  body: unknown;
  authorization: string | undefined;
}

function recorder(...replies: (unknown | Response)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: (init?.headers as Record<string, string> | undefined)?.["authorization"],
    });
    const reply = queue.shift();
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply ?? {}), { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const PULL = { number: 7, html_url: "https://github.com/acme-org/acme-api/pull/7", node_id: "PR_node", draft: false, state: "open", merged_at: null, title: "Bump a to 1.0.1", user: { login: "acme-proseco[bot]" }, head: { sha: "abc123" } };

describe("repo api", () => {
  it("reads the default branch", async () => {
    const { fetch, calls } = recorder({ default_branch: "trunk" });
    assert.equal(await new RepoApi("tok", "acme-org", "acme-api", fetch).defaultBranch(), "trunk");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api");
    assert.equal(calls[0]!.authorization, "Bearer tok");
  });

  it("finds an open pull request by head and returns null when there is none", async () => {
    const { fetch, calls } = recorder([PULL], []);
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual(await api.findOpenPull("proseco/package-lock.json"), { number: 7, url: PULL.html_url, nodeId: "PR_node", draft: false, headSha: "abc123", autoMerge: false });
    const { fetch: again } = recorder([{ ...PULL, auto_merge: { merge_method: "squash" } }]);
    assert.equal((await new RepoApi("tok", "acme-org", "acme-api", again).findOpenPull("proseco/package-lock.json"))!.autoMerge, true);
    assert.equal(await api.findOpenPull("proseco/other"), null);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls?head=acme-org%3Aproseco%2Fpackage-lock.json&state=open");
  });

  it("reads a pull request's title, state, draft flag and author", async () => {
    const { fetch, calls } = recorder(PULL, { ...PULL, draft: true, state: "closed", merged_at: "2026-01-01T00:00:00Z" });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual(await api.pullDetails(7), { url: PULL.html_url, title: "Bump a to 1.0.1", state: "open", draft: false, author: "acme-proseco[bot]", headSha: "abc123" });
    assert.equal((await api.pullDetails(7)).state, "merged");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls/7");
  });

  it("reads a commit's tree", async () => {
    const { fetch, calls } = recorder({ sha: "abc123", tree: { sha: "tree9" } });
    assert.equal(await new RepoApi("tok", "acme-org", "acme-api", fetch).commitTree("abc123"), "tree9");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/git/commits/abc123");
  });

  it("creates a pull request with its draft flag", async () => {
    const { fetch, calls } = recorder({ ...PULL, draft: true });
    const created = await new RepoApi("tok", "acme-org", "acme-api", fetch).createPull({ title: "T", body: "B", head: "proseco/x", base: "main", draft: true });
    assert.equal(created.draft, true);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls");
    assert.deepEqual(calls[0]!.body, { title: "T", body: "B", head: "proseco/x", base: "main", draft: true });
  });

  it("updates the title and body by PATCH", async () => {
    const { fetch, calls } = recorder({});
    await new RepoApi("tok", "acme-org", "acme-api", fetch).updatePull(7, { title: "T2", body: "B2" });
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls/7");
    assert.deepEqual(calls[0]!.body, { title: "T2", body: "B2" });
  });

  it("toggles draft through the graphql mutations", async () => {
    const { fetch, calls } = recorder({ data: {} }, { data: {} });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    await api.setDraft("PR_node", true);
    await api.setDraft("PR_node", false);
    assert.equal(calls[0]!.url, "https://api.github.com/graphql");
    assert.match((calls[0]!.body as { query: string }).query, /convertPullRequestToDraft/);
    assert.match((calls[1]!.body as { query: string }).query, /markPullRequestReadyForReview/);
    assert.deepEqual((calls[1]!.body as { variables: unknown }).variables, { id: "PR_node" });
  });

  it("enables auto-merge through the graphql mutation with the method in upper case, and surfaces a refusal", async () => {
    const { fetch, calls } = recorder({ data: {} }, { data: null, errors: [{ message: "Pull request Auto merge is not allowed for this repository" }] });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    await api.enableAutoMerge("PR_node", "squash");
    assert.match((calls[0]!.body as { query: string }).query, /enablePullRequestAutoMerge/);
    assert.deepEqual((calls[0]!.body as { variables: unknown }).variables, { id: "PR_node", method: "SQUASH" });
    await assert.rejects(api.enableAutoMerge("PR_node", "merge"), /Auto merge is not allowed/);
  });

  it("reads a pull request's state: open, merged by merged_at, or closed", async () => {
    const { fetch } = recorder(PULL, { ...PULL, state: "closed", merged_at: "2026-01-01T00:00:00Z" }, { ...PULL, state: "closed" });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual([await api.pullState(7), await api.pullState(7), await api.pullState(7)], ["open", "merged", "closed"]);
  });

  it("names the failed call and status", async () => {
    const { fetch } = recorder(new Response("nope", { status: 422, statusText: "Unprocessable" }));
    await assert.rejects(new RepoApi("tok", "acme-org", "acme-api", fetch).createPull({ title: "T", body: "B", head: "h", base: "main", draft: false }), /open a pull request for h failed: 422/);
  });
});

describe("ticket repo comments", () => {
  it("edits a comment by id", async () => {
    const { fetch, calls } = recorder({});
    await new TicketRepo("tok", "acme-org", "acme-tickets", fetch).editComment(99, "new body");
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-tickets/issues/comments/99");
    assert.deepEqual(calls[0]!.body, { body: "new body" });
  });

  it("can write when the permission is write or admin, not read or for an unknown login", async () => {
    const { fetch, calls } = recorder({ permission: "write", role_name: "maintain" }, { permission: "admin" }, { permission: "read", role_name: "triage" }, new Response("", { status: 404 }));
    const repo = new TicketRepo("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual([await repo.canWrite("ana"), await repo.canWrite("bo"), await repo.canWrite("cy"), await repo.canWrite("ghost")], [true, true, false, false]);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/collaborators/ana/permission");
    await assert.rejects(new TicketRepo("tok", "acme-org", "acme-api", recorder(new Response("boom", { status: 500 })).fetch).canWrite("ana"), /500/);
  });
});

describe("repo api pull listing", () => {
  it("lists open pull requests with their branch, head, author and body", async () => {
    const { fetch, calls } = recorder([{ ...PULL, body: "Part of acme-org/acme-tickets#4", head: { sha: "abc123", ref: "proseco/package-lock.json" } }]);
    assert.deepEqual(await new RepoApi("tok", "acme-org", "acme-api", fetch).openPulls(), [
      { number: 7, url: PULL.html_url, state: "open", branch: "proseco/package-lock.json", headSha: "abc123", author: "acme-proseco[bot]", body: "Part of acme-org/acme-tickets#4" },
    ]);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls?state=open&per_page=100");
  });

  it("is conflicted only when GitHub says it cannot merge, not while it is still computing", async () => {
    const { fetch } = recorder({ ...PULL, mergeable: false }, { ...PULL, mergeable: null }, { ...PULL, mergeable: true });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual([await api.conflicted(7), await api.conflicted(7), await api.conflicted(7)], [true, false, false]);
  });
});

describe("repo api reviews, labels and comments", () => {
  it("lists reviews with their author, commit and body, and the inline comments with their review", async () => {
    const { fetch, calls } = recorder([{ id: 5, user: { login: "reviewdo-bot[bot]" }, state: "COMMENTED", commit_id: "abc123", body: "<!-- reviewdo verdict=ready -->" }], [{ id: 9, pull_request_review_id: 5, path: "a.ts", line: null, original_line: 4, body: "b" }]);
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.deepEqual(await api.reviews(7), [{ id: 5, author: "reviewdo-bot[bot]", state: "COMMENTED", commitId: "abc123", body: "<!-- reviewdo verdict=ready -->" }]);
    assert.deepEqual(await api.reviewComments(7), [{ id: 9, reviewId: 5, path: "a.ts", line: 4, body: "b" }]);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls/7/reviews?per_page=100");
    assert.equal(calls[1]!.url, "https://api.github.com/repos/acme-org/acme-api/pulls/7/comments?per_page=100");
  });

  it("checks, creates and adds a label, and comments on a pull request", async () => {
    const { fetch, calls } = recorder(new Response("", { status: 404 }), { name: "reviewdo" }, {}, {}, { name: "reviewdo" });
    const api = new RepoApi("tok", "acme-org", "acme-api", fetch);
    assert.equal(await api.hasLabel("reviewdo"), false);
    await api.createLabel("reviewdo", "0e8a16", "d");
    await api.addLabels(7, ["reviewdo"]);
    await api.commentOnPull(7, "reply");
    assert.equal(await api.hasLabel("reviewdo"), true);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme-org/acme-api/labels/reviewdo");
    assert.deepEqual([calls[1]!.method, calls[1]!.url, calls[1]!.body], ["POST", "https://api.github.com/repos/acme-org/acme-api/labels", { name: "reviewdo", color: "0e8a16", description: "d" }]);
    assert.deepEqual([calls[2]!.method, calls[2]!.url, calls[2]!.body], ["POST", "https://api.github.com/repos/acme-org/acme-api/issues/7/labels", { labels: ["reviewdo"] }]);
    assert.deepEqual([calls[3]!.method, calls[3]!.url, calls[3]!.body], ["POST", "https://api.github.com/repos/acme-org/acme-api/issues/7/comments", { body: "reply" }]);
  });
});
