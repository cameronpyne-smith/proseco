import type { ExistingTicket, TicketComment } from "./types.ts";

export async function expectOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what} failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }
  return response;
}

function nextLink(response: Response): string | null {
  const header = response.headers.get("link") ?? "";
  const match = /<([^>]+)>;\s*rel="next"/.exec(header);
  return match?.[1] ?? null;
}

export class GitHubApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  protected async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = url.startsWith("https://") ? url : `https://api.github.com${url}`;
    return this.#fetch(target, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        ...init.headers,
      },
    });
  }

  protected async paginate<T>(url: string, what: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = url;
    while (next) {
      const response: Response = await expectOk(await this.request(next), what);
      items.push(...((await response.json()) as T[]));
      next = nextLink(response);
    }
    return items;
  }

  protected async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await expectOk(
      await this.request("/graphql", { method: "POST", body: JSON.stringify({ query, variables }) }),
      "graphql",
    );
    const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length || !payload.data) {
      throw new Error(`graphql failed: ${JSON.stringify(payload.errors)}`);
    }
    return payload.data;
  }
}

interface Issue {
  number: number;
  node_id: string;
  state: string;
  state_reason: string | null;
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: (string | { name?: string })[];
  pull_request?: unknown;
}

function toTicket(issue: Issue): ExistingTicket {
  return {
    number: issue.number,
    nodeId: issue.node_id,
    state: issue.state === "open" ? "open" : "closed",
    stateReason: issue.state_reason,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "",
    labels: issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean),
  };
}

export interface TicketFilter {
  labels?: string;
  creator?: string;
  state: "open" | "all";
}

export class TicketRepo extends GitHubApi {
  readonly #path: string;
  readonly #org: string;

  constructor(token: string, org: string, repo: string, fetchImpl: typeof fetch = fetch) {
    super(token, fetchImpl);
    this.#org = org;
    this.#path = `/repos/${org}/${repo}/issues`;
  }

  async list(filters: TicketFilter[]): Promise<ExistingTicket[]> {
    const issues = new Map<number, Issue>();
    for (const filter of filters) {
      const query = new URLSearchParams(Object.entries({ ...filter, per_page: "100" }).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const page = await this.paginate<Issue>(`${this.#path}?${query}`, "list tickets");
      for (const issue of page) issues.set(issue.number, issue);
    }
    return [...issues.values()].filter((issue) => !issue.pull_request).map(toTicket);
  }

  async get(number: number): Promise<ExistingTicket> {
    const response = await expectOk(await this.request(`${this.#path}/${number}`), `read ticket #${number}`);
    return toTicket((await response.json()) as Issue);
  }

  async comments(number: number): Promise<TicketComment[]> {
    const items = await this.paginate<{ id: number; body: string | null; created_at: string; user: { login: string; type: string } | null }>(
      `${this.#path}/${number}/comments?per_page=100`,
      `list comments on #${number}`,
    );
    return items.map((item) => ({
      id: item.id,
      author: item.user?.login ?? "",
      authorType: item.user?.type ?? "",
      body: item.body ?? "",
      createdAt: item.created_at,
    }));
  }

  async react(commentId: number, content: "eyes"): Promise<void> {
    await expectOk(
      await this.request(`${this.#path}/comments/${commentId}/reactions`, { method: "POST", body: JSON.stringify({ content }) }),
      `react to comment ${commentId}`,
    );
  }

  async create(title: string, body: string, labels: string[]): Promise<{ number: number; nodeId: string }> {
    const response = await expectOk(
      await this.request(this.#path, { method: "POST", body: JSON.stringify({ title, body, labels }) }),
      "create ticket",
    );
    const created = (await response.json()) as { number: number; node_id: string };
    return { number: created.number, nodeId: created.node_id };
  }

  async patch(number: number, patch: Record<string, unknown>): Promise<void> {
    await expectOk(
      await this.request(`${this.#path}/${number}`, { method: "PATCH", body: JSON.stringify(patch) }),
      `update ticket #${number}`,
    );
  }

  async comment(number: number, body: string): Promise<void> {
    await expectOk(
      await this.request(`${this.#path}/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
      `comment on #${number}`,
    );
  }

  async editComment(commentId: number, body: string): Promise<void> {
    await expectOk(
      await this.request(`${this.#path}/comments/${commentId}`, { method: "PATCH", body: JSON.stringify({ body }) }),
      `edit comment ${commentId}`,
    );
  }

  async findProjectId(title: string): Promise<string> {
    const data = await this.graphql<{
      organization: { projectsV2: { nodes: { id: string; title: string }[] } };
    }>(
      `query($org: String!, $title: String!) {
        organization(login: $org) { projectsV2(first: 20, query: $title) { nodes { id title } } }
      }`,
      { org: this.#org, title },
    );
    const project = data.organization.projectsV2.nodes.find((node) => node.title === title);
    if (!project) throw new Error(`project "${title}" not found in ${this.#org}`);
    return project.id;
  }

  async addToProject(projectId: string, issueNodeId: string): Promise<void> {
    await this.graphql(
      `mutation($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
      }`,
      { project: projectId, content: issueNodeId },
    );
  }
}

export interface PullRequest {
  number: number;
  url: string;
  nodeId: string;
  draft: boolean;
  headSha: string;
}

export interface PullDetails {
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  author: string;
  headSha: string;
}

export interface PullReview {
  id: number;
  author: string;
  state: string;
  commitId: string;
  body: string;
}

export interface PullReviewComment {
  id: number;
  reviewId: number | null;
  path: string;
  line: number | null;
  body: string;
}

export interface NewPullRequest {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

interface Pull {
  number: number;
  html_url: string;
  node_id: string;
  draft?: boolean;
  state: string;
  merged_at?: string | null;
  title?: string;
  user?: { login: string } | null;
  head?: { sha: string };
}

function toPullRequest(pull: Pull): PullRequest {
  return { number: pull.number, url: pull.html_url, nodeId: pull.node_id, draft: pull.draft === true, headSha: pull.head?.sha ?? "" };
}

function stateOf(pull: Pull): "open" | "merged" | "closed" {
  if (pull.merged_at) return "merged";
  return pull.state === "open" ? "open" : "closed";
}

export function latestReviewsApprove(reviews: { user: { login: string } | null; state: string }[]): boolean {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (!review.user || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    latest.set(review.user.login, review.state);
  }
  return [...latest.values()].includes("APPROVED");
}

export class RepoApi extends GitHubApi {
  readonly #org: string;
  readonly #repo: string;

  constructor(token: string, org: string, repo: string, fetchImpl: typeof fetch = fetch) {
    super(token, fetchImpl);
    this.#org = org;
    this.#repo = repo;
  }

  get #path(): string {
    return `/repos/${this.#org}/${this.#repo}`;
  }

  async defaultBranch(): Promise<string> {
    const response = await expectOk(await this.request(this.#path), `read ${this.#repo}`);
    return ((await response.json()) as { default_branch: string }).default_branch;
  }

  async findOpenPull(branch: string): Promise<PullRequest | null> {
    const query = new URLSearchParams({ head: `${this.#org}:${branch}`, state: "open" });
    const response = await expectOk(await this.request(`${this.#path}/pulls?${query}`), `find the open pull request for ${branch}`);
    const [pull] = (await response.json()) as Pull[];
    return pull ? toPullRequest(pull) : null;
  }

  async createPull(pull: NewPullRequest): Promise<PullRequest> {
    const response = await expectOk(
      await this.request(`${this.#path}/pulls`, { method: "POST", body: JSON.stringify(pull) }),
      `open a pull request for ${pull.head}`,
    );
    return toPullRequest((await response.json()) as Pull);
  }

  async updatePull(number: number, patch: { title: string; body: string }): Promise<void> {
    await expectOk(
      await this.request(`${this.#path}/pulls/${number}`, { method: "PATCH", body: JSON.stringify(patch) }),
      `update pull request #${number}`,
    );
  }

  async setDraft(nodeId: string, draft: boolean): Promise<void> {
    const mutation = draft
      ? "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }"
      : "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }";
    await this.graphql(mutation, { id: nodeId });
  }

  async #pull(number: number): Promise<Pull> {
    const response = await expectOk(await this.request(`${this.#path}/pulls/${number}`), `read pull request #${number}`);
    return (await response.json()) as Pull;
  }

  async pullState(number: number): Promise<"open" | "merged" | "closed"> {
    return stateOf(await this.#pull(number));
  }

  async pullDetails(number: number): Promise<PullDetails> {
    const pull = await this.#pull(number);
    return { url: pull.html_url, title: pull.title ?? "", state: stateOf(pull), draft: pull.draft === true, author: pull.user?.login ?? "", headSha: pull.head?.sha ?? "" };
  }

  async reviews(number: number): Promise<PullReview[]> {
    const items = await this.paginate<{ id: number; user: { login: string } | null; state: string; commit_id: string | null; body: string | null }>(
      `${this.#path}/pulls/${number}/reviews?per_page=100`,
      `list reviews on #${number}`,
    );
    return items.map((item) => ({ id: item.id, author: item.user?.login ?? "", state: item.state, commitId: item.commit_id ?? "", body: item.body ?? "" }));
  }

  async approved(number: number): Promise<boolean> {
    return latestReviewsApprove((await this.reviews(number)).map((review) => ({ user: { login: review.author }, state: review.state })));
  }

  async reviewComments(number: number): Promise<PullReviewComment[]> {
    const items = await this.paginate<{ id: number; pull_request_review_id: number | null; path: string; line: number | null; original_line: number | null; body: string | null }>(
      `${this.#path}/pulls/${number}/comments?per_page=100`,
      `list review comments on #${number}`,
    );
    return items.map((item) => ({ id: item.id, reviewId: item.pull_request_review_id ?? null, path: item.path, line: item.line ?? item.original_line ?? null, body: item.body ?? "" }));
  }

  async commentOnPull(number: number, body: string): Promise<void> {
    await expectOk(await this.request(`${this.#path}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }), `comment on pull request #${number}`);
  }

  async hasLabel(name: string): Promise<boolean> {
    const response = await this.request(`${this.#path}/labels/${encodeURIComponent(name)}`);
    if (response.status === 404) return false;
    await expectOk(response, `read label ${name}`);
    return true;
  }

  async createLabel(name: string, color: string, description: string): Promise<void> {
    await expectOk(await this.request(`${this.#path}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) }), `create label ${name}`);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    await expectOk(await this.request(`${this.#path}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels }) }), `label pull request #${number}`);
  }

  async commitTree(sha: string): Promise<string> {
    const response = await expectOk(await this.request(`${this.#path}/git/commits/${sha}`), `read commit ${sha}`);
    return ((await response.json()) as { tree: { sha: string } }).tree.sha;
  }
}
