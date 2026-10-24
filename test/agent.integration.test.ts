import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_BUDGET, DEFAULT_OLLAMA, DEFAULT_PROXY_ALLOW, DEFAULT_SANDBOX_LIMITS, type FixerConfig } from "../src/core/config.ts";
import { compareVersions } from "../src/core/versions.ts";
import { renderBody } from "../src/core/ticket.ts";
import type { Enrichment, Finding } from "../src/core/types.ts";
import type { Advisory } from "../src/fixer/advisories.ts";
import { OllamaClient } from "../src/fixer/agent/ollama.ts";
import { runAttempt, type AttemptResult } from "../src/fixer/attempt.ts";
import { GitStore } from "../src/fixer/git.ts";
import { Docker } from "../src/fixer/sandbox/docker.ts";
import { emptyState, type State } from "../src/fixer/state.ts";
import { workUnit, type PublishRequest, type Publisher } from "../src/fixer/unit.ts";

const run = promisify(execFile);
const enabled = process.env["PROSECO_AGENT_TESTS"] === "1";

interface Scenario {
  fixture: string;
  finding: Finding;
  branch: string;
  advisory: Advisory;
}

const NPM: Scenario = {
  fixture: "agent-npm",
  branch: "proseco/package-lock.json",
  finding: {
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
  },
  advisory: {
    id: "GHSA-xvch-5gv4-984h",
    summary: "Prototype pollution in minimist",
    severity: "critical",
    vulnerableRange: "< 1.2.6",
    patchedVersion: "1.2.6",
    affectedFunctions: [],
    references: [],
  },
};

const REQUESTS_ADVISORY: Advisory = {
  id: "GHSA-9wx4-h78v-vm56",
  summary: "Requests Session object does not verify requests after making first request with verify=False",
  severity: "medium",
  vulnerableRange: "< 2.32.0",
  patchedVersion: "2.32.0",
  affectedFunctions: [],
  references: [],
};

function requestsScenario(fixture: string, source: string, branch: string): Scenario {
  return {
    fixture,
    branch,
    finding: {
      origin: "dependabot",
      repo: "acme-api",
      cve: "CVE-2024-35195",
      severity: "high",
      ecosystem: "pip",
      package: "requests",
      installed: "2.31.0",
      fixedIn: "2.32.0",
      source,
      relationship: null,
      scope: null,
      imageKey: null,
    },
    advisory: REQUESTS_ADVISORY,
  };
}

const UV = requestsScenario("agent-uv", "uv.lock", "proseco/uv-lock");
const REQUIREMENTS = requestsScenario("agent-requirements", "requirements.txt", "proseco/requirements.txt");

const ENRICHMENT: Enrichment = { epss: new Map(), kev: new Set() };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
}

async function leftovers(): Promise<string[]> {
  const containers = (await run("docker", ["ps", "--all", "--quiet", "--filter", "label=proseco.attempt"])).stdout.split("\n").filter(Boolean);
  const networks = (await run("docker", ["network", "ls", "--quiet", "--filter", "label=proseco.attempt"])).stdout.split("\n").filter(Boolean);
  return [...containers, ...networks];
}

interface Result {
  outcome: AttemptResult;
  captured: PublishRequest[];
  comments: string[];
  state: State | undefined;
}

function origin(workspace: string, fixture: string): string {
  const seed = join(workspace, "seed");
  mkdirSync(seed);
  cpSync(join(import.meta.dirname, "fixtures", fixture), seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "fixture");
  const bare = join(workspace, "origin.git");
  git(workspace, "clone", "-q", "--bare", seed, bare);
  return bare;
}

async function attempt(scenario: Scenario, workspace: string): Promise<Result> {
  const bare = origin(workspace, scenario.fixture);
  const fixer: FixerConfig = {
    bot: "acme-proseco",
    app: { clientId: "Iv1.acme", installationId: 1 },
    cloneDir: join(workspace, "clones"),
    stateFile: join(workspace, "state.json"),
    pollMinutes: 1,
    proxy: { allow: DEFAULT_PROXY_ALLOW },
    sandbox: DEFAULT_SANDBOX_LIMITS,
    ollama: DEFAULT_OLLAMA,
    budget: DEFAULT_BUDGET,
  };
  const store = new GitStore({ cloneDir: fixer.cloneDir, remoteUrl: () => bare });
  const llm = new OllamaClient({
    url: fixer.ollama.url,
    model: fixer.ollama.model,
    numCtx: fixer.ollama.numCtx,
    numPredict: fixer.ollama.numPredict,
    think: fixer.ollama.think,
    timeoutMs: fixer.ollama.timeoutMinutes * 60_000,
  });
  const result: Result = { outcome: undefined as never, captured: [], comments: [], state: undefined };
  const publisher: Publisher = {
    async publish(request) {
      result.captured.push(request);
      return { url: "https://github.com/acme-org/acme-api/pull/1", draft: request.draft };
    },
  };
  const body = renderBody("acme-api", [scenario.finding], ENRICHMENT, { org: "acme-org", maintainedIn: "acme-ops" });
  result.outcome = await runAttempt(
    { ticket: { number: 12, key: "acme-api", repo: "acme-api", body }, force: false, state: emptyState(), local: false },
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
            advisory: async () => scenario.advisory,
            publisher,
            keepCheckout: false,
            log: (message) => console.error(`[agent] ${message}`),
          },
          unit,
          headSha,
        ),
      postComment: async (comment) => void result.comments.push(comment),
      saveState: (next) => void (result.state = next),
      now: () => new Date(),
    },
  );
  const [report] = result.outcome.reports;
  console.log(`agent stats: ${JSON.stringify(report?.result.stats)}`);
  console.log(`tool calls: ${report?.result.trace?.map((entry) => `${entry.tool}(${entry.args})`).join("\n  ")}`);
  const [request] = result.captured;
  if (request) console.log(`commit files: ${request.commit.files.join(", ")}\nsummary: ${request.summary}\ndiff:\n${request.diff}\nbody:\n${request.body}`);
  if (report?.outcome.kind !== "pr") console.log(`last tool calls: ${JSON.stringify(report?.result.trace?.slice(-5), null, 2)}\noutcome: ${JSON.stringify(report?.outcome)}`);
  return result;
}

function endToEnd(name: string, scenario: Scenario, extra: (captured: () => PublishRequest) => void): void {
  describe(name, { skip: !enabled && "set PROSECO_AGENT_TESTS=1 to run against Docker and Ollama" }, () => {
    const workspace = mkdtempSync(join(tmpdir(), "proseco-agent-"));
    let result: Result;

    before(async () => {
      result = await attempt(scenario, workspace);
    });

    after(async () => {
      rmSync(workspace, { recursive: true, force: true });
    });

    const captured = () => result.captured[0]!;

    it("opens a ready pull request for the fixture ticket", () => {
      const [report] = result.outcome.reports;
      assert.equal(report?.outcome.kind, "pr", `outcome: ${JSON.stringify(report?.outcome)}; last tool calls: ${JSON.stringify(report?.result.trace?.slice(-5))}`);
      assert.equal(result.captured.length, 1);
      assert.equal(captured().draft, false);
      assert.equal(captured().branch, scenario.branch);
    });

    it(`passes the lockfile check for ${scenario.finding.package} at ${scenario.finding.fixedIn} or above`, () => {
      const [check] = captured().checks;
      assert.equal(check!.package, scenario.finding.package);
      assert.equal(check!.ok, true, check!.reason);
      assert.ok(check!.installed.length > 0);
    });

    extra(captured);

    it("reports passing tests, a body that names the ticket and the CVE, and a surviving summary", () => {
      assert.equal(captured().tests.kind, "passed");
      assert.match(captured().body, /Part of acme-org\/acme-tickets#12/);
      assert.match(captured().body, new RegExp(scenario.finding.cve));
      assert.ok(captured().summary.trim().length > 0, "the verified summary is empty");
    });

    it("comments on the ticket and records the attempt", () => {
      assert.equal(result.comments.length, 1);
      assert.match(result.comments[0]!, /pull\/1/);
      assert.equal(result.state!.tickets["12"]!.attempt!.outcome, "pr-opened");
    });

    it("leaves no container, network or checkout behind", async () => {
      assert.deepEqual(await leftovers(), []);
    });
  });
}

function atLeast(version: string, floor: string): boolean {
  return compareVersions(version, floor) !== null && compareVersions(version, floor)! >= 0;
}

function commandsOf(request: PublishRequest): string[] {
  return "commands" in request.tests ? request.tests.commands : [];
}

endToEnd("agent end to end: npm", NPM, (captured) => {
  it("commits only package.json and package-lock.json", () => {
    assert.deepEqual([...captured().commit.files].sort(), ["package-lock.json", "package.json"]);
  });
});

endToEnd("agent end to end: uv", UV, (captured) => {
  it("locks requests at 2.32.0 or above", () => {
    assert.ok(captured().checks[0]!.installed.every((version) => atLeast(version, "2.32.0")), JSON.stringify(captured().checks));
  });

  it("commits only pyproject.toml and uv.lock", () => {
    assert.deepEqual([...captured().commit.files].sort(), ["pyproject.toml", "uv.lock"]);
  });

  it("ran uv sync --frozen and uv run pytest in the harness", () => {
    assert.deepEqual(commandsOf(captured()), ["uv sync --frozen", "uv run pytest -x -q"]);
  });
});

endToEnd("agent end to end: requirements.txt", REQUIREMENTS, (captured) => {
  it("pins requests at 2.32.0 or above", () => {
    assert.ok(captured().checks[0]!.installed.every((version) => atLeast(version, "2.32.0")), JSON.stringify(captured().checks));
  });

  it("commits only requirements.txt", () => {
    assert.deepEqual([...captured().commit.files], ["requirements.txt"]);
  });

  it("ran pip install and pytest in the harness", () => {
    const commands = commandsOf(captured());
    assert.equal(commands.length, 2);
    assert.match(commands[0]!, /^python -m pip install -r requirements\.txt$/);
    assert.match(commands[1]!, /^python -m pytest/);
  });
});
