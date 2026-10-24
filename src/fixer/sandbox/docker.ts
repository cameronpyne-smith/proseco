import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ATTEMPT_LABEL = "proseco.attempt";
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_SECONDS = 1;
const CLIENT_GRACE_MS = 15_000;

export interface RunSpec {
  name: string;
  image: string;
  network: string;
  attempt: string;
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  binds?: string[];
  tmpfs?: string[];
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  command: string[];
}

export interface BuildSpec {
  tag: string;
  dockerfile: string;
  context: string;
  buildArgs: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export function networkCreateArgs(name: string, internal: boolean, attempt: string): string[] {
  return ["network", "create", "--label", `${ATTEMPT_LABEL}=${attempt}`, ...(internal ? ["--internal"] : []), name];
}

export function runArgs(spec: RunSpec): string[] {
  const args = ["run", "-d", "--name", spec.name, "--network", spec.network, "--label", `${ATTEMPT_LABEL}=${spec.attempt}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  if (spec.user) args.push("--user", spec.user);
  if (spec.workdir) args.push("--workdir", spec.workdir);
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push("--env", `${key}=${value}`);
  for (const bind of spec.binds ?? []) args.push("--volume", bind);
  for (const mount of spec.tmpfs ?? []) args.push("--tmpfs", mount);
  if (spec.memory) args.push("--memory", spec.memory);
  if (spec.cpus !== undefined) args.push("--cpus", String(spec.cpus));
  if (spec.pidsLimit !== undefined) args.push("--pids-limit", String(spec.pidsLimit));
  return [...args, spec.image, ...spec.command];
}

export function execArgs(container: string, command: string[], timeoutMs: number): string[] {
  return ["exec", container, "timeout", "-k", String(KILL_GRACE_SECONDS), `${timeoutMs / 1000}s`, ...command];
}

export function buildArgs(spec: BuildSpec): string[] {
  const args = ["build", "--tag", spec.tag, "--file", spec.dockerfile];
  for (const [key, value] of Object.entries(spec.buildArgs)) args.push("--build-arg", `${key}=${value}`);
  return [...args, spec.context];
}

class Capture {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Buffer): void {
    const room = this.#limit - this.#size;
    if (chunk.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = chunk.subarray(0, room);
    this.#chunks.push(kept);
    this.#size += kept.length;
  }

  text(): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return this.truncated ? `${text}\n[output truncated at ${this.#limit} bytes]` : text;
  }
}

export class Docker {
  readonly #binary: string;

  constructor(binary = "docker") {
    this.#binary = binary;
  }

  async #docker(args: string[], what: string): Promise<string> {
    try {
      const { stdout } = await run(this.#binary, args, { maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`docker ${what} failed: ${stderr || (error as Error).message}`);
    }
  }

  #rootless: Promise<boolean> | null = null;

  rootless(): Promise<boolean> {
    this.#rootless ??= this.#docker(["info", "--format", "{{.SecurityOptions}}"], "info").then((options) => options.includes("name=rootless"));
    return this.#rootless;
  }

  async info(): Promise<string> {
    return (await this.#docker(["info", "--format", "{{.ServerVersion}}"], "info")).trim();
  }

  async networkCreate(name: string, internal: boolean, attempt: string): Promise<void> {
    await this.#docker(networkCreateArgs(name, internal, attempt), `network create ${name}`);
  }

  async networkRemove(name: string): Promise<void> {
    await this.#docker(["network", "rm", name], `network rm ${name}`);
  }

  async networkConnect(network: string, container: string): Promise<void> {
    await this.#docker(["network", "connect", network, container], `network connect ${network} ${container}`);
  }

  async imageExists(reference: string): Promise<boolean> {
    try {
      await run(this.#binary, ["image", "inspect", reference]);
      return true;
    } catch {
      return false;
    }
  }

  async build(spec: BuildSpec): Promise<void> {
    await this.#docker(buildArgs(spec), `build ${spec.tag}`);
  }

  async run(spec: RunSpec): Promise<string> {
    return (await this.#docker(runArgs(spec), `run ${spec.name}`)).trim();
  }

  async logs(container: string): Promise<string> {
    return this.#docker(["logs", container], `logs ${container}`);
  }

  async stop(container: string, graceSeconds: number): Promise<void> {
    await this.#docker(["stop", "--time", String(graceSeconds), container], `stop ${container}`);
  }

  async rm(container: string): Promise<void> {
    await this.#docker(["rm", "--force", container], `rm ${container}`);
  }

  async listByLabel(kind: "container" | "network"): Promise<{ id: string; created: Date }[]> {
    const listing = kind === "container" ? ["ps", "--all", "--quiet"] : ["network", "ls", "--quiet"];
    const ids = (await this.#docker([...listing, "--filter", `label=${ATTEMPT_LABEL}`], `list ${kind}s`)).split("\n").filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await this.#docker([kind, "inspect", "--format", "{{.Id}} {{.Created}}", ...ids], `inspect ${kind}s`);
    return inspected.split("\n").filter(Boolean).map((line) => {
      const [id, created] = line.split(" ");
      return { id: id!, created: new Date(created!) };
    });
  }

  exec(container: string, command: string[], timeoutMs: number, limit = DEFAULT_OUTPUT_LIMIT): Promise<ExecResult> {
    const stdout = new Capture(limit);
    const stderr = new Capture(limit);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, execArgs(container, command, timeoutMs), { stdio: ["ignore", "pipe", "pipe"] });
      let clientTimedOut = false;
      const guard = setTimeout(() => {
        clientTimedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs + CLIENT_GRACE_MS);
      child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
      child.on("error", (error) => {
        clearTimeout(guard);
        reject(new Error(`docker exec in ${container} failed: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(guard);
        const exitCode = code ?? 137;
        const timedOut = clientTimedOut || ((exitCode === 124 || exitCode === 137) && Date.now() - started >= timeoutMs);
        resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated || stderr.truncated, timedOut });
      });
    });
  }
}
