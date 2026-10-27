import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RepoApi } from "../src/core/github.ts";
import { LivePublisher } from "../src/fixer/run.ts";
import type { PublishRequest } from "../src/fixer/unit.ts";

const URL7 = "https://github.com/acme-org/acme-api/pull/7";

interface World {
  open: { draft: boolean; headSha: string } | null;
  trees: Record<string, string>;
  reviews: { user: { login: string }; state: string }[];
}

function harness(world: World, localTree: string) {
  const calls: string[] = [];
  const pushes: string[] = [];
  const route = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace("https://api.github.com/repos/acme-org/acme-api", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (method === "GET" && url.startsWith("/pulls?")) return json(world.open ? [{ number: 7, html_url: URL7, node_id: "PR_7", draft: world.open.draft, state: "open", head: { sha: world.open.headSha } }] : []);
    if (method === "GET" && url.startsWith("/git/commits/")) return json({ tree: { sha: world.trees[url.slice("/git/commits/".length)] } });
    if (method === "GET" && url.startsWith("/pulls/7/reviews")) return json(world.reviews);
    if (method === "POST" && url === "/pulls") return json({ number: 8, html_url: "https://github.com/acme-org/acme-api/pull/8", node_id: "PR_8", draft: false, state: "open", head: { sha: "new" } });
    if (method === "GET" && url === "") return json({ default_branch: "main" });
    if (String(input).endsWith("/graphql")) return json({ data: {} });
    return json({});
  };
  const publisher = new LivePublisher({
    org: "acme-org",
    tokens: async () => "tok",
    store: {
      push: async (_path, _repo, branch) => void pushes.push(branch),
      inCheckout: async (_path, args) => (args[0] === "rev-parse" ? `${localTree}\n` : ""),
    },
    api: (token, repo) => new RepoApi(token, "acme-org", repo, route as typeof fetch),
  });
  return { publisher, calls, pushes };
}

function request(draft: boolean): PublishRequest {
  return {
    repo: "acme-api",
    branch: "proseco/package-lock.json",
    title: "Bump a to 1.0.1",
    body: "body",
    draft,
    checkout: "/nowhere",
    commit: { sha: "c0ffee", files: ["package-lock.json"] },
    diff: "",
    checks: [],
    tests: { kind: "no-tests", commands: [], tail: "" },
    summary: "",
  };
}

const APPROVED = [{ user: { login: "ana" }, state: "APPROVED" }];

describe("live publisher", () => {
  it("pushes and opens a new pull request, announcing it only when ready", async () => {
    const ready = harness({ open: null, trees: {}, reviews: [] }, "t1");
    assert.deepEqual(await ready.publisher.publish(request(false)), { url: "https://github.com/acme-org/acme-api/pull/8", draft: false, announce: "new" });
    assert.deepEqual(ready.pushes, ["proseco/package-lock.json"]);
    const draft = harness({ open: null, trees: {}, reviews: [] }, "t1");
    assert.equal((await draft.publisher.publish(request(true))).announce, null);
  });

  it("announces an approved pull request for re-review when the push changes its tree", async () => {
    const run = harness({ open: { draft: false, headSha: "old" }, trees: { old: "t0" }, reviews: APPROVED }, "t1");
    assert.deepEqual(await run.publisher.publish(request(false)), { url: URL7, draft: false, announce: "re-review" });
    assert.deepEqual(run.pushes, ["proseco/package-lock.json"]);
    assert.ok(run.calls.includes("PATCH /pulls/7"));
  });

  it("does not push or announce when the tree is unchanged, so an approval stands, but still updates the body", async () => {
    const run = harness({ open: { draft: false, headSha: "old" }, trees: { old: "t1" }, reviews: APPROVED }, "t1");
    assert.deepEqual(await run.publisher.publish(request(false)), { url: URL7, draft: false, announce: null });
    assert.deepEqual(run.pushes, []);
    assert.ok(run.calls.includes("PATCH /pulls/7"));
    assert.equal(run.calls.some((call) => call.includes("/reviews")), false);
  });

  it("does not announce an unapproved ready pull request that was updated", async () => {
    const run = harness({ open: { draft: false, headSha: "old" }, trees: { old: "t0" }, reviews: [] }, "t1");
    assert.equal((await run.publisher.publish(request(false))).announce, null);
    assert.deepEqual(run.pushes, ["proseco/package-lock.json"]);
  });

  it("announces a draft that this run made ready, and marks it ready", async () => {
    const run = harness({ open: { draft: true, headSha: "old" }, trees: { old: "t0" }, reviews: [] }, "t1");
    assert.equal((await run.publisher.publish(request(false))).announce, "new");
    assert.ok(run.calls.includes("POST https://api.github.com/graphql"));
  });

  it("does not announce a pull request that stays or becomes a draft", async () => {
    const run = harness({ open: { draft: false, headSha: "old" }, trees: { old: "t0" }, reviews: APPROVED }, "t1");
    assert.equal((await run.publisher.publish(request(true))).announce, null);
    assert.equal(run.calls.some((call) => call.includes("/reviews")), false);
  });
});
