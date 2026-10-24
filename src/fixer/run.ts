import type { TokenProvider } from "../core/app.ts";
import type { Config, FixerConfig } from "../core/config.ts";
import { RepoApi, type TicketRepo } from "../core/github.ts";
import { Advisories } from "./advisories.ts";
import { OllamaClient } from "./agent/ollama.ts";
import { runAttempt, type AttemptResult } from "./attempt.ts";
import { commandComment } from "./requests.ts";
import { upsertComment } from "./comment.ts";
import { GitStore } from "./git.ts";
import { Docker } from "./sandbox/docker.ts";
import { lastCommentId, loadState, recordComment, saveState, type PullRequestStatus } from "./state.ts";
import { workUnit, type PublishRequest, type Publisher } from "./unit.ts";

const MS_PER_MINUTE = 60_000;

export interface RunTicket {
  config: Config & { fixer: FixerConfig };
  tokens: TokenProvider;
  tickets: TicketRepo;
  number: number;
  repo: string;
  body: string;
  local: boolean;
}

function pullNumber(url: string): number {
  const match = /\/pull\/(\d+)\/?$/.exec(url);
  if (!match) throw new Error(`"${url}" is not a pull request URL`);
  return Number(match[1]);
}

class LivePublisher implements Publisher {
  readonly #config: Config & { fixer: FixerConfig };
  readonly #tokens: TokenProvider;
  readonly #store: GitStore;
  readonly #number: number;

  constructor(config: Config & { fixer: FixerConfig }, tokens: TokenProvider, store: GitStore, number: number) {
    this.#config = config;
    this.#tokens = tokens;
    this.#store = store;
    this.#number = number;
  }

  async publish(request: PublishRequest): Promise<{ url: string; draft: boolean }> {
    const token = await this.#tokens({ repositories: [request.repo], permissions: { contents: "write", pull_requests: "write" } });
    await this.#store.push(request.checkout, request.repo, request.branch, token);
    const api = new RepoApi(token, this.#config.org, request.repo);
    const existing = await api.findOpenPull(request.branch);
    if (existing) {
      await api.updatePull(existing.number, { title: request.title, body: request.body });
      if (existing.draft !== request.draft) await api.setDraft(existing.nodeId, request.draft);
      return { url: existing.url, draft: request.draft };
    }
    const created = await api.createPull({ title: request.title, body: request.body, head: request.branch, base: await api.defaultBranch(), draft: request.draft });
    return { url: created.url, draft: request.draft };
  }
}

class LocalPublisher implements Publisher {
  async publish(request: PublishRequest): Promise<null> {
    console.log(`--- would push ${request.branch} and open ${request.draft ? "a draft" : "a ready"} pull request: ${request.title}`);
    console.log(`--- committed files: ${request.commit.files.join(", ")}`);
    console.log(`--- diff\n${request.diff}`);
    console.log(`--- lockfile check\n${request.checks.map((check) => `${check.ok ? "ok" : "FAILED"} ${check.package}: ${check.reason}`).join("\n")}`);
    const { tests } = request;
    console.log(`--- test result: ${tests.kind}${tests.kind === "failed" ? ` (${tests.step}, exit code ${tests.exitCode}${tests.timedOut ? ", timed out" : ""})` : ""}`);
    if (tests.tail.trim() !== "") console.log(tests.tail.trim().split("\n").slice(-40).join("\n"));
    console.log(`--- pull request body\n${request.body}`);
    return null;
  }
}

export async function runTicket(input: RunTicket): Promise<AttemptResult & { checkouts: string[] }> {
  const { config, tokens, tickets, number, repo, local } = input;
  const fixer = config.fixer;
  const readToken = await tokens({ repositories: [repo], permissions: { contents: "read", pull_requests: "read" } });
  const store = new GitStore({ cloneDir: fixer.cloneDir, remoteUrl: (name) => `https://github.com/${config.org}/${name}.git`, token: readToken });
  const advisories = new Advisories(readToken);
  const readApi = new RepoApi(readToken, config.org, repo);
  let state = loadState(fixer.stateFile);
  const command = commandComment(await tickets.comments(number), fixer.bot, lastCommentId(state, number));
  if (command && !local) {
    await tickets.react(command.id, "eyes");
    state = recordComment(state, number, command.id);
    saveState(fixer.stateFile, state);
  }
  const llm = new OllamaClient({
    url: fixer.ollama.url,
    model: fixer.ollama.model,
    numCtx: fixer.ollama.numCtx,
    numPredict: fixer.ollama.numPredict,
    think: fixer.ollama.think,
    timeoutMs: fixer.ollama.timeoutMinutes * MS_PER_MINUTE,
  });
  const docker = new Docker();
  const publisher = local ? new LocalPublisher() : new LivePublisher(config, tokens, store, number);
  const checkouts: string[] = [];
  const result = await runAttempt(
    { ticket: { number, repo, body: input.body }, force: command !== null, state, local },
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
            bot: fixer.bot,
            store,
            docker,
            fixer,
            llm,
            advisory: (cve, pkg) => advisories.lookup(cve, pkg),
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
      postComment: async (body) => void (await upsertComment(tickets, number, fixer.bot, body)),
      saveState: (next) => saveState(fixer.stateFile, next),
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
    units: result.reports.map((report) => ({ unit: report.label, branch: report.unit.branch, outcome: report.outcome, stats: report.result.stats, checkout: report.result.checkout })),
    checkouts: result.checkouts,
  };
}
