import type { UnitOutcomeReport } from "./comment.ts";
import { ShutdownRequested } from "./attempt.ts";
import type { FixRequest } from "./requests.ts";

export interface AttemptReport {
  skipped: boolean;
  reason: string;
  units: { label: string; outcome: UnitOutcomeReport }[];
}

export interface DaemonDeps {
  pollMs: number;
  find(): Promise<FixRequest[]>;
  attempt(request: FixRequest, started: () => void): Promise<AttemptReport>;
  deliver?(): Promise<void>;
  sleep(ms: number): Promise<void>;
  stopping(): boolean;
  log(line: string): void;
}

const IGNORED = "ignored by a comment command";

function describe(outcome: UnitOutcomeReport): string {
  return outcome.kind === "pr" ? `${outcome.draft ? "draft" : "ready"} ${outcome.url}` : `no pull request (${outcome.reason})`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deliver(deps: DaemonDeps): Promise<void> {
  try {
    await deps.deliver?.();
  } catch (error) {
    deps.log(`announcing in Teams failed: ${message(error)}`);
  }
}

export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const skips = new Map<number, string>();
  let previousWasBusy = true;
  while (!deps.stopping()) {
    let requests: FixRequest[];
    try {
      requests = await deps.find();
    } catch (error) {
      deps.log(`find failed: ${message(error)}`);
      if (!deps.stopping()) await deps.sleep(deps.pollMs);
      continue;
    }
    const open = new Set(requests.map((request) => request.number));
    for (const number of skips.keys()) if (!open.has(number)) skips.delete(number);
    const skip = (number: number, reason: string) => {
      if (skips.get(number) === reason) return;
      skips.set(number, reason);
      deps.log(`#${number} skipped: ${reason}`);
    };
    let busy = false;
    const urgent = (request: FixRequest) => Number(request.force || request.pulls.length > 0);
    const ordered = [...requests].sort((a, b) => urgent(b) - urgent(a) || a.number - b.number);
    for (const request of ordered) {
      if (deps.stopping()) break;
      const { number } = request;
      if (request.ignored) {
        skip(number, IGNORED);
        continue;
      }
      try {
        const report = await deps.attempt(request, () => {
          busy = true;
          deps.log(`#${number} attempting`);
        });
        if (report.skipped) {
          skip(number, report.reason);
          continue;
        }
        skips.delete(number);
        deps.log(`#${number} done: ${report.units.length === 0 ? "nothing to attempt" : report.units.map((unit) => `${unit.label}: ${describe(unit.outcome)}`).join("; ")}`);
        await deliver(deps);
      } catch (error) {
        skips.delete(number);
        if (error instanceof ShutdownRequested) {
          deps.log(`#${number} interrupted: ${error.message}`);
          break;
        }
        busy = true;
        deps.log(`#${number} failed: ${message(error)}`);
      }
    }
    await deliver(deps);
    if (!busy && previousWasBusy && !deps.stopping()) deps.log(`idle: nothing to attempt among ${requests.length} open ticket${requests.length === 1 ? "" : "s"}`);
    previousWasBusy = busy;
    if (!deps.stopping()) await deps.sleep(deps.pollMs);
  }
  deps.log("stopped");
}
