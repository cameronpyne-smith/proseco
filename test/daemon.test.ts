import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShutdownRequested } from "../src/fixer/attempt.ts";
import { runDaemon, type AttemptReport, type DaemonDeps } from "../src/fixer/daemon.ts";
import type { FixRequest } from "../src/fixer/requests.ts";

function request(number: number, overrides: Partial<FixRequest> = {}): FixRequest {
  return { number, key: "acme-api", repo: "acme-api", force: false, ignored: false, commentId: null, pulls: [], ...overrides };
}

const PR: AttemptReport = { skipped: false, reason: "never attempted", units: [{ label: "`package-lock.json`", outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/9", draft: false } }] };

interface Fixture {
  deps: DaemonDeps;
  log: string[];
  attempted: number[];
  passes: number;
  stop(): void;
}

function fixture(options: {
  passes: FixRequest[][] | ((pass: number) => FixRequest[] | Error);
  attempt?: (request: FixRequest, pass: number) => Promise<AttemptReport>;
  stopAfterPasses?: number;
}): Fixture {
  let stopping = false;
  const result: Fixture = { deps: undefined as never, log: [], attempted: [], passes: 0, stop: () => void (stopping = true) };
  result.deps = {
    pollMs: 60_000,
    find: async () => {
      const pass = result.passes++;
      const next = typeof options.passes === "function" ? options.passes(pass) : (options.passes[pass] ?? []);
      if (next instanceof Error) throw next;
      return next;
    },
    attempt: async (item, started) => {
      started();
      result.attempted.push(item.number);
      return options.attempt ? options.attempt(item, result.passes) : PR;
    },
    sleep: async () => {
      if (result.passes >= (options.stopAfterPasses ?? 1)) stopping = true;
    },
    stopping: () => stopping,
    log: (line) => void result.log.push(line),
  };
  return result;
}

describe("daemon loop", () => {
  it("works forced requests first, then the rest by ticket number", async () => {
    const run = fixture({ passes: [[request(3), request(1), request(7, { force: true }), request(2, { force: true })]] });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [2, 7, 1, 3]);
  });

  it("works tickets with a pull request redo among the forced ones", async () => {
    const redo = { url: "https://github.com/acme-org/acme-api/pull/9", number: 9, branch: "proseco/package-lock.json", headSha: "h", reason: "conflict" as const, requester: null, note: null };
    const run = fixture({ passes: [[request(3), request(1), request(7, { pulls: [redo] }), request(2, { force: true })]] });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [2, 7, 1, 3]);
  });

  it("logs one line per event: attempting, then done with the outcome of each unit", async () => {
    const run = fixture({
      passes: [[request(4)]],
      attempt: async () => ({
        skipped: false,
        reason: "never attempted",
        units: [
          { label: "`package-lock.json`", outcome: { kind: "pr", url: "https://github.com/acme-org/acme-api/pull/9", draft: true } },
          { label: "`web/package-lock.json`", outcome: { kind: "none", reason: "lockfile check failed" } },
        ],
      }),
    });
    await runDaemon(run.deps);
    assert.deepEqual(run.log.slice(0, 2), [
      "#4 attempting",
      "#4 done: `package-lock.json`: draft https://github.com/acme-org/acme-api/pull/9; `web/package-lock.json`: no pull request (lockfile check failed)",
    ]);
  });

  it("skips ignored tickets without attempting them, and says why", async () => {
    const run = fixture({ passes: [[request(1, { ignored: true }), request(2)]] });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [2]);
    assert.ok(run.log.includes("#1 skipped: ignored by a comment command"));
  });

  it("logs the decision's reason for a ticket the attempt skips, once until the reason changes", async () => {
    let reason = "an open pull request exists for the ticket";
    const run = fixture({
      passes: () => [request(5)],
      stopAfterPasses: 3,
      attempt: async () => {
        const current = reason;
        reason = "already attempted this ticket body (gave-up)";
        return { skipped: true, reason: current, units: [] };
      },
    });
    await runDaemon(run.deps);
    assert.deepEqual(
      run.log.filter((line) => line.startsWith("#5 skipped")),
      ["#5 skipped: an open pull request exists for the ticket", "#5 skipped: already attempted this ticket body (gave-up)"],
    );
  });

  it("logs a failure and carries on with the next ticket and the next pass", async () => {
    const run = fixture({
      passes: () => [request(1), request(2)],
      stopAfterPasses: 2,
      attempt: async (item) => {
        if (item.number === 1) throw new Error("docker went away");
        return PR;
      },
    });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [1, 2, 1, 2]);
    assert.ok(run.log.includes("#1 failed: docker went away"));
    assert.ok(run.log.includes("#2 attempting"));
  });

  it("stops after the ticket in progress when told to, without starting another", async () => {
    const run = fixture({
      passes: [[request(1), request(2), request(3)]],
      stopAfterPasses: 10,
      attempt: async (item) => {
        if (item.number === 1) run.stop();
        return PR;
      },
    });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [1]);
    assert.equal(run.passes, 1);
    assert.ok(run.log.includes("#1 done: `package-lock.json`: ready https://github.com/acme-org/acme-api/pull/9"));
  });

  it("stops without a failure line when the attempt reports a shutdown between units", async () => {
    const run = fixture({
      passes: [[request(1), request(2)]],
      stopAfterPasses: 10,
      attempt: async () => {
        run.stop();
        throw new ShutdownRequested();
      },
    });
    await runDaemon(run.deps);
    assert.deepEqual(run.attempted, [1]);
    assert.ok(run.log.includes("#1 interrupted: shutdown requested before the next unit"));
    assert.equal(run.log.some((line) => line.includes("failed")), false);
  });

  it("logs an idle pass once, until a pass finds something again", async () => {
    const run = fixture({
      passes: (pass) => (pass === 3 ? [request(8)] : []),
      stopAfterPasses: 6,
    });
    await runDaemon(run.deps);
    const idle = run.log.filter((line) => line.startsWith("idle"));
    assert.equal(idle.length, 2);
    assert.deepEqual(run.log.map((line) => line.split(":")[0]), ["idle", "#8 attempting", "#8 done", "idle", "stopped"]);
  });

  it("logs a failed find and retries at the next poll instead of exiting", async () => {
    const run = fixture({
      passes: (pass) => (pass < 2 ? new Error("GitHub is down") : [request(1)]),
      stopAfterPasses: 3,
    });
    await runDaemon(run.deps);
    assert.deepEqual(run.log.filter((line) => line.startsWith("find failed")), ["find failed: GitHub is down", "find failed: GitHub is down"]);
    assert.deepEqual(run.attempted, [1]);
  });

  it("delivers announcements after each finished attempt and once per pass, and logs a delivery failure without stopping", async () => {
    const run = fixture({ passes: [[request(1), request(2)], []], stopAfterPasses: 2 });
    const order: string[] = [];
    const attempt = run.deps.attempt;
    run.deps.attempt = async (item, started) => {
      order.push(`attempt ${item.number}`);
      return attempt(item, started);
    };
    let deliveries = 0;
    run.deps.deliver = async () => {
      order.push("deliver");
      if (++deliveries === 1) throw new Error("state file unreadable");
    };
    await runDaemon(run.deps);
    assert.deepEqual(order, ["attempt 1", "deliver", "attempt 2", "deliver", "deliver", "deliver"]);
    assert.ok(run.log.includes("announcing in Teams failed: state file unreadable"));
    assert.equal(run.log.at(-1), "stopped");
  });
});
