import { appendFileSync } from "node:fs";
import { tokenProvider, type TokenProvider } from "../core/app.ts";
import { loadConfig, type Config, type FixerConfig } from "../core/config.ts";
import { TicketRepo } from "../core/github.ts";
import { UNMAPPED_KEY } from "../core/findings.ts";
import { isProsecoTicket, markerKey, parseRawTable } from "../core/ticket.ts";
import { Advisories } from "./advisories.ts";
import { dryRunReport } from "./dryrun.ts";
import { GitStore } from "./git.ts";
import { fixRequests, requestFilters } from "./requests.ts";
import { loadState } from "./state.ts";

const USAGE = "usage: fixer find | fixer read <ticket number> | fixer run <ticket number> --dry-run";

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

async function dryRun(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, ticketToken: string, number: number): Promise<void> {
  const ticket = await new TicketRepo(ticketToken, config.org, config.tickets.repo).get(number);
  if (!isProsecoTicket(ticket, config.tickets.find.creators)) {
    throw new Error(`#${number} is not a proseco ticket: it needs the marker on its first line and an author in tickets.find.creators`);
  }
  const repo = markerKey(ticket.body)!;
  if (repo === UNMAPPED_KEY) throw new Error(`#${number} is the unmapped images ticket, which has no repository to fix`);
  const repoToken = await tokens({ repositories: [repo], permissions: { contents: "read" } });
  const store = new GitStore({ cloneDir: config.fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: repoToken });
  await store.fetch(repo);
  const headSha = await store.headSha(repo);
  const advisories = new Advisories(ticketToken);
  const report = await dryRunReport({
    ticket: { number, repo, body: ticket.body, force: ticket.labels.includes(config.fixer.labels.fix) },
    rows: parseRawTable(ticket.body),
    org: config.org,
    headSha,
    last: loadState(config.fixer.stateFile).tickets[String(number)],
    readFile: (path) => store.tryShow(repo, headSha, path),
    advisory: (cve, pkg) => advisories.lookup(cve, pkg),
  });
  console.log(JSON.stringify(report, null, 2));
}

async function main(args: string[]): Promise<void> {
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  if (!config.fixer) throw new Error("the config has no fixer section");
  const fixer = config.fixer;
  const [command, argument, flag] = args;
  const tokens = tokenProvider(process.env, fixer.app);
  const ticketToken = await tokens({ repositories: [config.tickets.repo], permissions: { issues: "read" } });
  if (command === "run") {
    const number = ticketNumber(argument);
    if (flag !== "--dry-run") throw new Error("fixer run is not built yet: only --dry-run works");
    return dryRun({ ...config, fixer }, tokens, ticketToken, number);
  }
  const tickets = new TicketRepo(ticketToken, config.org, config.tickets.repo);

  switch (command) {
    case "find": {
      const open = await tickets.list(requestFilters(config.tickets.find));
      const requests = fixRequests(open, config.tickets.find.creators, fixer.labels);
      const json = JSON.stringify(requests);
      console.log(json);
      const output = process.env["GITHUB_OUTPUT"];
      if (output) appendFileSync(output, `requests=${json}\n`);
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
