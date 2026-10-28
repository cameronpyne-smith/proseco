import { statSync } from "node:fs";
import { tokenProvider, type TokenProvider } from "../core/app.ts";
import { loadConfig, type Config, type FixerConfig } from "../core/config.ts";
import { RepoApi, TicketRepo } from "../core/github.ts";
import { isProsecoTicket, markerKey, markerRepo, parseRawTable } from "../core/ticket.ts";
import { pruneTranscripts } from "./transcripts.ts";
import { Advisories } from "./advisories.ts";
import { runDaemon } from "./daemon.ts";
import { dryRunReport } from "./dryrun.ts";
import { GitStore } from "./git.ts";
import { Docker } from "./sandbox/docker.ts";
import { exitCodeOf, formatOutcome, runInSandbox } from "./sandbox/command.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { memoised, trustedCommand } from "./requests.ts";
import { deliveryDeps, findTickets, localAnnouncement, messageDeps, runTicket, scanTicketPulls, summarise, teamsClient } from "./run.ts";
import { isFixerPull, redoOf, ticketOfPull, type PullRedo } from "./pulls.ts";
import { deliverAnnouncements, deliverTicket, isAnnounceable, pullLocation, type DeliveryDeps } from "./announce.ts";
import { appendToComment } from "./comment.ts";
import { TurnLock } from "./lock.ts";
import { allPassed, checkOllama, formatChecks, runChecks, type CheckResult, type StartupCheck } from "./startup.ts";
import { isIgnored, lastAttempt, lastCommentId, loadState, pendingAnnouncement, saveState, withAnnouncement, type AnnouncedPr, type PendingAnnouncement } from "./state.ts";

const USAGE = "usage: fixer find | fixer read <ticket number> | fixer run <ticket number | pull request URL> [--dry-run | --local] | fixer announce <ticket number> [--dry-run] [--now] | fixer sandbox <repo> <lockfile path> -- <command...> | fixer sandbox --sweep | fixer check | fixer serve [--only <ticket number,...>]";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pullTarget(argument: string | undefined, org: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(argument ?? "");
  if (!match) return null;
  if (match[1] !== org) throw new Error(`${argument} is not in ${org}`);
  return { repo: match[2]!, number: Number(match[3]) };
}

async function pullRedo(config: Config, tokens: TokenProvider, target: { repo: string; number: number }): Promise<{ ticket: number; redo: PullRedo }> {
  const api = new RepoApi(await tokens({ repositories: [target.repo], permissions: { pull_requests: "read" } }), config.org, target.repo);
  const pull = await api.pull(target.number);
  if (!isFixerPull(pull, config.app.bot)) throw new Error(`${pull.url} was not opened by the fixer: it needs the author ${config.app.bot}[bot] and a proseco/ branch`);
  if (pull.state !== "open") throw new Error(`${pull.url} is ${pull.state}; reopen it to redo it`);
  const ticket = ticketOfPull(pull.body, config.org, config.tickets.repo);
  if (ticket === null) throw new Error(`${pull.url} does not name its ticket with a "Part of ${config.org}/${config.tickets.repo}#<n>" line`);
  return { ticket, redo: redoOf(pull, "manual") };
}

async function ticketPulls(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, number: number, ticket: { key: string; repo: string }, acknowledge: boolean): Promise<PullRedo[]> {
  const state = loadState(config.fixer.stateFile);
  const request = { number, key: ticket.key, repo: ticket.repo, force: false, ignored: isIgnored(state, number), commentId: null, pulls: [] };
  const scanned = await scanTicketPulls(config, tokens, [request], state, acknowledge, (line) => console.error(line), new Set([number]));
  if (acknowledge) saveState(config.fixer.stateFile, scanned.state);
  return scanned.requests[0]!.pulls;
}

function serveOnly(flags: string[]): ReadonlySet<number> | null {
  if (flags.length === 0) return null;
  if (flags.length !== 2 || flags[0] !== "--only") throw new Error(USAGE);
  return new Set(flags[1]!.split(",").map(ticketNumber));
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

function turnLock(config: FixerConfig, log: (line: string) => void): TurnLock {
  return new TurnLock(config.turnLock, { log });
}

async function attemptTicket(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number, local: boolean, redo: PullRedo | null = null): Promise<void> {
  const { key, repo, body } = await fixableTicket(config, tickets, number);
  const lock = turnLock(config.fixer, (line) => console.error(line));
  const pulls = redo ? [redo] : local ? [] : await ticketPulls(config, tokens, number, { key, repo }, true);
  const result = await runTicket({ config, tokens, tickets: async () => tickets, number, key, repo, body, local, lock, pulls, ...(redo ? { request: { force: false } } : {}) });
  console.log(JSON.stringify(summarise(result, number), null, 2));
  if (local) {
    for (const checkout of result.checkouts) console.log(`checkout left in place: ${checkout}`);
    for (const message of await localAnnouncement(config, tokens, number, result.reports)) console.log(`--- would announce in Teams\n${message}`);
    return;
  }
  const delivery = deliveryDeps(config, tokens, async () => tickets, (line) => console.error(line), lock);
  if (delivery) await deliverAnnouncements(delivery, new Set([number]));
}

async function lastAttemptAnnouncement(config: Config & { fixer: FixerConfig }, deps: Pick<DeliveryDeps, "pull" | "bot">, number: number, now: Date): Promise<PendingAnnouncement> {
  const last = lastAttempt(loadState(config.fixer.stateFile), number);
  if (!last || last.prUrls.length === 0) throw new Error(`#${number} has no pull requests in the fixer's state`);
  const prs: AnnouncedPr[] = [];
  for (const url of last.prUrls) {
    const location = pullLocation(url);
    if (!location || location.org !== config.org) continue;
    const details = await deps.pull(location);
    if (isAnnounceable(deps, url, details)) prs.push({ url, reason: "new", facts: { title: details.title, major: / \(major\)$/.test(details.title), lockfile: "", packages: [] } });
  }
  if (prs.length === 0) throw new Error(`#${number} has no open, ready pull request by ${config.app.bot}[bot] to announce`);
  return { prs, queuedAt: now.toISOString(), attempts: 0, nextAt: now.toISOString(), lastError: null };
}

async function announceCommand(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number, options: { dryRun: boolean; now: boolean }): Promise<void> {
  const teams = teamsClient(config.fixer);
  if (!teams && !options.dryRun) throw new Error("the config has no fixer.teams section");
  const fixer = config.fixer;
  const deps = messageDeps(config, tokens, turnLock(fixer, (line) => console.error(line)));
  const queued = pendingAnnouncement(loadState(fixer.stateFile), number);
  if (queued) console.log(`announcing the queued announcement for #${number}: ${queued.prs.map((pr) => pr.url).join(", ")}`);
  else console.log(`no announcement is queued for #${number}; announcing the pull requests of its last attempt`);
  const pending = queued ?? (await lastAttemptAnnouncement(config, deps, number, new Date()));
  let sent = 0;
  const delivery: DeliveryDeps = {
    ...deps,
    loadState: () => loadState(fixer.stateFile),
    saveState: (state) => saveState(fixer.stateFile, state),
    send: async (html) => {
      console.log(html);
      if (!options.dryRun) await teams!.send(html);
      sent++;
    },
    gaveUp: async (ticket, reason) => {
      if (!options.dryRun) await appendToComment(tickets, ticket, config.app.bot, `- Not announced in Teams: \`${reason.replace(/`/g, "'").replace(/\s+/g, " ")}\``);
    },
    now: () => new Date(),
    log: (line) => console.error(line),
  };
  const next = await deliverTicket(delivery, number, pending, { force: options.now, waiting: (pr) => console.log(`waiting for ${deps.reviewer?.name ?? "the reviewer"} on ${pr.url}`) });
  if (!options.dryRun) saveState(fixer.stateFile, withAnnouncement(loadState(fixer.stateFile), number, next));
  if (next?.lastError) throw new Error(`not posted: ${next.lastError}`);
  if (options.dryRun) console.log(`dry run: nothing was posted and the state file is unchanged${sent === 0 ? "; nothing would be posted" : ""}`);
  else if (sent > 0) console.log(`posted to Teams${next ? ", the rest stays queued" : ""}`);
  else console.log(next ? "nothing posted yet: still waiting for a review" : "nothing to post: no open, ready pull request was left in the announcement, which is now cleared");
}

async function dryRun(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number, redo: PullRedo | null = null): Promise<void> {
  const { key, repo, body } = await fixableTicket(config, tickets, number);
  if (key !== repo) throw new Error(`#${number} is an image ticket, and image tickets are not attempted yet`);
  const repoToken = await tokens({ repositories: [repo], permissions: { contents: "read" } });
  const store = new GitStore({ cloneDir: config.fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: repoToken });
  await store.fetch(repo);
  const headSha = await store.headSha(repo);
  const advisories = new Advisories(repoToken);
  const state = loadState(config.fixer.stateFile);
  const command = redo ? null : await trustedCommand(await tickets.comments(number), config.app.bot, lastCommentId(state, number), memoised((login) => tickets.canWrite(login)));
  const pulls = redo ? [redo] : await ticketPulls(config, tokens, number, { key, repo }, false);
  const report = await dryRunReport({
    pulls,
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
    {
      name: "turnLock",
      run: async () => {
        const path = loaded().fixer.turnLock;
        if (!path) return "not configured, Ollama is used without taking turns";
        let directory = false;
        try {
          directory = statSync(path).isDirectory();
        } catch {
          throw new Error(`${path} does not exist; create it (the install script adds a tmpfiles.d entry) or remove fixer.turnLock`);
        }
        if (!directory) throw new Error(`${path} is not a directory`);
        return `${path} is a directory, each attempt and review takes a turn on it`;
      },
    },
    {
      name: "teams",
      run: async () => {
        const teams = teamsClient(loaded().fixer);
        if (!teams) return "not configured, nothing is announced";
        await teams.token();
        return `signed in as ${loaded().fixer.teams!.appId} for the Bot Framework`;
      },
    },
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

async function serve(only: ReadonlySet<number> | null): Promise<void> {
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
  const lock = turnLock(fixer, stamped);
  const delivery = deliveryDeps(config, tokens, ticketRepo, stamped, lock);
  stamped(`polling every ${fixer.pollMinutes} minute${fixer.pollMinutes === 1 ? "" : "s"}`);
  if (only) stamped(`only tickets ${[...only].map((number) => `#${number}`).join(", ")}`);
  await runDaemon({
    pollMs: fixer.pollMinutes * 60_000,
    find: async () => {
      const found = await findTickets(config, tokens, await ticketRepo(), stamped, only ?? undefined);
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
        pulls: request.pulls,
        lock,
        started: () => started(),
        shouldStop: () => stop.signal.aborted,
      });
      return { skipped: result.skipped, reason: result.decision.reason, units: result.reports.map((report) => ({ label: report.label, outcome: report.outcome })) };
    },
    ...(delivery ? { deliver: () => deliverAnnouncements(delivery, only ?? undefined) } : {}),
    sleep,
    stopping: () => stop.signal.aborted,
    log: stamped,
  });
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "check" && args.length === 1) return checkCommand();
  if (args[0] === "serve") return serve(serveOnly(args.slice(1)));
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  if (!config.fixer) throw new Error("the config has no fixer section");
  const fixer = config.fixer;
  const [command, argument, ...flags] = args;
  const tokens = tokenProvider(process.env, config.app);
  if (command === "sandbox") return sandboxCommand({ ...config, fixer }, tokens, args.slice(1));
  const announceFlags = { dryRun: flags.includes("--dry-run"), now: flags.includes("--now") };
  if (command === "announce" && (flags.length > 2 || flags.some((flag) => flag !== "--dry-run" && flag !== "--now") || new Set(flags).size !== flags.length)) throw new Error(USAGE);
  const writes = command === "find" || (command === "run" && flags.length === 0) || (command === "announce" && !announceFlags.dryRun);
  const ticketToken = await tokens({
    repositories: [config.tickets.repo],
    permissions: { issues: writes ? "write" : "read" },
  });
  const tickets = new TicketRepo(ticketToken, config.org, config.tickets.repo);
  if (command === "announce") return announceCommand({ ...config, fixer }, tokens, tickets, ticketNumber(argument), announceFlags);
  if (command === "run") {
    const target = pullTarget(argument, config.org);
    const { ticket: number, redo } = target ? await pullRedo(config, tokens, target) : { ticket: ticketNumber(argument), redo: null };
    if (flags.length === 0) return attemptTicket({ ...config, fixer }, tokens, tickets, number, false, redo);
    if (flags.length === 1 && flags[0] === "--local") return attemptTicket({ ...config, fixer }, tokens, tickets, number, true, redo);
    if (flags.length === 1 && flags[0] === "--dry-run") return dryRun({ ...config, fixer }, tokens, tickets, number, redo);
    throw new Error(USAGE);
  }

  switch (command) {
    case "find": {
      const found = await findTickets({ ...config, fixer }, tokens, tickets);
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
