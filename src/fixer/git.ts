import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitStoreOptions {
  cloneDir: string;
  remoteUrl(repo: string): string;
  token?: string | undefined;
  attemptsDir?: string;
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
  readonly #attempts: string;
  readonly #origins = new Map<string, string>();

  constructor(options: GitStoreOptions) {
    this.#options = options;
    this.#home = join(options.cloneDir, ".home");
    this.#attempts = resolve(options.attemptsDir ?? join(options.cloneDir, "attempts"));
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

  async checkout(repo: string, sha: string): Promise<string> {
    mkdirSync(this.#attempts, { recursive: true });
    const attempt = mkdtempSync(join(this.#attempts, "attempt-"));
    const path = join(attempt, "work");
    try {
      await this.#plain(["clone", "--quiet", "--no-checkout", this.#path(repo), path], `git clone of ${repo}`);
      this.#origins.set(path, resolve(this.#path(repo)));
      await this.inCheckout(path, ["checkout", "--quiet", "--detach", sha], "git checkout");
    } catch (error) {
      rmSync(attempt, { recursive: true, force: true });
      throw error;
    }
    return path;
  }

  discard(path: string): void {
    this.#origins.delete(path);
    rmSync(dirname(path), { recursive: true, force: true });
  }

  async inCheckout(path: string, args: string[], what: string, okCodes: number[] = [0]): Promise<string> {
    this.#sanitise(path);
    try {
      const { stdout } = await run("git", ["-C", path, ...args], { env: gitEnvironment(this.#home, undefined), maxBuffer: 512 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message: string };
      if (typeof failure.code === "number" && okCodes.includes(failure.code)) return String(failure.stdout ?? "");
      const stderr = String(failure.stderr ?? "").trim();
      throw new Error(`${what} in ${path} failed: ${stderr || failure.message}`);
    }
  }

  async push(path: string, repo: string, branch: string, token: string): Promise<void> {
    if (!/^proseco\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(branch) || branch.includes("..") || branch.endsWith(".lock")) {
      throw new Error(`refusing to push "${branch}": only proseco/* branches are ever pushed`);
    }
    this.#sanitise(path);
    mkdirSync(this.#home, { recursive: true });
    try {
      await run("git", ["-C", path, "push", "--quiet", "--force", this.#options.remoteUrl(repo), `HEAD:refs/heads/${branch}`], {
        env: gitEnvironment(this.#home, token),
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`git push of ${branch} to ${repo} failed: ${stderr.split(token).join("***") || (error as Error).message}`);
    }
  }

  async #plain(args: string[], what: string): Promise<void> {
    mkdirSync(this.#home, { recursive: true });
    try {
      await run("git", args, { env: gitEnvironment(this.#home, undefined), maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`${what} failed: ${stderr || (error as Error).message}`);
    }
  }

  #sanitise(path: string): void {
    const git = join(path, ".git");
    if (!existsSync(git) || !statSync(git).isDirectory()) return;
    const origin = this.#origins.get(path) ?? "";
    writeFileSync(join(git, "config"), `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    rmSync(join(git, "hooks"), { recursive: true, force: true });
    rmSync(join(git, "commondir"), { force: true });
  }
}
