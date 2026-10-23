import { appendFileSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { TicketRepo } from "../core/github.ts";
import { isProsecoTicket, markerKey, parseRawTable } from "../core/ticket.ts";
import { fixRequests, requestFilters } from "./requests.ts";

const USAGE = "usage: fixer find | fixer read <ticket number>";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  if (!config.fixer) throw new Error("the config has no fixer section");
  const tickets = new TicketRepo(requireEnv("GH_READ_TOKEN"), config.org, config.tickets.repo);
  const [command, argument] = args;

  switch (command) {
    case "find": {
      const open = await tickets.list(requestFilters(config.fixer.labels));
      const requests = fixRequests(open, config.tickets.find.creators, config.fixer.labels);
      const json = JSON.stringify(requests);
      console.log(json);
      const output = process.env["GITHUB_OUTPUT"];
      if (output) appendFileSync(output, `requests=${json}\n`);
      return;
    }
    case "read": {
      const number = Number(argument);
      if (!Number.isInteger(number) || number <= 0) throw new Error(USAGE);
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
