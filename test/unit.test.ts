import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_BUDGET, DEFAULT_OLLAMA, DEFAULT_PROXY_ALLOW, DEFAULT_SANDBOX_LIMITS, type FixerConfig } from "../src/core/config.ts";
import type { ChatMessage, ChatResult, OllamaClient, ToolDefinition } from "../src/fixer/agent/ollama.ts";
import type { Ecosystem } from "../src/fixer/ecosystems/ecosystem.ts";
import { GitStore } from "../src/fixer/git.ts";
import type { PrUnit } from "../src/fixer/plan.ts";
import type { Docker, ExecResult } from "../src/fixer/sandbox/docker.ts";
import { workUnit, type PublishRequest, type UnitContext } from "../src/fixer/unit.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
}

const LOCKFILE = "svc/fake.lock";

function fakeEcosystem(overrides: Partial<Ecosystem> = {}, tests = true): Ecosystem {
  return {
    name: "uv",
    findingEcosystem: "fake",
    toolchainFiles: ["toolchain.txt"],
    imageFamily: "python",
    notes: "Ecosystem notes (fake): resolve with fake-resolve.",
    installedVersions(text) {
      return new Map(text.split("\n").filter(Boolean).map((line) => [line.split("==")[0]!, [line.split("==")[1]!]]));
    },
    parentChain: () => null,
    toolchainVersion: (files) => files["toolchain.txt"]?.trim() ?? null,
    allowedFiles: (lockfile) => [lockfile, join(dirname(lockfile), "fake.manifest")],
    harness: () => ({ install: "fake-install", test: "fake-test", hasTests: () => tests }),
    unsupported: () => null,
    ...overrides,
  };
}

async function origin(): Promise<{ store: GitStore; head: string }> {
  const remote = mkdtempSync(join(tmpdir(), "proseco-unit-origin-"));
  git(remote, "init", "-q", "-b", "main");
  const files = { [LOCKFILE]: "pkg==1.0.0\nother==3.0.0\n", "svc/fake.manifest": "pkg>=1\n", "svc/toolchain.txt": "3.12\n", "svc/app.py": "print()\n" };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(remote, file)), { recursive: true });
    writeFileSync(join(remote, file), content);
  }
  git(remote, "add", ".");
  git(remote, "commit", "-q", "-m", "init");
  const store = new GitStore({ cloneDir: mkdtempSync(join(tmpdir(), "proseco-unit-clones-")), remoteUrl: () => remote });
  await store.fetch("acme-api");
  return { store, head: await store.headSha("acme-api") };
}

const UNIT: PrUnit = {
  kind: "lockfile",
  source: LOCKFILE,
  ecosystem: "uv",
  branch: "proseco/svc-fake.lock",
  fixes: [{ package: "pkg", installed: "1.0.0", target: ["2.0.0"], severity: "high", rows: [{ cve: "CVE-2026-0001", severity: "high", package: "pkg", installed: "1.0.0", fixedIn: "2.0.0", source: LOCKFILE, epssPercent: null, kev: false }] }],
};

const FINISH = { function: { name: "finish", arguments: { summary: "Bumped pkg.", changes: [{ package: "pkg", from: "1.0.0", to: "2.0.0", how: "direct-bump" }] } } };

function write(path: string, content: string) {
  return { function: { name: "write_file", arguments: { path, content } } };
}

interface Run {
  published: PublishRequest[];
  commands: string[];
  images: string[];
  started: number;
  prompts: string[];
}

async function run(options: { ecosystem: Ecosystem; edits?: ReturnType<typeof write>[]; exits?: Record<string, number> }): Promise<{ result: Awaited<ReturnType<typeof workUnit>>; seen: Run }> {
  const { store, head } = await origin();
  const seen: Run = { published: [], commands: [], images: [], started: 0, prompts: [] };
  const steps: ChatResult["message"]["tool_calls"][] = [
    options.edits ?? [write(LOCKFILE, "pkg==2.0.0\nother==3.0.0\n"), write("svc/fake.manifest", "pkg>=2\n"), write("svc/app.py", "changed\n"), write("svc/new.txt", "x\n")],
    [FINISH],
  ];
  const llm = {
    withThink: () => llm,
    withTemperature: () => llm,
    async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
      const usage = { promptTokens: 10, outputTokens: 1, durationMs: 1, truncated: false };
      if (tools.length === 0) return { message: { role: "assistant", content: "Bumped pkg." }, usage };
      seen.prompts.push(messages[0]!.content);
      return { message: { role: "assistant", content: "", tool_calls: steps.shift() }, usage };
    },
  } as unknown as OllamaClient;
  const docker = {
    async imageExists(reference: string) {
      seen.images.push(reference);
      return true;
    },
  } as unknown as Docker;
  const fixer: FixerConfig = {
    bot: "acme-proseco",
    app: { clientId: "Iv1.acme", installationId: 1 },
    cloneDir: "unused",
    stateFile: "unused",
    pollMinutes: 1,
    proxy: { allow: DEFAULT_PROXY_ALLOW },
    sandbox: DEFAULT_SANDBOX_LIMITS,
    ollama: DEFAULT_OLLAMA,
    budget: DEFAULT_BUDGET,
  };
  const ctx: UnitContext = {
    org: "acme-org",
    ticketsRepo: "acme-tickets",
    ticket: 12,
    repo: "acme-api",
    bot: fixer.bot,
    store,
    docker,
    fixer,
    llm,
    advisory: async () => null,
    publisher: {
      async publish(request) {
        seen.published.push(request);
        return { url: "https://github.com/acme-org/acme-api/pull/1", draft: request.draft };
      },
    },
    keepCheckout: false,
    ecosystemFor: () => options.ecosystem,
    startSandbox: async () => {
      seen.started++;
      return {
        async run(command): Promise<ExecResult> {
          seen.commands.push(command[2]!);
          const failed = Object.entries(options.exits ?? {}).find(([step]) => command[2]!.endsWith(step));
          return { exitCode: failed?.[1] ?? 0, stdout: "out\n", stderr: "", truncated: false, timedOut: false };
        },
        async stop() {},
      };
    },
    log: () => {},
  };
  return { result: await workUnit(ctx, UNIT, head), seen };
}

describe("workUnit with an ecosystem behind the interface", () => {
  it("uses the ecosystem's image family, notes, allowed files, check and harness, in the lockfile's directory", async () => {
    const { result, seen } = await run({ ecosystem: fakeEcosystem() });
    assert.equal(result.outcome.kind, "pr");
    assert.deepEqual(seen.images, ["proseco/python:3.12"]);
    assert.match(seen.prompts[0]!, /Ecosystem notes \(fake\): resolve with fake-resolve\./);
    assert.deepEqual(seen.commands, ["cd '/work/svc' && fake-install", "cd '/work/svc' && fake-test"]);
    const [request] = seen.published;
    assert.deepEqual([...request!.commit.files].sort(), ["svc/fake.lock", "svc/fake.manifest"]);
    assert.equal(request!.draft, false);
    assert.deepEqual(request!.tests, { kind: "passed", commands: ["fake-install", "fake-test"], tail: "out\n" });
    assert.match(request!.body, /`fake-install` and `fake-test` passed in the sandbox/);
    assert.match(request!.body, /`svc\/app\.py`/);
  });

  it("runs only the install when the ecosystem finds no tests", async () => {
    const { seen } = await run({ ecosystem: fakeEcosystem({}, false) });
    assert.deepEqual(seen.commands, ["cd '/work/svc' && fake-install"]);
    assert.deepEqual(seen.published[0]!.tests, { kind: "no-tests", commands: ["fake-install"], tail: "" });
    assert.equal(seen.published[0]!.draft, false);
  });

  it("opens a draft that names the failing command when the tests fail", async () => {
    const { seen } = await run({ ecosystem: fakeEcosystem(), exits: { "fake-test": 3 } });
    const [request] = seen.published;
    assert.equal(request!.draft, true);
    assert.deepEqual(request!.tests, { kind: "failed", step: "fake-test", exitCode: 3, timedOut: false, tail: "out\n" });
    assert.match(request!.body, /Draft: `fake-test` failed with exit code 3/);
  });

  it("reports an unsupported lockfile without starting a sandbox", async () => {
    const { result, seen } = await run({ ecosystem: fakeEcosystem({ unsupported: () => "hash-pinned, not supported" }) });
    assert.deepEqual(result.outcome, { kind: "none", reason: "hash-pinned, not supported" });
    assert.equal(seen.started, 0);
    assert.deepEqual(seen.images, []);
  });

  it("publishes nothing when the ecosystem's check fails after the agent's edit", async () => {
    const { result, seen } = await run({ ecosystem: fakeEcosystem(), edits: [write(LOCKFILE, "pkg==1.5.0\n")] });
    assert.equal(result.outcome.kind, "none");
    assert.match((result.outcome as { reason: string }).reason, /lockfile check failed: pkg: installed 1\.5\.0 is below 2\.0\.0/);
    assert.deepEqual(seen.published, []);
    assert.deepEqual(seen.commands, []);
  });
});
