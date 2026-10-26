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

export interface ExecOptions {
  limit?: number;
  keep?: "head" | "headtail";
  input?: Buffer | string;
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

export function execArgs(container: string, command: string[], timeoutMs: number, input = false): string[] {
  return ["exec", ...(input ? ["--interactive"] : []), container, "timeout", "-k", String(KILL_GRACE_SECONDS), `${timeoutMs / 1000}s`, ...command];
}

export function buildArgs(spec: BuildSpec): string[] {
  const args = ["build", "--tag", spec.tag, "--file", spec.dockerfile];
  for (const [key, value] of Object.entries(spec.buildArgs)) args.push("--build-arg", `${key}=${value}`);
  return [...args, spec.context];
}

class Capture {
  readonly #limit: number;
  readonly #keepTail: boolean;
  #chunks: Buffer[] = [];
  #size = 0;
  #tail: Buffer[] = [];
  #tailSize = 0;
  #omitted = 0;
  truncated = false;

  constructor(limit: number, keep: "head" | "headtail" = "head") {
    this.#limit = limit;
    this.#keepTail = keep === "headtail";
  }

  get #headLimit(): number {
    return this.#keepTail ? Math.ceil(this.#limit / 2) : this.#limit;
  }

  add(chunk: Buffer): void {
    const room = this.#headLimit - this.#size;
    let rest = chunk;
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      this.#chunks.push(kept);
      this.#size += kept.length;
      rest = chunk.subarray(kept.length);
    }
    if (rest.length === 0) return;
    this.truncated = true;
    if (!this.#keepTail) return;
    const tailLimit = this.#limit - this.#headLimit;
    this.#tail.push(rest);
    this.#tailSize += rest.length;
    while (this.#tailSize > tailLimit && this.#tail.length > 0) {
      const first = this.#tail[0]!;
      const excess = this.#tailSize - tailLimit;
      if (first.length <= excess) {
        this.#tail.shift();
        this.#tailSize -= first.length;
        this.#omitted += first.length;
      } else {
        this.#tail[0] = first.subarray(excess);
        this.#tailSize -= excess;
        this.#omitted += excess;
      }
    }
  }

  bytes(): Buffer {
    return this.#keepTail ? Buffer.concat([...this.#chunks, ...this.#tail]) : Buffer.concat(this.#chunks);
  }

  text(): string {
    if (!this.truncated) return Buffer.concat(this.#chunks).toString("utf8");
    if (!this.#keepTail) return `${Buffer.concat(this.#chunks).toString("utf8")}\n[output truncated at ${this.#limit} bytes]`;
    return `${Buffer.concat(this.#chunks).toString("utf8")}\n[${this.#omitted} bytes omitted from the middle of the output]\n${Buffer.concat(this.#tail).toString("utf8")}`;
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

  async exec(container: string, command: string[], timeoutMs: number, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.#exec(container, command, timeoutMs, options);
    return { ...result, stdout: result.stdout.text(), stderr: result.stderr.text(), truncated: result.stdout.truncated || result.stderr.truncated };
  }

  async execBytes(container: string, command: string[], timeoutMs: number, limit: number): Promise<Buffer> {
    const result = await this.#exec(container, command, timeoutMs, { limit });
    const what = `${command.join(" ")} in ${container}`;
    if (result.timedOut) throw new Error(`${what} timed out after ${timeoutMs / 1000} s`);
    if (result.stdout.truncated) throw new Error(`${what} wrote more than ${limit} bytes`);
    if (result.exitCode !== 0) throw new Error(`${what} exited with ${result.exitCode}: ${result.stderr.text().trim()}`);
    return result.stdout.bytes();
  }

  #exec(container: string, command: string[], timeoutMs: number, options: ExecOptions): Promise<{ exitCode: number; stdout: Capture; stderr: Capture; timedOut: boolean }> {
    const stdout = new Capture(options.limit ?? DEFAULT_OUTPUT_LIMIT, options.keep);
    const stderr = new Capture(options.keep === "headtail" ? (options.limit ?? DEFAULT_OUTPUT_LIMIT) : DEFAULT_OUTPUT_LIMIT, options.keep);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, execArgs(container, command, timeoutMs, options.input !== undefined), { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let clientTimedOut = false;
      const guard = setTimeout(() => {
        clientTimedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs + CLIENT_GRACE_MS);
      child.stdout!.on("data", (chunk: Buffer) => stdout.add(chunk));
      child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));
      if (child.stdin) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input);
      }
      child.on("error", (error) => {
        clearTimeout(guard);
        reject(new Error(`docker exec in ${container} failed: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(guard);
        const exitCode = code ?? 137;
        const timedOut = clientTimedOut || ((exitCode === 124 || exitCode === 137) && Date.now() - started >= timeoutMs);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
    });
  }
}
