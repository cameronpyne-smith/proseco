import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path/posix";
import type { FixerConfig } from "../core/config.ts";
import type { Advisory } from "./advisories.ts";
import type { UnitResult } from "./attempt.ts";
import { checkLockfile, checkPassed, type PackageCheck } from "./check.ts";
import { declaredToolchain } from "./dryrun.ts";
import { ecosystemFor, type Ecosystem } from "./ecosystems/ecosystem.ts";
import { buildFacts } from "./facts.ts";
import type { GitStore } from "./git.ts";
import { runLoop } from "./agent/loop.ts";
import type { OllamaClient } from "./agent/ollama.ts";
import { systemPrompt, userPrompt } from "./agent/prompts.ts";
import { executeTool, TOOL_DEFINITIONS } from "./agent/tools.ts";
import { verifySummary } from "./agent/verify.ts";
import { commitMessage, renderPrBody, summariseDiscarded, type TestOutcome } from "./pr.ts";
import type { PrUnit } from "./plan.ts";
import { allowedFiles, commitAllowed, discardOthers, type CommitResult } from "./publish.ts";
import { Docker, type ExecResult } from "./sandbox/docker.ts";
import { ensureImage, imageFor } from "./sandbox/images.ts";
import { Sandbox, type StartOptions } from "./sandbox/sandbox.ts";

export interface SandboxHandle {
  run(command: string[], timeoutMs: number): Promise<ExecResult>;
  stop(): Promise<void>;
}

export interface PublishRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  checkout: string;
  commit: CommitResult;
  diff: string;
  checks: PackageCheck[];
  tests: TestOutcome;
  summary: string;
}

export interface Publisher {
  publish(request: PublishRequest): Promise<{ url: string; draft: boolean } | null>;
}

export interface UnitContext {
  org: string;
  ticketsRepo: string;
  ticket: number;
  repo: string;
  bot: string;
  store: GitStore;
  docker: Docker;
  fixer: FixerConfig;
  llm: OllamaClient;
  advisory(cve: string, pkg: string): Promise<Advisory | null>;
  publisher: Publisher;
  keepCheckout: boolean;
  ecosystemFor?(lockfile: string): Ecosystem | null;
  startSandbox?(options: StartOptions): Promise<SandboxHandle>;
  log(message: string): void;
}

const MS_PER_MINUTE = 60_000;

function none(reason: string, extra: Partial<UnitResult> = {}): UnitResult {
  return { outcome: { kind: "none", reason }, ...extra };
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function combined(result: ExecResult): string {
  return `${result.stdout}${result.stderr}`;
}

function readIfPresent(checkout: string): (path: string) => string | null {
  return (path) => {
    try {
      return readFileSync(join(checkout, path), "utf8");
    } catch {
      return null;
    }
  };
}

async function harness(sandbox: SandboxHandle, ecosystem: Ecosystem, lockfile: string, checkout: string, commandMs: number): Promise<TestOutcome> {
  const plan = ecosystem.harness(lockfile);
  const directory = dirname(lockfile);
  const prefix = directory === "." ? "" : `cd ${shellQuote(`/work/${directory}`)} && `;
  const install = await sandbox.run(["sh", "-c", `${prefix}${plan.install}`], commandMs);
  if (install.exitCode !== 0) return { kind: "failed", step: plan.install, exitCode: install.exitCode, timedOut: install.timedOut, tail: combined(install) };
  if (!plan.hasTests(readIfPresent(checkout))) return { kind: "no-tests", commands: [plan.install], tail: "" };
  const test = await sandbox.run(["sh", "-c", `${prefix}${plan.test}`], commandMs);
  if (test.exitCode !== 0) return { kind: "failed", step: plan.test, exitCode: test.exitCode, timedOut: test.timedOut, tail: combined(test) };
  return { kind: "passed", commands: [plan.install, plan.test], tail: combined(test) };
}

async function diffOf(ctx: UnitContext, checkout: string, base: string, commit: CommitResult, lockfile: string): Promise<string> {
  const files = [...commit.files].sort((a, b) => Number(a === lockfile) - Number(b === lockfile) || (a < b ? -1 : 1));
  const parts: string[] = [];
  for (const file of files) {
    parts.push(await ctx.store.inCheckout(checkout, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", file], "git diff"));
  }
  return parts.join("\n");
}

export async function workUnit(ctx: UnitContext, unit: PrUnit, headSha: string): Promise<UnitResult> {
  const ecosystem = (ctx.ecosystemFor ?? ecosystemFor)(unit.source);
  if (!ecosystem) return none("unsupported ecosystem: unknown lockfile type");
  const readFile = (path: string) => ctx.store.tryShow(ctx.repo, headSha, path);
  const lockfileText = await readFile(unit.source);
  if (lockfileText === null) return none(`${unit.source} does not exist at the default branch head`);
  const unsupported = ecosystem.unsupported(lockfileText);
  if (unsupported) return none(unsupported);
  const toolchain = await declaredToolchain(ecosystem, unit.source, readFile);
  const facts = await buildFacts(unit, ecosystem, lockfileText, toolchain, ctx.advisory);
  const image = await ensureImage(ctx.docker, imageFor(ecosystem.imageFamily, toolchain));
  const checkout = await ctx.store.checkout(ctx.repo, headSha);
  let sandbox: SandboxHandle | undefined;
  try {
    const start = ctx.startSandbox ?? ((options: StartOptions) => Sandbox.start(options));
    sandbox = await start({
      worktree: checkout,
      image,
      allow: ctx.fixer.proxy.allow,
      attemptId: `t${ctx.ticket}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      uid: process.getuid!(),
      gid: process.getgid!(),
      limits: ctx.fixer.sandbox,
      docker: ctx.docker,
    });
    const box = sandbox;
    const commandMs = ctx.fixer.budget.commandMinutes * MS_PER_MINUTE;
    const loop = await runLoop({
      llm: ctx.llm,
      numCtx: ctx.fixer.ollama.numCtx,
      headroom: ctx.fixer.ollama.numPredict,
      tools: TOOL_DEFINITIONS,
      execute: (name, args) =>
        executeTool(
          { root: checkout, commandTimeoutMs: commandMs, git: (gitArgs, okCodes) => ctx.store.inCheckout(checkout, gitArgs, "git", okCodes), run: (command, timeoutMs) => box.run(command, timeoutMs) },
          name,
          args,
        ),
      system: systemPrompt(ecosystem.notes),
      user: userPrompt(facts),
      timeBudgetMs: ctx.fixer.budget.minutes * MS_PER_MINUTE,
      maxToolCalls: ctx.fixer.budget.toolCalls,
    });
    const extra = { stats: loop.stats, trace: loop.trace, ...(ctx.keepCheckout ? { checkout } : {}) };
    ctx.log(`agent ${loop.outcome} after ${loop.stats.toolCalls} tool calls in ${Math.round(loop.stats.elapsedMs / 1000)} s`);
    if (loop.outcome !== "finished" || !loop.finish) {
      return none(`the agent gave up (${loop.outcome}${loop.error ? `: ${loop.error}` : ""})`, extra);
    }
    const allowed = allowedFiles(ecosystem, unit.source, lockfileText);
    const discarded = new Set(await discardOthers(ctx.store, checkout, headSha, allowed));

    let checks: PackageCheck[];
    try {
      checks = checkLockfile(ecosystem, readFileSync(join(checkout, unit.source), "utf8"), unit.fixes.map((fix) => ({ package: fix.package, target: fix.target })));
    } catch (error) {
      return none(`the lockfile cannot be read after the agent's changes: ${(error as Error).message}`, extra);
    }
    if (!checkPassed(checks)) {
      return none(`lockfile check failed: ${checks.filter((check) => !check.ok).map((check) => `${check.package}: ${check.reason}`).join("; ")}`, extra);
    }

    const tests = await harness(box, ecosystem, unit.source, checkout, commandMs);
    ctx.log(`harness: ${tests.kind}`);
    for (const path of await discardOthers(ctx.store, checkout, headSha, allowed)) discarded.add(path);

    const title = commitMessage(unit.source, unit.fixes);
    const commit = await commitAllowed(ctx.store, checkout, { bot: ctx.bot, message: title, allowed });
    if (!commit) return none("the agent made no change to the manifest or lockfile that could be committed", extra);
    const diff = await diffOf(ctx, checkout, headSha, commit, unit.source);
    const summary = await verifySummary(ctx.llm.withThink(false).withTemperature(0), loop.finish.summary, diff);
    const draft = tests.kind === "failed";
    const body = renderPrBody({
      org: ctx.org,
      ticketsRepo: ctx.ticketsRepo,
      ticket: ctx.ticket,
      lockfile: unit.source,
      fixes: unit.fixes.map((fix) => ({ package: fix.package, installed: fix.installed, target: fix.target, rows: fix.rows.map((row) => ({ cve: row.cve, severity: row.severity })) })),
      summary,
      checks,
      tests,
      discarded: summariseDiscarded([...discarded]),
    });
    const published = await ctx.publisher.publish({ repo: ctx.repo, branch: unit.branch, title, body, draft, checkout, commit, diff, checks, tests, summary });
    if (!published) return none("not published (local run)", extra);
    return { outcome: { kind: "pr", url: published.url, draft: published.draft }, ...extra };
  } finally {
    try {
      await sandbox?.stop();
    } catch (error) {
      ctx.log(`sandbox cleanup failed: ${(error as Error).message}`);
    }
    if (!ctx.keepCheckout) ctx.store.discard(checkout);
  }
}
