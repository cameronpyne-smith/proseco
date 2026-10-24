import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { TicketRepo } from "../src/core/github.ts";
import { renderBody } from "../src/core/ticket.ts";
import type { Enrichment, ExistingTicket, Finding } from "../src/core/types.ts";
import { planActions, ticketFilters } from "../src/ticketer/plan.ts";

const CONTEXT = { org: "acme-org", maintainedIn: "acme-ops" };
const realFetch = globalThis.fetch;

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    origin: "dependabot",
    repo: "acme-docs",
    cve: "CVE-2026-0001",
    severity: "high",
    ecosystem: "npm",
    package: "lodash",
    installed: "4.17.0",
    fixedIn: "4.17.21",
    source: "package-lock.json",
    relationship: "transitive",
    scope: "development",
    imageKey: null,
    ...overrides,
  };
}

function enrichment(epss: Record<string, number> = {}, kev: string[] = []): Enrichment {
  return { epss: new Map(Object.entries(epss)), kev: new Set(kev) };
}

function ticket(overrides: Partial<ExistingTicket> & Pick<ExistingTicket, "body">): ExistingTicket {
  return {
    number: 7,
    nodeId: "I_7",
    state: "open",
    stateReason: null,
    title: "Vulnerabilities: acme-docs",
    author: "proseco-bot[bot]",
    labels: [],
    ...overrides,
  };
}

function rowCves(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("| CVE-"))
    .map((line) => line.split(" | ")[0]!.slice(2));
}

function render(key: string, findings: Finding[], enrichmentData: Enrichment): string {
  return renderBody(key, findings, enrichmentData, CONTEXT);
}

function plan(findings: Finding[], tickets: ExistingTicket[], enrichmentData: Enrichment) {
  return planActions(findings, tickets, enrichmentData, CONTEXT);
}

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    node_id: `I_${number}`,
    state: "open",
    state_reason: null,
    title: `#${number}`,
    body: `<!-- proseco:R${number} -->`,
    user: { login: "proseco-bot[bot]" },
    labels: [{ name: "Security" }],
    ...extra,
  };
}

function serve(byFilter: Record<string, unknown[]>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.search);
    const filter = url.searchParams.has("creator") ? `creator=${url.searchParams.get("creator")}` : `labels=${url.searchParams.get("labels")}`;
    return new Response(JSON.stringify(byFilter[filter] ?? []), { status: 200 });
  }) as typeof fetch;
  return requested;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function listTickets() {
  return new TicketRepo("token", "acme-org", "acme-tickets").list(ticketFilters({ labels: ["Security"], creators: ["proseco-bot[bot]", "acme-proseco[bot]"] }));
}

describe("listing proseco tickets", () => {
  it("finds a ticket whose Security label was removed through the app that created it", async () => {
    serve({ "labels=Security": [issue(1)], "creator=proseco-bot[bot]": [issue(1), issue(2, { labels: [] })] });
    const tickets = await listTickets();
    assert.deepEqual(
      tickets.map((ticket) => ticket.number).sort(),
      [1, 2],
    );
  });

  it("finds tickets created by an earlier app after the app is replaced", async () => {
    serve({ "labels=Security": [], "creator=proseco-bot[bot]": [issue(5, { labels: [] })], "creator=acme-proseco[bot]": [issue(6)] });
    const tickets = await listTickets();
    assert.deepEqual(
      tickets.map((ticket) => [ticket.number, ticket.author]),
      [[5, "proseco-bot[bot]"], [6, "proseco-bot[bot]"]],
    );
  });

  it("still finds labelled tickets the app did not create", async () => {
    serve({ "labels=Security": [issue(3, { user: { login: "someone" } })] });
    const tickets = await listTickets();
    assert.deepEqual(
      tickets.map((ticket) => [ticket.number, ticket.author, ticket.labels]),
      [[3, "someone", ["Security"]]],
    );
  });

  it("asks for every state, so closed and risk-accepted tickets are seen", async () => {
    const requested = serve({});
    await listTickets();
    assert.ok(requested.length === 3 && requested.every((search) => new URLSearchParams(search).get("state") === "all"));
  });

  it("skips pull requests", async () => {
    serve({ "labels=Security": [issue(4, { pull_request: {} })] });
    assert.deepEqual(await listTickets(), []);
  });
});

describe("planning", () => {
  it("creates a ticket for a repo with qualifying findings and none yet", () => {
    const actions = plan([finding()], [], enrichment());
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, "create");
    assert.equal((actions[0] as { title: string }).title, "Vulnerabilities: acme-docs");
    assert.ok((actions[0] as { body: string }).body.includes("<!-- proseco:acme-docs -->"));
  });

  it("creates nothing for a repo with only sub-threshold findings", () => {
    assert.deepEqual(plan([finding({ severity: "medium" })], [], enrichment()), []);
  });

  it("is a no-op when re-run against the ticket it wrote", () => {
    const findings = [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2", severity: "critical" }), finding({ repo: null, cve: "CVE-3" })];
    const created = plan(findings, [], enrichment({ "CVE-1": 0.3 }, ["CVE-2"]));
    const tickets = created.map((action, index) => {
      assert.equal(action.type, "create");
      const { title, body } = action as { title: string; body: string };
      return ticket({ number: index + 1, title, body });
    });
    const rerun = plan(findings, tickets, enrichment({ "CVE-1": 0.3 }, ["CVE-2"]));
    assert.deepEqual(
      rerun.map((action) => action.type),
      ["noop", "noop"],
    );
  });

  it("updates an open ticket in place when the findings change", () => {
    const first = render("acme-docs", [finding({ cve: "CVE-1" })], enrichment());
    const actions = plan([finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })], [ticket({ body: first })], enrichment());
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, "update");
    assert.equal((actions[0] as { number: number }).number, 7);
    assert.deepEqual(rowCves((actions[0] as { body: string }).body).sort(), ["CVE-1", "CVE-2"]);
  });

  it("is a no-op when GitHub hands back the body with different line endings or trailing whitespace", () => {
    const findings = [finding()];
    const stored = render("acme-docs", findings, enrichment()).trimEnd().replaceAll("\n", "\r\n");
    assert.deepEqual(
      plan(findings, [ticket({ body: stored })], enrichment()).map((action) => action.type),
      ["noop"],
    );
  });

  it("is a no-op when only EPSS scores changed, even if that reorders the rows", () => {
    const findings = [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })];
    const stored = render("acme-docs", findings, enrichment({ "CVE-1": 0.9, "CVE-2": 0.1 }));
    const actions = plan(findings, [ticket({ body: stored })], enrichment({ "CVE-1": 0.2, "CVE-2": 0.7 }));
    assert.deepEqual(
      actions.map((action) => action.type),
      ["noop"],
    );
  });

  it("rewrites the table, with fresh EPSS values, when something other than EPSS changed", () => {
    const stored = render("acme-docs", [finding({ cve: "CVE-1" })], enrichment({ "CVE-1": 0.9 }));
    const actions = plan(
      [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })],
      [ticket({ body: stored })],
      enrichment({ "CVE-1": 0.2, "CVE-2": 0.1 }),
    );
    assert.equal(actions[0]!.type, "update");
    assert.ok((actions[0] as { body: string }).body.includes("| 20.0% |"));
  });

  it("updates when a CVE enters the KEV catalogue", () => {
    const findings = [finding({ cve: "CVE-1" })];
    const existing = ticket({ body: render("acme-docs", findings, enrichment()) });
    const actions = plan(findings, [existing], enrichment({}, ["CVE-1"]));
    assert.equal(actions[0]!.type, "update");
  });

  it("puts every repo with findings on its own ticket and lists unmapped images separately", () => {
    const actions = plan(
      [finding({ repo: "A" }), finding({ repo: "B" }), finding({ repo: null, source: "ghcr.io/acme-org/orphan" })],
      [],
      enrichment(),
    );
    assert.deepEqual(
      actions.map((action) => (action as { title: string }).title),
      ["Vulnerabilities: A", "Vulnerabilities: B", "Vulnerabilities: unmapped images"],
    );
    const unmapped = actions[2] as { body: string };
    assert.ok(unmapped.body.includes("<!-- proseco:unmapped -->"));
    assert.ok(unmapped.body.includes("ghcr.io/acme-org/orphan"));
  });

  it("closes an open ticket as completed when no qualifying findings remain", () => {
    const body = render("acme-docs", [finding()], enrichment());
    const actions = plan([finding({ severity: "medium" })], [ticket({ body })], enrichment());
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.type, "close");
    assert.equal((actions[0] as { number: number }).number, 7);
  });

  it("leaves an already closed ticket alone when no findings remain", () => {
    const body = render("acme-docs", [finding()], enrichment());
    assert.deepEqual(plan([], [ticket({ body, state: "closed", stateReason: "completed" })], enrichment()), []);
  });

  it("reopens a ticket that was closed as completed when findings come back", () => {
    const body = render("acme-docs", [finding({ cve: "CVE-1" })], enrichment());
    const actions = plan([finding({ cve: "CVE-1" })], [ticket({ body, state: "closed", stateReason: "completed" })], enrichment());
    assert.equal(actions[0]!.type, "reopen");
  });

  describe("risk accepted (closed as not planned)", () => {
    const accepted = (findings: Finding[]) =>
      ticket({ body: render("acme-docs", findings, enrichment()), state: "closed", stateReason: "not_planned" });

    it("stays closed while the findings are the ones in its last table", () => {
      const last = [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })];
      assert.deepEqual(
        plan(last, [accepted(last)], enrichment()).map((action) => action.type),
        ["noop"],
      );
    });

    it("stays closed when some of the accepted findings have since been fixed", () => {
      const last = [finding({ cve: "CVE-1" }), finding({ cve: "CVE-2" })];
      assert.deepEqual(
        plan([finding({ cve: "CVE-1" })], [accepted(last)], enrichment()).map((action) => action.type),
        ["noop"],
      );
    });

    it("reopens with a rewritten table when a CVE appears that was not in the last table", () => {
      const last = [finding({ cve: "CVE-1" })];
      const actions = plan([finding({ cve: "CVE-1" }), finding({ cve: "CVE-9" })], [accepted(last)], enrichment());
      assert.equal(actions[0]!.type, "reopen");
      const reopen = actions[0] as { comment: string; body: string };
      assert.ok(reopen.comment.includes("CVE-9"));
      assert.deepEqual(rowCves(reopen.body).sort(), ["CVE-1", "CVE-9"]);
    });

    it("does not reopen for a sub-threshold CVE the table never listed", () => {
      const last = [finding({ cve: "CVE-1" })];
      const actions = plan([finding({ cve: "CVE-1" }), finding({ cve: "CVE-9", severity: "medium" })], [accepted(last)], enrichment());
      assert.deepEqual(
        actions.map((action) => action.type),
        ["noop"],
      );
    });
  });

  it("uses the open ticket when a closed duplicate carries the same marker", () => {
    const body = render("acme-docs", [finding()], enrichment());
    const actions = plan(
      [finding()],
      [ticket({ number: 3, body }), ticket({ number: 9, body, state: "closed", stateReason: "completed" })],
      enrichment(),
    );
    assert.deepEqual(actions, [{ type: "noop", key: "acme-docs", number: 3 }]);
  });

  it("ignores issues that carry no marker", () => {
    assert.deepEqual(plan([], [ticket({ body: "hand-written security issue" })], enrichment()), []);
  });

  it("ignores an issue that merely quotes the marker format in its text", () => {
    const spec = "Identified by a hidden marker (`<!-- proseco:<repo> -->`) per repo.\n\n<!-- proseco:acme-docs -->";
    assert.deepEqual(plan([], [ticket({ body: spec })], enrichment()), []);
  });
});

describe("oversize bodies", () => {
  const huge = (cve: string) =>
    Array.from({ length: 600 }, (_, index) =>
      finding({ cve: `${cve}-${index}`, package: `a-very-long-package-name-${index}-${"x".repeat(40)}`, installed: `1.0.${index}`, fixedIn: `1.1.${index}` }),
    );

  it("fails the oversize ticket with its key and length and still plans the others", () => {
    const actions = plan([...huge("CVE-2026-9").map((f) => ({ ...f, repo: "big" })), finding({ repo: "small" })], [], enrichment());
    const big = actions.find((action) => action.key === "big")!;
    assert.equal(big.type, "oversize");
    assert.match((big as { message: string }).message, /^big: .* \d{5,} characters/);
    assert.equal(actions.find((action) => action.key === "small")!.type, "create");
  });

  it("does not update an existing ticket whose new body is oversize", () => {
    const old = render("big", [finding({ repo: "big" })], enrichment());
    const actions = plan(huge("CVE-2026-9").map((f) => ({ ...f, repo: "big" })), [ticket({ body: old })], enrichment());
    assert.deepEqual(actions.map((action) => action.type), ["oversize"]);
  });
});
