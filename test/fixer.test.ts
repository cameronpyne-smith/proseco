import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExistingTicket } from "../src/core/types.ts";
import { fixRequests, requestFilters } from "../src/fixer/requests.ts";

const LABELS = { fix: "proseco-fix" };
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

describe("finding fix requests", () => {
  it("lists open tickets by every label and creator that can find a proseco ticket", () => {
    assert.deepEqual(requestFilters({ labels: ["Security", "team"], creators: ["proseco-bot[bot]"] }), [
      { labels: "Security", state: "open" },
      { labels: "team", state: "open" },
      { creator: "proseco-bot[bot]", state: "open" },
    ]);
  });

  it("requests every open proseco ticket, in ticket order, whether or not it carries a label", () => {
    assert.deepEqual(fixRequests([ticket(9), ticket(3)], CREATORS, LABELS), [
      { number: 3, repo: "Acme.Repo3", force: false },
      { number: 9, repo: "Acme.Repo9", force: false },
    ]);
  });

  it("forces a redo when the fix label is on the ticket", () => {
    assert.deepEqual(fixRequests([ticket(1, { labels: ["Security", LABELS.fix] })], CREATORS, LABELS), [
      { number: 1, repo: "Acme.Repo1", force: true },
    ]);
  });

  it("ignores a ticket someone else wrote, even with the marker and the label", () => {
    assert.deepEqual(fixRequests([ticket(1, { author: "someone", labels: [LABELS.fix] })], CREATORS, LABELS), []);
  });

  it("ignores a ticket that only quotes the marker below its first line", () => {
    assert.deepEqual(fixRequests([ticket(1, { body: "Spec:\n<!-- proseco:Acme.Repo1 -->" })], CREATORS, LABELS), []);
  });

  it("ignores closed tickets and the unmapped images ticket, which has no repo to fix", () => {
    const requests = fixRequests(
      [ticket(1, { state: "closed" }), ticket(2, { body: "<!-- proseco:unmapped -->" })],
      CREATORS,
      LABELS,
    );
    assert.deepEqual(requests, []);
  });
});
