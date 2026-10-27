import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBody } from "../src/core/ticket.ts";
import type { Enrichment, Finding } from "../src/core/types.ts";
import { runAttempt, ShutdownRequested, type AttemptDeps, type UnitResult } from "../src/fixer/attempt.ts";
import type { PrUnit } from "../src/fixer/plan.ts";
import { bodyHash, emptyState, pendingAnnouncement, recordAttempt, recordIgnored, type PullRequestStatus, type State } from "../src/fixer/state.ts";

function finding(overrides: Partial<Finding>): Finding {
  return { origin: "dependabot", repo: "acme-api", cve: "CVE-2026-0001", severity: "high", ecosystem: "npm", package: "minimist", installed: "1.2.5", fixedIn: "1.2.6", source: "package-lock.json", relationship: null, scope: null, imageKey: null, ...overrides };
}

const ENRICHMENT: Enrichment = { epss: new Map(), kev: new Set() };

function ticket(findings: Finding[]) {
  return { number: 12, key: "acme-api", repo: "acme-api", body: renderBody("acme-api", findings, ENRICHMENT, { org: "acme-org", maintainedIn: "acme-ops" }) };
}

const TWO_LOCKFILES = ticket([
  finding({}),
  finding({ cve: "CVE-2026-0002", package: "left-pad", installed: "1.0.0", fixedIn: "1.3.0", source: "web/package-lock.json" }),
]);

interface Harness {
  deps: AttemptDeps;
  worked: string[];
  fetched: number;
  comments: string[];
  statusCalls: string[];
}

function harness(options: { work?: (unit: PrUnit) => Promise<UnitResult>; statuses?: Record<string, PullRequestStatus["state"]>; commentFails?: boolean } = {}): Harness {
  const result: Harness = { worked: [], fetched: 0, comments: [], statusCalls: [], deps: undefined as never };
  result.deps = {
    org: "acme-org",
    fetch: async () => {
      result.fetched++;
      return "f".repeat(40);
    },
    prStatus: async (url) => {
      result.statusCalls.push(url);
      return { url, state: options.statuses?.[url] ?? "open" };
    },
    workUnit: async (unit) => {
      result.worked.push(unit.source);
      return options.work ? options.work(unit) : { outcome: { kind: "pr", url: `https://github.com/acme-org/acme-api/pull/${result.worked.length}`, draft: false } };
    },
    postComment: async (body) => {
      if (options.commentFails) throw new Error("comment api down");
      result.comments.push(body);
    },
    now: () => new Date("2026-02-03T04:05:06Z"),
  };
  return result;
}

const base = (state: State = emptyState(), overrides = {}) => ({ ticket: TWO_LOCKFILES, force: false, state, local: false, ...overrides });

describe("attempt", () => {
  it("works each lockfile unit in order, posts one comment and records the attempt", async () => {
    const run = harness();
    const result = await runAttempt(base(), run.deps);
    assert.deepEqual(run.worked, ["package-lock.json", "web/package-lock.json"]);
    assert.equal(run.fetched, 1);
    assert.equal(run.comments.length, 1);
    assert.equal(run.comments[0]!.split("\n")[0], `<!-- proseco:attempt ${bodyHash(TWO_LOCKFILES.body)} -->`);
    assert.match(run.comments[0]!, /pull\/1/);
    assert.match(run.comments[0]!, /pull\/2/);
    assert.deepEqual(result.state.tickets["12"]!.attempt, {
      bodyHash: bodyHash(TWO_LOCKFILES.body),
      headSha: "f".repeat(40),
      attemptedAt: "2026-02-03T04:05:06.000Z",
      outcome: "pr-opened",
      prUrls: ["https://github.com/acme-org/acme-api/pull/1", "https://github.com/acme-org/acme-api/pull/2"],
    });
  });

  it("isolates a failing unit: it is reported in the comment and the next unit still runs", async () => {
    const run = harness({
      work: async (unit) => {
        if (unit.source === "package-lock.json") throw new Error("docker daemon went away");
        return { outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/9", draft: true } };
      },
    });
    const result = await runAttempt(base(), run.deps);
    assert.deepEqual(run.worked, ["package-lock.json", "web/package-lock.json"]);
    assert.match(run.comments[0]!, /`package-lock\.json`: no pull request: unexpected failure: docker daemon went away/);
    assert.match(run.comments[0]!, /`web\/package-lock\.json`: draft: https:\/\/github\.com\/acme-org\/acme-api\/pull\/9/);
    assert.equal(result.state.tickets["12"]!.attempt!.outcome, "pr-opened");
    assert.deepEqual(result.state.tickets["12"]!.attempt!.prUrls, ["https://github.com/acme-org/acme-api/pull/9"]);
  });

  it("records gave-up when no unit produced a pull request", async () => {
    const run = harness({ work: async () => ({ outcome: { kind: "none", reason: "lockfile check failed: minimist 1.2.5 is below 1.2.6" } }) });
    const result = await runAttempt(base(), run.deps);
    assert.equal(result.state.tickets["12"]!.attempt!.outcome, "gave-up");
    assert.deepEqual(result.state.tickets["12"]!.attempt!.prUrls, []);
    assert.match(run.comments[0]!, /lockfile check failed/);
  });

  it("works lockfile units first and then major upgrades, and reports other ecosystems without working them", async () => {
    const mixed = ticket([
      finding({ cve: "CVE-2026-0003", package: "express", installed: "3.0.0", fixedIn: "4.0.0", source: "package-lock.json" }),
      finding({}),
      finding({ cve: "CVE-2026-0004", ecosystem: "pip", package: "flask", installed: "1.0.0", fixedIn: "1.0.1", source: "Gemfile.lock" }),
    ]);
    const run = harness();
    const result = await runAttempt({ ticket: mixed, force: false, state: emptyState(), local: false }, run.deps);
    assert.deepEqual(result.reports.map((report) => report.unit.kind), ["lockfile", "lockfile", "major"]);
    assert.deepEqual(run.worked, ["package-lock.json", "package-lock.json"]);
    assert.match(run.comments[0]!, /express.*major.*: ready for review/);
    assert.match(run.comments[0]!, /`Gemfile\.lock`: no pull request: unsupported ecosystem: unknown lockfile type/);
  });

  it("leaves the lockfile unit's pull request untouched when the major unit fails", async () => {
    const mixed = ticket([finding({}), finding({ cve: "CVE-2026-0003", package: "express", installed: "3.0.0", fixedIn: "4.0.0", source: "package-lock.json" })]);
    const run = harness({
      work: async (unit) => {
        if (unit.kind === "major") throw new Error("the agent ran out of road");
        return { outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/4", draft: false } };
      },
    });
    const result = await runAttempt({ ticket: mixed, force: false, state: emptyState(), local: false }, run.deps);
    assert.deepEqual(result.state.tickets["12"]!.attempt!.prUrls, ["https://github.com/acme-org/acme-api/pull/4"]);
    assert.equal(result.state.tickets["12"]!.attempt!.outcome, "pr-opened");
    assert.match(run.comments[0]!, /express.*major.*: no pull request: unexpected failure: the agent ran out of road/);
  });

  it("works uv and requirements units like npm ones", async () => {
    const python = ticket([
      finding({ ecosystem: "pip", package: "requests", installed: "2.31.0", fixedIn: "2.32.0", source: "uv.lock" }),
      finding({ cve: "CVE-2026-0005", ecosystem: "pip", package: "flask", installed: "1.0.0", fixedIn: "1.0.1", source: "tools/requirements.txt" }),
    ]);
    const run = harness();
    await runAttempt({ ticket: python, force: false, state: emptyState(), local: false }, run.deps);
    assert.deepEqual(run.worked, ["tools/requirements.txt", "uv.lock"]);
  });

  it("announces a decision to attempt once, and never for a skipped ticket", async () => {
    const announced: string[] = [];
    const run = harness();
    run.deps.started = (decision) => void announced.push(decision.reason);
    const first = await runAttempt(base(), run.deps);
    assert.deepEqual(announced, ["never attempted"]);
    await runAttempt(base(first.state), run.deps);
    assert.deepEqual(announced, ["never attempted"]);
  });

  it("stops before the next unit when asked to, recording nothing so the ticket is attempted again", async () => {
    const run = harness();
    let stop = false;
    run.deps.shouldStop = () => stop;
    const work = run.deps.workUnit;
    run.deps.workUnit = async (unit, headSha) => {
      stop = true;
      return work(unit, headSha);
    };
    let saved = 0;
    run.deps.saveState = () => void saved++;
    await assert.rejects(runAttempt(base(), run.deps), ShutdownRequested);
    assert.deepEqual(run.worked, ["package-lock.json"]);
    assert.deepEqual(run.comments, []);
    assert.equal(saved, 0);
  });

  it("does nothing when an open pull request from the last attempt exists, without fetching", async () => {
    const attempted = (await runAttempt(base(), harness().deps)).state;
    const run = harness();
    const result = await runAttempt(base(attempted), run.deps);
    assert.equal(result.skipped, true);
    assert.match(result.decision.reason, /open pull request/);
    assert.deepEqual(run.statusCalls, ["https://github.com/acme-org/acme-api/pull/1", "https://github.com/acme-org/acme-api/pull/2"]);
    assert.equal(run.fetched, 0);
    assert.deepEqual(run.worked, []);
    assert.deepEqual(run.comments, []);
    assert.equal(result.state, attempted);
  });

  it("does nothing for the same body when the pull requests were merged or closed", async () => {
    const attempted = (await runAttempt(base(), harness().deps)).state;
    const run = harness({ statuses: { "https://github.com/acme-org/acme-api/pull/1": "merged", "https://github.com/acme-org/acme-api/pull/2": "closed" } });
    const result = await runAttempt(base(attempted), run.deps);
    assert.equal(result.skipped, true);
    assert.match(result.decision.reason, /already attempted/);
    assert.deepEqual(run.worked, []);
  });

  it("works the ticket again when forced, even with an open pull request", async () => {
    const attempted = (await runAttempt(base(), harness().deps)).state;
    const run = harness();
    const result = await runAttempt(base(attempted, { force: true }), run.deps);
    assert.equal(result.skipped, false);
    assert.deepEqual(run.worked, ["package-lock.json", "web/package-lock.json"]);
  });

  it("works the ticket again when its body changed and nothing is open", async () => {
    const earlier = recordAttempt(emptyState(), 12, { bodyHash: "old", headSha: "a", attemptedAt: "x", outcome: "gave-up", prUrls: [] });
    const run = harness();
    const result = await runAttempt(base(earlier), run.deps);
    assert.equal(result.skipped, false);
    assert.equal(run.worked.length, 2);
  });

  it("queues the ready pull requests marked for announcing when announcing is on, and nothing when it is off", async () => {
    const facts = { title: "Bump minimist to 1.2.6", major: false, lockfile: "package-lock.json", packages: [{ name: "minimist", from: "1.2.5", to: "1.2.6" }] };
    const work = async (unit: PrUnit): Promise<UnitResult> =>
      unit.source === "package-lock.json"
        ? { outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/1", draft: false, announce: "new", facts } }
        : { outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/2", draft: true, announce: null, facts } };
    const on = harness({ work });
    on.deps.announce = true;
    const queued = await runAttempt(base(), on.deps);
    assert.deepEqual(pendingAnnouncement(queued.state, 12), {
      prs: [{ url: "https://github.com/acme-org/acme-api/pull/1", reason: "new", facts }],
      queuedAt: "2026-02-03T04:05:06.000Z",
      attempts: 0,
      nextAt: "2026-02-03T04:05:06.000Z",
      lastError: null,
    });
    const off = await runAttempt(base(), harness({ work }).deps);
    assert.equal(pendingAnnouncement(off.state, 12), undefined);
    const local = harness({ work });
    local.deps.announce = true;
    assert.equal(pendingAnnouncement((await runAttempt(base(emptyState(), { local: true }), local.deps)).state, 12), undefined);
  });

  it("in local mode ignores the decision and writes no comment and no state", async () => {
    const attempted = (await runAttempt(base(), harness().deps)).state;
    const run = harness();
    const result = await runAttempt(base(attempted, { local: true }), run.deps);
    assert.deepEqual(run.worked, ["package-lock.json", "web/package-lock.json"]);
    assert.deepEqual(run.comments, []);
    assert.deepEqual(run.statusCalls, []);
    assert.equal(result.state, attempted);
  });

  it("records the attempt even when the comment cannot be posted, then reports the failure", async () => {
    const run = harness({ commentFails: true });
    let saved: State | undefined;
    run.deps.saveState = (state) => void (saved = state);
    await assert.rejects(runAttempt(base(), run.deps), /comment api down/);
    assert.equal(saved!.tickets["12"]!.attempt!.outcome, "pr-opened");
  });

  it("saves the state through the dependency after the comment", async () => {
    const run = harness();
    const order: string[] = [];
    const post = run.deps.postComment;
    run.deps.postComment = async (body) => {
      order.push("comment");
      await post(body);
    };
    run.deps.saveState = () => void order.push("state");
    await runAttempt(base(), run.deps);
    assert.deepEqual(order, ["comment", "state"]);
  });

  it("reports an image ticket as unsupported without working any unit", async () => {
    const image = {
      number: 13,
      key: "docker.elastic.co/kibana/kibana",
      repo: "acme-infra",
      body: renderBody("docker.elastic.co/kibana/kibana", [finding({ repo: "acme-infra", imageKey: "docker.elastic.co/kibana/kibana", ecosystem: "os", source: "docker.elastic.co/kibana/kibana" })], ENRICHMENT, { org: "acme-org", maintainedIn: "acme-ops" }),
    };
    const run = harness();
    const result = await runAttempt({ ticket: image, force: false, state: emptyState(), local: false }, run.deps);
    assert.deepEqual(run.worked, []);
    assert.match(run.comments[0]!, /no pull request: image tickets are not attempted yet/);
    assert.equal(result.state.tickets["13"]!.attempt!.outcome, "gave-up");
  });

  it("does nothing for an ignored ticket: no fetch, no unit, no comment, no state change", async () => {
    const ignored = recordIgnored(emptyState(), 12, true);
    const run = harness();
    const result = await runAttempt(base(ignored), run.deps);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.decision, { attempt: false, reason: "ignored by a comment command" });
    assert.equal(run.fetched, 0);
    assert.deepEqual(run.worked, []);
    assert.deepEqual(run.comments, []);
    assert.equal(result.state, ignored);
  });

  it("skips an ignored ticket after a pull request is open, and when its body changes", async () => {
    const attempted = (await runAttempt(base(), harness().deps)).state;
    const ignored = recordIgnored(attempted, 12, true);
    const run = harness();
    assert.equal((await runAttempt(base(ignored), run.deps)).skipped, true);
    const changed = { ...TWO_LOCKFILES, body: `${TWO_LOCKFILES.body}\nchanged` };
    assert.equal((await runAttempt({ ...base(ignored), ticket: changed }, run.deps)).skipped, true);
    assert.deepEqual(run.worked, []);
    assert.equal(run.fetched, 0);
  });

  it("attempts an ignored ticket again once fix cleared the flag and forced it", async () => {
    const cleared = recordIgnored(recordIgnored(emptyState(), 12, true), 12, false);
    const run = harness();
    const result = await runAttempt(base(cleared, { force: true }), run.deps);
    assert.equal(result.skipped, false);
    assert.equal(run.worked.length, 2);
  });
});
