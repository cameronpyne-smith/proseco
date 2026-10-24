import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitStoreOptions {
  cloneDir: string;
  remoteUrl(repo: string): string;
  token?: string | undefined;
}

export function gitEnvironment(home: string, token: string | undefined): Record<string, string> {
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["core.hooksPath", "/dev/null"],
  ];
  if (token) config.push(["http.extraheader", `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]);
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export class GitStore {
  readonly #options: GitStoreOptions;
  readonly #home: string;

  constructor(options: GitStoreOptions) {
    this.#options = options;
    this.#home = join(options.cloneDir, ".home");
  }

  #path(repo: string): string {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(repo)) throw new Error(`"${repo}" is not a valid repository name`);
    return join(this.#options.cloneDir, `${repo}.git`);
  }

  async #git(repo: string, args: string[], what: string, network = false): Promise<string> {
    mkdirSync(this.#home, { recursive: true });
    try {
      const { stdout } = await run("git", ["-C", this.#path(repo), ...args], {
        env: gitEnvironment(this.#home, network ? this.#options.token : undefined),
        maxBuffer: 512 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`${what} for ${repo} failed: ${stderr || (error as Error).message}`);
    }
  }

  async #ensure(repo: string): Promise<void> {
    const path = this.#path(repo);
    if (existsSync(join(path, "HEAD"))) return;
    mkdirSync(path, { recursive: true });
    await this.#git(repo, ["init", "--bare", "--quiet", "--template="], "git init");
    await this.#git(repo, ["remote", "add", "origin", this.#options.remoteUrl(repo)], "git remote add");
  }

  async fetch(repo: string): Promise<void> {
    await this.#ensure(repo);
    await this.#git(repo, ["fetch", "--quiet", "--no-tags", "origin", "+HEAD:refs/proseco/head"], "git fetch", true);
  }

  async headSha(repo: string): Promise<string> {
    return (await this.#git(repo, ["rev-parse", "--verify", "refs/proseco/head^{commit}"], "git rev-parse")).trim();
  }

  async tryShow(repo: string, sha: string, path: string): Promise<string | null> {
    const listing = await this.#git(repo, ["ls-tree", "--name-only", sha, "--", path], "git ls-tree");
    if (listing.trim() === "") return null;
    return this.#git(repo, ["show", `${sha}:${path}`], "git show");
  }

  async show(repo: string, sha: string, path: string): Promise<string> {
    const content = await this.tryShow(repo, sha, path);
    if (content === null) throw new Error(`${path} does not exist at ${sha} in ${repo}`);
    return content;
  }

  async worktreeAdd(repo: string, sha: string): Promise<string> {
    const attempt = mkdtempSync(join(tmpdir(), "proseco-attempt-"));
    const path = join(attempt, "work");
    try {
      await this.#git(repo, ["worktree", "add", "--detach", "--quiet", path, sha], "git worktree add");
    } catch (error) {
      rmSync(attempt, { recursive: true, force: true });
      throw error;
    }
    return path;
  }

  async worktreeRemove(repo: string, path: string): Promise<void> {
    try {
      await this.#git(repo, ["worktree", "remove", "--force", path], "git worktree remove");
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
      await this.#git(repo, ["worktree", "prune"], "git worktree prune");
    }
  }
}
