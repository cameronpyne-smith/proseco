import type { ExistingTicket } from "./types.ts";

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

  constructor(token: string) {
    this.#token = token;
  }

  protected async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = url.startsWith("https://") ? url : `https://api.github.com${url}`;
    return fetch(target, {
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

  constructor(token: string, org: string, repo: string) {
    super(token);
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
