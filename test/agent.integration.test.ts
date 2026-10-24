import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_BUDGET, DEFAULT_OLLAMA, DEFAULT_PROXY_ALLOW, DEFAULT_SANDBOX_LIMITS, type FixerConfig } from "../src/core/config.ts";
import { renderBody } from "../src/core/ticket.ts";
import type { Enrichment, Finding } from "../src/core/types.ts";
import { OllamaClient } from "../src/fixer/agent/ollama.ts";
import { runAttempt, type AttemptResult } from "../src/fixer/attempt.ts";
import { GitStore } from "../src/fixer/git.ts";
import { Docker } from "../src/fixer/sandbox/docker.ts";
import { emptyState, type State } from "../src/fixer/state.ts";
import { workUnit, type PublishRequest, type Publisher } from "../src/fixer/unit.ts";

const run = promisify(execFile);
const enabled = process.env["PROSECO_AGENT_TESTS"] === "1";
const fixture = join(import.meta.dirname, "fixtures", "agent-npm");

const FINDING: Finding = {
  origin: "dependabot",
  repo: "acme-api",
  cve: "CVE-2021-44906",
  severity: "critical",
  ecosystem: "npm",
  package: "minimist",
  installed: "1.2.5",
  fixedIn: "1.2.6",
  source: "package-lock.json",
  relationship: null,
  scope: null,
  imageKey: null,
};
const ENRICHMENT: Enrichment = { epss: new Map(), kev: new Set() };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
}

async function leftovers(): Promise<string[]> {
  const containers = (await run("docker", ["ps", "--all", "--quiet", "--filter", "label=proseco.attempt"])).stdout.split("\n").filter(Boolean);
  const networks = (await run("docker", ["network", "ls", "--quiet", "--filter", "label=proseco.attempt"])).stdout.split("\n").filter(Boolean);
  return [...containers, ...networks];
}

describe("agent end to end", { skip: !enabled && "set PROSECO_AGENT_TESTS=1 to run against Docker and Ollama" }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "proseco-agent-"));
  const captured: PublishRequest[] = [];
  const comments: string[] = [];
  const logs: string[] = [];
  let outcome: AttemptResult;
  let state: State | undefined;

  before(async () => {
    const seed = join(workspace, "seed");
    mkdirSync(seed);
    cpSync(fixture, seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "fixture");
    const origin = join(workspace, "origin.git");
    git(workspace, "clone", "-q", "--bare", seed, origin);

    const fixer: FixerConfig = {
      bot: "acme-proseco",
      app: { clientId: "Iv1.acme", installationId: 1 },
      cloneDir: join(workspace, "clones"),
      stateFile: join(workspace, "state.json"),
      proxy: { allow: DEFAULT_PROXY_ALLOW },
      sandbox: DEFAULT_SANDBOX_LIMITS,
      ollama: DEFAULT_OLLAMA,
      budget: DEFAULT_BUDGET,
    };
    const store = new GitStore({ cloneDir: fixer.cloneDir, remoteUrl: () => origin });
    const llm = new OllamaClient({
      url: fixer.ollama.url,
      model: fixer.ollama.model,
      numCtx: fixer.ollama.numCtx,
      numPredict: fixer.ollama.numPredict,
      think: fixer.ollama.think,
      timeoutMs: fixer.ollama.timeoutMinutes * 60_000,
    });
    const publisher: Publisher = {
      async publish(request) {
        captured.push(request);
        return { url: "https://github.com/acme-org/acme-api/pull/1", draft: request.draft };
      },
    };
    const body = renderBody("acme-api", [FINDING], ENRICHMENT, { org: "acme-org", maintainedIn: "acme-ops" });
    outcome = await runAttempt(
      { ticket: { number: 12, repo: "acme-api", body }, force: false, state: emptyState(), local: false },
      {
        org: "acme-org",
        fetch: async () => {
          await store.fetch("acme-api");
          return store.headSha("acme-api");
        },
        prStatus: async (url) => ({ url, state: "open" }),
        workUnit: (unit, headSha) =>
          workUnit(
            {
              org: "acme-org",
              ticketsRepo: "acme-tickets",
              ticket: 12,
              repo: "acme-api",
              bot: fixer.bot,
              store,
              docker: new Docker(),
              fixer,
              llm,
              advisory: async () => ({
                id: "GHSA-xvch-5gv4-984h",
                summary: "Prototype pollution in minimist",
                severity: "critical",
                vulnerableRange: "< 1.2.6",
                patchedVersion: "1.2.6",
                affectedFunctions: [],
                references: [],
              }),
              publisher,
              keepCheckout: false,
              log: (message) => {
                logs.push(message);
                console.error(`[agent] ${message}`);
              },
            },
            unit,
            headSha,
          ),
        postComment: async (comment) => void comments.push(comment),
        saveState: (next) => void (state = next),
        now: () => new Date(),
      },
    );
    const [report] = outcome.reports;
    const stats = report?.result.stats;
    console.log(`agent stats: ${JSON.stringify(stats)}`);
    console.log(`tool calls: ${report?.result.trace?.map((entry) => `${entry.tool}(${entry.args})`).join("\n  ")}`);
    if (captured[0]) console.log(`commit files: ${captured[0].commit.files.join(", ")}\nsummary: ${captured[0].summary}\ndiff:\n${captured[0].diff}\nbody:\n${captured[0].body}`);
    if (report?.outcome.kind !== "pr") console.log(`last tool calls: ${JSON.stringify(report?.result.trace?.slice(-5), null, 2)}\noutcome: ${JSON.stringify(report?.outcome)}`);
  });

  after(async () => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("opens a ready pull request for the fixture ticket", () => {
    const [report] = outcome.reports;
    assert.equal(report?.outcome.kind, "pr", `outcome: ${JSON.stringify(report?.outcome)}; last tool calls: ${JSON.stringify(report?.result.trace?.slice(-5))}`);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.draft, false);
    assert.equal(captured[0]!.branch, "proseco/package-lock.json");
  });

  it("passes the lockfile check with minimist at 1.2.6 or above", () => {
    const [check] = captured[0]!.checks;
    assert.equal(check!.package, "minimist");
    assert.equal(check!.ok, true, check!.reason);
    assert.ok(check!.installed.length > 0);
  });

  it("commits only package.json and package-lock.json", () => {
    assert.deepEqual([...captured[0]!.commit.files].sort(), ["package-lock.json", "package.json"]);
  });

  it("reports passing tests, a body that names the ticket and the CVE, and a surviving summary", () => {
    assert.equal(captured[0]!.tests.kind, "passed");
    assert.match(captured[0]!.body, /Part of acme-org\/acme-tickets#12/);
    assert.match(captured[0]!.body, /CVE-2021-44906/);
    assert.ok(captured[0]!.summary.trim().length > 0, "the verified summary is empty");
  });

  it("comments on the ticket and records the attempt", () => {
    assert.equal(comments.length, 1);
    assert.match(comments[0]!, /pull\/1/);
    assert.equal(state!.tickets["12"]!.attempt!.outcome, "pr-opened");
  });

  it("leaves no container, network or checkout behind", async () => {
    assert.deepEqual(await leftovers(), []);
  });
});
