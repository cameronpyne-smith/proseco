import { tokenProvider, type TokenProvider } from "../core/app.ts";
import { loadConfig, type Config, type FixerConfig } from "../core/config.ts";
import { TicketRepo } from "../core/github.ts";
import { UNMAPPED_KEY } from "../core/findings.ts";
import { isProsecoTicket, markerKey, parseRawTable } from "../core/ticket.ts";
import { Advisories } from "./advisories.ts";
import { dryRunReport } from "./dryrun.ts";
import { GitStore } from "./git.ts";
import { formatOutcome, runInSandbox } from "./sandbox/command.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { applyCommands, commandComment, fixRequests, requestFilters } from "./requests.ts";
import { lastAttempt, lastCommentId, loadState, saveState } from "./state.ts";

const USAGE = "usage: fixer find | fixer read <ticket number> | fixer run <ticket number> --dry-run | fixer sandbox <repo> <lockfile path> -- <command...> | fixer sandbox --sweep";

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

async function dryRun(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: TicketRepo, number: number): Promise<void> {
  const ticket = await tickets.get(number);
  if (!isProsecoTicket(ticket, config.tickets.find.creators)) {
    throw new Error(`#${number} is not a proseco ticket: it needs the marker on its first line and an author in tickets.find.creators`);
  }
  const repo = markerKey(ticket.body)!;
  if (repo === UNMAPPED_KEY) throw new Error(`#${number} is the unmapped images ticket, which has no repository to fix`);
  const repoToken = await tokens({ repositories: [repo], permissions: { contents: "read" } });
  const store = new GitStore({ cloneDir: config.fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: repoToken });
  await store.fetch(repo);
  const headSha = await store.headSha(repo);
  const advisories = new Advisories(repoToken);
  const state = loadState(config.fixer.stateFile);
  const command = commandComment(await tickets.comments(number), config.fixer.bot, lastCommentId(state, number));
  const report = await dryRunReport({
    ticket: { number, repo, body: ticket.body, force: command !== null, commandCommentId: command?.id ?? null },
    rows: parseRawTable(ticket.body),
    org: config.org,
    headSha,
    last: lastAttempt(state, number),
    readFile: (path) => store.tryShow(repo, headSha, path),
    advisory: (cve, pkg) => advisories.lookup(cve, pkg),
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
  console.log(formatOutcome(await runInSandbox({ store, repo, lockfile, command, fixer: config.fixer })));
}

async function main(args: string[]): Promise<void> {
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  if (!config.fixer) throw new Error("the config has no fixer section");
  const fixer = config.fixer;
  const [command, argument, flag] = args;
  const tokens = tokenProvider(process.env, fixer.app);
  if (command === "sandbox") return sandboxCommand({ ...config, fixer }, tokens, args.slice(1));
  const ticketToken = await tokens({
    repositories: [config.tickets.repo],
    permissions: { issues: command === "find" ? "write" : "read" },
  });
  const tickets = new TicketRepo(ticketToken, config.org, config.tickets.repo);
  if (command === "run") {
    const number = ticketNumber(argument);
    if (flag !== "--dry-run") throw new Error("fixer run is not built yet: only --dry-run works");
    return dryRun({ ...config, fixer }, tokens, tickets, number);
  }

  switch (command) {
    case "find": {
      const open = await tickets.list(requestFilters(config.tickets.find));
      const state = loadState(fixer.stateFile);
      const found = await applyCommands(fixRequests(open, config.tickets.find.creators), tickets, fixer.bot, state, true);
      saveState(fixer.stateFile, found.state);
      const requests = found.requests;
      const json = JSON.stringify(requests);
      console.log(json);
      return;
    }
    case "read": {
      const number = ticketNumber(argument);
      const ticket = await tickets.get(number);
      if (!isProsecoTicket(ticket, config.tickets.find.creators)) {
        throw new Error(`#${number} is not a proseco ticket: it needs the marker on its first line and an author in tickets.find.creators`);
      }
      console.log(JSON.stringify({ number, repo: markerKey(ticket.body), state: ticket.state, rows: parseRawTable(ticket.body) }, null, 2));
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

await main(process.argv.slice(2));
