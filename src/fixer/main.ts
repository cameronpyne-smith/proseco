import { tokenProvider, type TokenProvider } from "../core/app.ts";
import { loadConfig, type Config, type FixerConfig } from "../core/config.ts";
import { TicketRepo } from "../core/github.ts";
import { isProsecoTicket, markerKey, markerRepo, parseRawTable } from "../core/ticket.ts";
import { pruneTranscripts } from "./transcripts.ts";
import { Advisories } from "./advisories.ts";
import { runDaemon } from "./daemon.ts";
import { dryRunReport } from "./dryrun.ts";
import { GitStore } from "./git.ts";
import { Docker } from "./sandbox/docker.ts";
import { exitCodeOf, formatOutcome, runInSandbox } from "./sandbox/command.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { commandComment } from "./requests.ts";
import { findTickets, runTicket, summarise } from "./run.ts";
import { allPassed, checkOllama, formatChecks, runChecks, type CheckResult, type StartupCheck } from "./startup.ts";
import { isIgnored, lastAttempt, lastCommentId, loadState } from "./state.ts";

const USAGE = "usage: fixer find | fixer read <ticket number> | fixer run <ticket number> [--dry-run | --local] | fixer sandbox <repo> <lockfile path> -- <command...> | fixer sandbox --sweep | fixer check | fixer serve";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ticketNumber(argument: string | undefined): number {
  const number = Number(argument);
  if (!Number.isInteger(number) || number <= 0) throw new Error(USAGE);
  return number;
}

async function fixableTicket(config: Config, tickets: TicketRepo, number: number): Promise<{ key: string; repo: string; body: string }> {
  const ticket = await tickets.get(number);
  if (!isProsecoTicket(ticket, config.tickets.find.creators)) {
    throw new Error(`#${number} is not a proseco ticket: it needs the marker on its first line and an author in tickets.find.creators`);
  }
  const repo = markerRepo(ticket.body);
  if (!repo) throw new Error(`#${number} is the unmapped images ticket, which has no repository to fix`);
  return { key: markerKey(ticket.body)!, repo, body: ticket.body };
}

async function attemptTicket(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number, local: boolean): Promise<void> {
  const { key, repo, body } = await fixableTicket(config, tickets, number);
  const result = await runTicket({ config, tokens, tickets: async () => tickets, number, key, repo, body, local });
  console.log(JSON.stringify(summarise(result, number), null, 2));
  if (local) for (const checkout of result.checkouts) console.log(`checkout left in place: ${checkout}`);
}

async function dryRun(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number): Promise<void> {
  const { key, repo, body } = await fixableTicket(config, tickets, number);
  if (key !== repo) throw new Error(`#${number} is an image ticket, and image tickets are not attempted yet`);
  const repoToken = await tokens({ repositories: [repo], permissions: { contents: "read" } });
  const store = new GitStore({ cloneDir: config.fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: repoToken });
  await store.fetch(repo);
  const headSha = await store.headSha(repo);
  const advisories = new Advisories(repoToken);
  const state = loadState(config.fixer.stateFile);
  const command = commandComment(await tickets.comments(number), config.app.bot, lastCommentId(state, number));
  const report = await dryRunReport({
    ticket: { number, repo, body, force: command?.command === "fix", ignored: command ? command.command === "ignore" : isIgnored(state, number), commandCommentId: command?.id ?? null },
    rows: parseRawTable(body),
    org: config.org,
    headSha,
    last: lastAttempt(state, number),
    readFile: (path) => store.tryShow(repo, headSha, path),
    advisory: (cve, pkg, installed) => advisories.lookup(cve, pkg, installed),
  });
  console.log(JSON.stringify(report, null, 2));
}

async function sandboxCommand(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, args: string[]): Promise<void> {
  if (args[0] === "--sweep") {
    const swept = await Sandbox.sweep();
    console.log(`removed ${swept.containers} containers and ${swept.networks} networks`);
    return;
  }
  const separator = args.indexOf("--");
  const [repo, lockfile] = args.slice(0, separator === -1 ? args.length : separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  if (!repo || !lockfile || command.length === 0) throw new Error(USAGE);
  const token = await tokens({ repositories: [repo], permissions: { contents: "read" } });
  const store = new GitStore({ cloneDir: config.fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token });
  const outcome = await runInSandbox({ store, repo, lockfile, command, fixer: config.fixer });
  console.log(formatOutcome(outcome));
  process.exitCode = exitCodeOf(outcome);
}

interface Prepared {
  results: CheckResult[];
  config: (Config & { fixer: FixerConfig }) | null;
  tokens: TokenProvider | null;
}

async function prepare(): Promise<Prepared> {
  let config: (Config & { fixer: FixerConfig }) | null = null;
  let tokens: TokenProvider | null = null;
  const loaded = () => config!;
  const checks: StartupCheck[] = [
    {
      name: "config",
      required: true,
      run: async () => {
        const path = requireEnv("PROSECO_CONFIG");
        const read = loadConfig(path);
        if (!read.fixer) throw new Error("the config has no fixer section");
        config = { ...read, fixer: read.fixer };
        tokens = tokenProvider(process.env, read.app);
        return `${path}: org ${read.org}, tickets repository ${read.tickets.repo}, bot ${read.app.bot}`;
      },
    },
    {
      name: "github",
      run: async () => {
        await tokens!({ repositories: [loaded().tickets.repo], permissions: { issues: "read" } });
        return `minted an installation token for ${loaded().org}/${loaded().tickets.repo}`;
      },
    },
    { name: "ollama", run: () => checkOllama(loaded().fixer.ollama.url, loaded().fixer.ollama.model) },
    { name: "docker", run: async () => `server ${await new Docker().info()} answers` },
  ];
  return { results: await runChecks(checks), config, tokens };
}

async function checkCommand(): Promise<void> {
  const { results } = await prepare();
  console.log(formatChecks(results));
  if (!allPassed(results)) process.exitCode = 1;
}

function stamped(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

async function serve(): Promise<void> {
  const { results, config, tokens } = await prepare();
  if (!allPassed(results) || !config || !tokens) {
    console.error(formatChecks(results));
    process.exitCode = 1;
    return;
  }
  stamped(`startup checks passed:\n${formatChecks(results)}`);
  const swept = await Sandbox.sweep(0);
  stamped(`removed ${swept.containers} containers and ${swept.networks} networks left by an earlier process`);
  const fixer = config.fixer;
  const pruned = pruneTranscripts(fixer.cloneDir, fixer.transcripts);
  stamped(`removed ${pruned.removed} old transcripts (${Math.round(pruned.freedBytes / 1024 / 1024)} MiB)`);
  const stop = new AbortController();
  const ticketRepo = async () => new TicketRepo(await tokens({ repositories: [config.tickets.repo], permissions: { issues: "write" } }), config.org, config.tickets.repo);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stop.signal.aborted) process.exit(1);
      stamped(`${signal}: finishing the current unit, then exiting; signal again to exit now`);
      stop.abort();
    });
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      stop.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  let bodies = new Map<number, string>();
  stamped(`polling every ${fixer.pollMinutes} minute${fixer.pollMinutes === 1 ? "" : "s"}`);
  await runDaemon({
    pollMs: fixer.pollMinutes * 60_000,
    find: async () => {
      const found = await findTickets(config, await ticketRepo());
      bodies = found.bodies;
      return found.requests;
    },
    attempt: async (request, started) => {
      const result = await runTicket({
        config,
        tokens,
        tickets: ticketRepo,
        number: request.number,
        key: request.key,
        repo: request.repo,
        body: bodies.get(request.number) ?? "",
        local: false,
        request: { force: request.force },
        started: () => started(),
        shouldStop: () => stop.signal.aborted,
      });
      return { skipped: result.skipped, reason: result.decision.reason, units: result.reports.map((report) => ({ label: report.label, outcome: report.outcome })) };
    },
    sleep,
    stopping: () => stop.signal.aborted,
    log: stamped,
  });
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "check" && args.length === 1) return checkCommand();
  if (args[0] === "serve" && args.length === 1) return serve();
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  if (!config.fixer) throw new Error("the config has no fixer section");
  const fixer = config.fixer;
  const [command, argument, ...flags] = args;
  const tokens = tokenProvider(process.env, config.app);
  if (command === "sandbox") return sandboxCommand({ ...config, fixer }, tokens, args.slice(1));
  const writes = command === "find" || (command === "run" && flags.length === 0);
  const ticketToken = await tokens({
    repositories: [config.tickets.repo],
    permissions: { issues: writes ? "write" : "read" },
  });
  const tickets = new TicketRepo(ticketToken, config.org, config.tickets.repo);
  if (command === "run") {
    const number = ticketNumber(argument);
    if (flags.length === 0) return attemptTicket({ ...config, fixer }, tokens, tickets, number, false);
    if (flags.length === 1 && flags[0] === "--local") return attemptTicket({ ...config, fixer }, tokens, tickets, number, true);
    if (flags.length === 1 && flags[0] === "--dry-run") return dryRun({ ...config, fixer }, tokens, tickets, number);
    throw new Error(USAGE);
  }

  switch (command) {
    case "find": {
      const found = await findTickets({ ...config, fixer }, tickets);
      console.log(JSON.stringify(found.requests));
      return;
    }
    case "read": {
      const number = ticketNumber(argument);
      const ticket = await tickets.get(number);
      if (!isProsecoTicket(ticket, config.tickets.find.creators)) {
        throw new Error(`#${number} is not a proseco ticket: it needs the marker on its first line and an author in tickets.find.creators`);
      }
      console.log(JSON.stringify({ number, key: markerKey(ticket.body), repo: markerRepo(ticket.body), state: ticket.state, rows: parseRawTable(ticket.body) }, null, 2));
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

await main(process.argv.slice(2));
