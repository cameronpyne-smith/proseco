import type { Config } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import { groupFindings } from "../core/findings.ts";
import { TicketRepo } from "../core/github.ts";
import type { ExistingTicket } from "../core/types.ts";
import { fetchEnrichment } from "../enrich/enrichment.ts";
import { DefenderSource } from "../sources/defender.ts";
import { DependabotSource } from "../sources/dependabot.ts";
import type { Source } from "../sources/source.ts";
import { formatPlan, planActions, ticketFilters } from "./plan.ts";
import type { Action } from "./plan.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sourcesFor(config: Config, readToken: string): Source[] {
  const sources: Source[] = [];
  if (config.sources.dependabot) sources.push(new DependabotSource(readToken, config.org));
  if (config.sources.defender) {
    sources.push(new DefenderSource(requireEnv("AZURE_SUBSCRIPTION_ID"), config.org, config.sources.defender.imageRepos));
  }
  return sources;
}

async function apply(config: Config, tickets: TicketRepo, actions: Action[], existing: ExistingTicket[]): Promise<void> {
  const byNumber = new Map(existing.map((ticket) => [ticket.number, ticket]));
  const projectTitle = config.tickets.project;
  let projectId: string | null = null;
  const addToProject = async (nodeId: string) => {
    if (!projectTitle) return;
    projectId ??= await tickets.findProjectId(projectTitle);
    await tickets.addToProject(projectId, nodeId);
  };
  const applyAction = async (action: Action): Promise<void> => {
    switch (action.type) {
      case "create": {
        const created = await tickets.create(action.title, action.body, config.tickets.labels);
        await addToProject(created.nodeId);
        console.log(`created #${created.number} for ${action.key}`);
        break;
      }
      case "update":
        await tickets.patch(action.number, { title: action.title, body: action.body });
        await addToProject(byNumber.get(action.number)!.nodeId);
        console.log(`updated #${action.number} for ${action.key}`);
        break;
      case "close":
        await tickets.comment(action.number, action.comment);
        await tickets.patch(action.number, { state: "closed", state_reason: "completed" });
        console.log(`closed #${action.number} for ${action.key}`);
        break;
      case "reopen":
        await tickets.comment(action.number, action.comment);
        await tickets.patch(action.number, {
          state: "open",
          state_reason: "reopened",
          title: action.title,
          body: action.body,
        });
        await addToProject(byNumber.get(action.number)!.nodeId);
        console.log(`reopened #${action.number} for ${action.key}`);
        break;
      case "noop":
        if (byNumber.get(action.number)?.state === "open") await addToProject(byNumber.get(action.number)!.nodeId);
        break;
    }
  };
  const failures: string[] = [];
  for (const action of actions) {
    try {
      await applyAction(action);
    } catch (error) {
      failures.push(`${action.type} ${action.key}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`::error::${failures.at(-1)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${actions.length} actions failed`);
}

async function main(): Promise<void> {
  const config = loadConfig(requireEnv("PROSECO_CONFIG"));
  const dryRun = process.env["PROSECO_DRY_RUN"] !== "false";
  const readToken = requireEnv("GH_READ_TOKEN");

  const findings = [];
  for (const source of sourcesFor(config, readToken)) {
    const found = await source.fetch();
    console.log(`${source.name} findings: ${found.length}`);
    findings.push(...found);
  }
  const qualifying = [...groupFindings(findings).values()].flat();
  const enrichment = await fetchEnrichment(qualifying.map((finding) => finding.cve));

  const existing = await new TicketRepo(readToken, config.org, config.tickets.repo).list(ticketFilters(config.tickets.find));
  const actions = planActions(findings, existing, enrichment, { org: config.org, maintainedIn: config.tickets.maintainedIn });
  console.log(formatPlan(actions));

  if (dryRun) {
    console.log("dry run: nothing written");
    return;
  }
  const writer = new TicketRepo(requireEnv("GH_WRITE_TOKEN"), config.org, config.tickets.repo);
  await apply(config, writer, actions, existing);
}

await main();
