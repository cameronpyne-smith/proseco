import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
import { verifySummary, type DiffFile } from "./agent/verify.ts";
import { commitMessage, majorTitle, renderMajorPrBody, renderPrBody, summariseDiscarded, type PrFix, type TestOutcome } from "./pr.ts";
import type { PrUnit } from "./plan.ts";
import { allowedFiles, commitAllowed, discardOthers, majorGuard, type Allowed, type CommitResult } from "./publish.ts";
import type { ReleaseNotes } from "./releases.ts";
import { Docker, type ExecOptions, type ExecResult } from "./sandbox/docker.ts";
import { ensureImage, imageFor } from "./sandbox/images.ts";
import { Sandbox, WORK, type StartOptions } from "./sandbox/sandbox.ts";

export interface SandboxHandle {
  run(command: string[], timeoutMs: number, options?: ExecOptions): Promise<ExecResult>;
  load(directory: string): Promise<void>;
  save(directory: string): Promise<void>;
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
  releases?(ecosystem: string, pkg: string, installed: string, target: string): Promise<ReleaseNotes>;
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
  const prefix = directory === "." ? "" : `cd ${shellQuote(`${WORK}/${directory}`)} && `;
  const install = await sandbox.run(["sh", "-c", `${prefix}${plan.install}`], commandMs);
  if (install.exitCode !== 0) return { kind: "failed", step: plan.install, exitCode: install.exitCode, timedOut: install.timedOut, tail: combined(install) };
  if (!plan.hasTests(readIfPresent(checkout))) return { kind: "no-tests", commands: [plan.install], tail: "" };
  const test = await sandbox.run(["sh", "-c", `${prefix}${plan.test}`], commandMs);
  if (test.exitCode !== 0) return { kind: "failed", step: plan.test, exitCode: test.exitCode, timedOut: test.timedOut, tail: combined(test) };
  return { kind: "passed", commands: [plan.install, plan.test], tail: combined(test) };
}

async function diffFilesOf(ctx: UnitContext, checkout: string, base: string, commit: CommitResult, lockfile: string, manifests: Set<string> | null): Promise<DiffFile[]> {
  const rank = (file: string) => (manifests && !manifests.has(file) ? 2 : file === lockfile ? 1 : 0);
  const files = [...commit.files].sort((a, b) => (manifests ? rank(a) - rank(b) : Number(a === lockfile) - Number(b === lockfile)) || (a < b ? -1 : 1));
  const parts: DiffFile[] = [];
  for (const file of files) {
    const text = await ctx.store.inCheckout(checkout, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", file], "git diff");
    parts.push({ path: file, text, manifest: manifests ? manifests.has(file) : file === lockfile });
  }
  return parts;
}

function transcriptPath(ctx: UnitContext, unit: PrUnit): string {
  const directory = join(ctx.fixer.cloneDir, "transcripts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${ctx.ticket}-${unit.branch.replace(/[^A-Za-z0-9._-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
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
  const major = unit.kind === "major";
  const facts = await buildFacts(unit, ecosystem, lockfileText, toolchain, ctx.advisory, ctx.releases);
  const image = await ensureImage(ctx.docker, imageFor(ecosystem.imageFamily, toolchain));
  const checkout = await ctx.store.checkout(ctx.repo, headSha);
  let sandbox: SandboxHandle | undefined;
  try {
    const start = ctx.startSandbox ?? ((options: StartOptions) => Sandbox.start(options));
    sandbox = await start({
      image,
      allow: ctx.fixer.proxy.allow,
      attemptId: `t${ctx.ticket}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      limits: ctx.fixer.sandbox,
      docker: ctx.docker,
    });
    const box = sandbox;
    await box.load(checkout);
    const commandMs = ctx.fixer.budget.commandMinutes * MS_PER_MINUTE;
    const transcript = transcriptPath(ctx, unit);
    ctx.log(`transcript: ${transcript}`);
    const written = new Set<string>();
    const loop = await runLoop({
      llm: ctx.llm,
      finaliseWith: [ctx.llm.withLowThink(), ctx.llm.withThink(false)],
      record: (message) => appendFileSync(transcript, `${JSON.stringify(message)}\n`, { mode: 0o600 }),
      numCtx: ctx.fixer.ollama.numCtx,
      headroom: ctx.fixer.ollama.numPredict,
      tools: TOOL_DEFINITIONS,
      execute: (name, args) =>
        executeTool({ commandTimeoutMs: commandMs, run: (command, timeoutMs, options) => box.run(command, timeoutMs, options), wrote: (path) => written.add(path) }, name, args),
      system: systemPrompt(ecosystem.notes, unit.kind),
      user: userPrompt(facts),
      timeBudgetMs: (major ? ctx.fixer.budget.majorMinutes : ctx.fixer.budget.minutes) * MS_PER_MINUTE,
      maxToolCalls: ctx.fixer.budget.toolCalls,
    });
    await box.save(checkout);
    const extra = { stats: loop.stats, trace: loop.trace, transcript, ...(ctx.keepCheckout ? { checkout } : {}) };
    ctx.log(`agent ${loop.outcome}${loop.forced ? ` (forced after ${loop.forced})` : ""} after ${loop.stats.toolCalls} tool calls in ${Math.round(loop.stats.elapsedMs / 1000)} s`);
    if (loop.outcome !== "finished" || !loop.finish) {
      return none(`the agent gave up (${loop.outcome}${loop.error ? `: ${loop.error}` : ""})`, extra);
    }
    const manifests = allowedFiles(ecosystem, unit.source, lockfileText);
    const allowed: Allowed = major ? majorGuard({ written, ecosystem }) : manifests;
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

    await box.load(checkout);
    const tests = await harness(box, ecosystem, unit.source, checkout, commandMs);
    ctx.log(`harness: ${tests.kind}`);

    const prFixes: PrFix[] = unit.fixes.map((item) => ({ package: item.package, installed: item.installed, target: item.target, rows: item.rows.map((row) => ({ cve: row.cve, severity: row.severity })) }));
    const title = major ? majorTitle(prFixes[0]!) : commitMessage(unit.source, prFixes);
    const commit = await commitAllowed(ctx.store, checkout, { bot: ctx.bot, message: title, allowed });
    if (!commit) return none(major ? "the agent made no change that could be committed" : "the agent made no change to the manifest or lockfile that could be committed", extra);
    const diffFiles = await diffFilesOf(ctx, checkout, headSha, commit, unit.source, major ? manifests : null);
    const diff = diffFiles.map((file) => file.text).join("\n");
    const summary = await verifySummary(ctx.llm.withThink(false).withTemperature(0), loop.finish.summary, major ? diffFiles : diff);
    const draft = major || tests.kind === "failed" || loop.forced !== undefined;
    const common = { org: ctx.org, ticketsRepo: ctx.ticketsRepo, ticket: ctx.ticket, lockfile: unit.source, summary, checks, tests, discarded: summariseDiscarded([...discarded]) };
    const body = major
      ? renderMajorPrBody({ ...common, fix: prFixes[0]!, releases: facts.fixes[0]?.releases ?? null, codeChanged: commit.files.some((file) => !manifests.has(file)) })
      : renderPrBody({ ...common, fixes: prFixes });
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
