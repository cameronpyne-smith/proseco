import type { TokenProvider } from "../core/app.ts";
import type { Config, FixerConfig } from "../core/config.ts";
import { RepoApi, type TicketRepo } from "../core/github.ts";
import { announceReason, announcements, buildMessage, messageGroups, writeSentence, type DeliveryDeps, type MessageDeps } from "./announce.ts";
import { Advisories } from "./advisories.ts";
import { OllamaClient } from "./agent/ollama.ts";
import { runAttempt, type AttemptResult } from "./attempt.ts";
import { applyCommands, commandComment, fixRequests, requestFilters, type FixRequest } from "./requests.ts";
import { appendToComment, upsertComment, type UnitReport } from "./comment.ts";
import { GitStore } from "./git.ts";
import { Releases } from "./releases.ts";
import { Docker } from "./sandbox/docker.ts";
import { lastCommentId, loadState, recordComment, recordIgnored, saveState, type Decision, type PullRequestStatus } from "./state.ts";
import { readTeamsCredential, TeamsClient } from "./teams.ts";
import { workUnit, type Published, type PublishRequest, type Publisher } from "./unit.ts";

const MS_PER_MINUTE = 60_000;

export interface RunTicket {
  config: Config & { fixer: FixerConfig };
  tokens: TokenProvider;
  tickets(): Promise<TicketRepo>;
  number: number;
  key: string;
  repo: string;
  body: string;
  local: boolean;
  request?: { force: boolean };
  started?(decision: Decision): void;
  shouldStop?(): boolean;
}

function ollamaClient(fixer: FixerConfig): OllamaClient {
  return new OllamaClient({
    url: fixer.ollama.url,
    model: fixer.ollama.model,
    numCtx: fixer.ollama.numCtx,
    numPredict: fixer.ollama.numPredict,
    think: fixer.ollama.think,
    temperature: fixer.ollama.temperature,
    timeoutMs: fixer.ollama.timeoutMinutes * MS_PER_MINUTE,
  });
}

export function messageDeps(config: Config & { fixer: FixerConfig }, tokens: TokenProvider): MessageDeps {
  const llm = ollamaClient(config.fixer).withThink(false).withTemperature(0);
  return {
    org: config.org,
    bot: config.app.bot,
    ticketUrl: (ticket) => `https://github.com/${config.org}/${config.tickets.repo}/issues/${ticket}`,
    pull: async (location) => new RepoApi(await tokens({ repositories: [location.repo], permissions: { pull_requests: "read" } }), config.org, location.repo).pullDetails(location.number),
    sentence: (repo, prs) => writeSentence(llm, repo, prs),
  };
}

export function teamsClient(config: FixerConfig): TeamsClient | null {
  return config.teams ? new TeamsClient(config.teams, () => readTeamsCredential(process.env)) : null;
}

export function deliveryDeps(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, tickets: () => Promise<TicketRepo>, log: (line: string) => void): DeliveryDeps | null {
  const teams = teamsClient(config.fixer);
  if (!teams) return null;
  return {
    ...messageDeps(config, tokens),
    loadState: () => loadState(config.fixer.stateFile),
    saveState: (state) => saveState(config.fixer.stateFile, state),
    send: (html) => teams.send(html),
    gaveUp: async (ticket, reason) => appendToComment(await tickets(), ticket, config.app.bot, `- Not announced in Teams: \`${reason.replace(/`/g, "'").replace(/\s+/g, " ")}\``),
    now: () => new Date(),
    log,
  };
}

export async function localAnnouncement(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, ticket: number, reports: UnitReport[]): Promise<string[]> {
  const deps = messageDeps(config, tokens);
  const messages: string[] = [];
  for (const group of messageGroups(announcements(reports))) messages.push(await buildMessage(deps, ticket, group));
  return messages;
}

export async function findTickets(config: Config & { fixer: FixerConfig }, tickets: TicketRepo): Promise<{ requests: FixRequest[]; bodies: Map<number, string> }> {
  const open = await tickets.list(requestFilters(config.tickets.find));
  const found = await applyCommands(fixRequests(open, config.tickets.find.creators), tickets, config.app.bot, loadState(config.fixer.stateFile), true);
  saveState(config.fixer.stateFile, found.state);
  return { requests: found.requests, bodies: new Map(open.map((ticket) => [ticket.number, ticket.body])) };
}

function pullNumber(url: string): number {
  const match = /\/pull\/(\d+)\/?$/.exec(url);
  if (!match) throw new Error(`"${url}" is not a pull request URL`);
  return Number(match[1]);
}

export interface LivePublisherOptions {
  org: string;
  tokens: TokenProvider;
  store: Pick<GitStore, "push" | "inCheckout">;
  api?(token: string, repo: string): RepoApi;
}

export class LivePublisher implements Publisher {
  readonly #options: LivePublisherOptions;

  constructor(options: LivePublisherOptions) {
    this.#options = options;
  }

  async publish(request: PublishRequest): Promise<Published> {
    const { org, tokens, store } = this.#options;
    const token = await tokens({ repositories: [request.repo], permissions: { contents: "write", pull_requests: "write" } });
    const api = this.#options.api ? this.#options.api(token, request.repo) : new RepoApi(token, org, request.repo);
    const existing = await api.findOpenPull(request.branch);
    if (!existing) {
      await store.push(request.checkout, request.repo, request.branch, token);
      const created = await api.createPull({ title: request.title, body: request.body, head: request.branch, base: await api.defaultBranch(), draft: request.draft });
      return { url: created.url, draft: request.draft, announce: announceReason(null, request.draft) };
    }
    const tree = (await store.inCheckout(request.checkout, ["rev-parse", `${request.commit.sha}^{tree}`], "git rev-parse")).trim();
    const changed = (await api.commitTree(existing.headSha)) !== tree;
    const approved = changed && !request.draft && (await api.approved(existing.number));
    if (changed) await store.push(request.checkout, request.repo, request.branch, token);
    await api.updatePull(existing.number, { title: request.title, body: request.body });
    if (existing.draft !== request.draft) await api.setDraft(existing.nodeId, request.draft);
    return { url: existing.url, draft: request.draft, announce: announceReason({ draft: existing.draft, approved, changed }, request.draft) };
  }
}

class LocalPublisher implements Publisher {
  async publish(request: PublishRequest): Promise<Published> {
    console.log(`--- would push ${request.branch} and open ${request.draft ? "a draft" : "a ready"} pull request: ${request.title}`);
    console.log(`--- committed files: ${request.commit.files.join(", ")}`);
    console.log(`--- diff\n${request.diff}`);
    console.log(`--- lockfile check\n${request.checks.map((check) => `${check.ok ? "ok" : "FAILED"} ${check.package}: ${check.reason}`).join("\n")}`);
    const { tests } = request;
    console.log(`--- test result: ${tests.kind}${tests.kind === "failed" ? ` (${tests.step}, exit code ${tests.exitCode}${tests.timedOut ? ", timed out" : ""})` : ""}`);
    if (tests.tail.trim() !== "") console.log(tests.tail.trim().split("\n").slice(-40).join("\n"));
    console.log(`--- pull request body\n${request.body}`);
    return { url: `https://github.com/local/not-pushed/pull/0#${request.branch}`, draft: request.draft, announce: announceReason(null, request.draft) };
  }
}

export async function runTicket(input: RunTicket): Promise<AttemptResult & { checkouts: string[] }> {
  const { config, tokens, tickets, number, key, repo, local } = input;
  const fixer = config.fixer;
  const readToken = await tokens({ repositories: [repo], permissions: { contents: "read", pull_requests: "read" } });
  const store = new GitStore({ cloneDir: fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: readToken });
  const advisories = new Advisories(readToken);
  const releases = new Releases(readToken);
  const readApi = new RepoApi(readToken, config.org, repo);
  let state = loadState(fixer.stateFile);
  const command = input.request ? null : commandComment(await (await tickets()).comments(number), config.app.bot, lastCommentId(state, number));
  if (command) {
    const next = recordIgnored(recordComment(state, number, command.id), number, command.command === "ignore");
    if (!local) {
      await (await tickets()).react(command.id, "eyes");
      saveState(fixer.stateFile, next);
    }
    state = next;
  }
  const llm = ollamaClient(fixer);
  const docker = new Docker();
  const publisher = local ? new LocalPublisher() : new LivePublisher({ org: config.org, tokens, store });
  const checkouts: string[] = [];
  const result = await runAttempt(
    { ticket: { number, key, repo, body: input.body }, force: input.request ? input.request.force : command?.command === "fix", state, local },
    {
      org: config.org,
      fetch: async () => {
        await store.fetch(repo);
        return store.headSha(repo);
      },
      prStatus: async (url): Promise<PullRequestStatus> => ({ url, state: await readApi.pullState(pullNumber(url)) }),
      workUnit: async (unit, headSha) => {
        const outcome = await workUnit(
          {
            org: config.org,
            ticketsRepo: config.tickets.repo,
            ticket: number,
            repo,
            bot: config.app.bot,
            store,
            docker,
            fixer,
            llm,
            advisory: (cve, pkg, installed) => advisories.lookup(cve, pkg, installed),
            releases: (ecosystem, pkg, installed, target) => releases.lookup(ecosystem, pkg, installed, target),
            publisher,
            keepCheckout: local,
            log: (message) => console.error(`[${unit.branch}] ${message}`),
          },
          unit,
          headSha,
        );
        if (outcome.checkout) checkouts.push(outcome.checkout);
        return outcome;
      },
      postComment: async (body) => void (await upsertComment(await tickets(), number, config.app.bot, body)),
      saveState: (next) => saveState(fixer.stateFile, next),
      ...(input.started ? { started: input.started } : {}),
      ...(input.shouldStop ? { shouldStop: input.shouldStop } : {}),
      announce: fixer.teams !== null,
      now: () => new Date(),
    },
  );
  return { ...result, checkouts };
}

export function summarise(result: AttemptResult & { checkouts: string[] }, number: number): unknown {
  return {
    ticket: number,
    skipped: result.skipped,
    decision: result.decision,
    headSha: result.headSha,
    units: result.reports.map((report) => ({ unit: report.label, branch: report.unit.branch, outcome: report.outcome, stats: report.result.stats, transcript: report.result.transcript, checkout: report.result.checkout })),
    checkouts: result.checkouts,
  };
}
