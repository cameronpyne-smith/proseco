import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExistingTicket } from "../src/core/types.ts";
import { fixRequests, requestFilters } from "../src/fixer/requests.ts";

const LABELS = { assess: "proseco-assess", fix: "proseco-fix" };
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
    labels: ["Security", LABELS.assess],
    ...overrides,
  };
}

describe("finding fix requests", () => {
  it("asks only for open tickets carrying either request label", () => {
    assert.deepEqual(requestFilters(LABELS), [
      { labels: "proseco-assess", state: "open" },
      { labels: "proseco-fix", state: "open" },
    ]);
  });

  it("turns each labelled proseco ticket into a request for its repo, in ticket order", () => {
    const requests = fixRequests([ticket(9), ticket(3, { labels: [LABELS.fix] })], CREATORS, LABELS);
    assert.deepEqual(requests, [
      { number: 3, repo: "Acme.Repo3", request: "fix" },
      { number: 9, repo: "Acme.Repo9", request: "assess" },
    ]);
  });

  it("treats a ticket with both labels as a fix request, which includes the assessment", () => {
    assert.deepEqual(fixRequests([ticket(1, { labels: [LABELS.assess, LABELS.fix] })], CREATORS, LABELS), [
      { number: 1, repo: "Acme.Repo1", request: "fix" },
    ]);
  });

  it("ignores a ticket someone else wrote, even with the marker and the label", () => {
    assert.deepEqual(fixRequests([ticket(1, { author: "someone" })], CREATORS, LABELS), []);
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
