import { DEFAULT_PROXY_ALLOW, DEFAULT_SANDBOX_LIMITS, type SandboxLimits } from "../../core/config.ts";
import { Docker, type ExecResult } from "./docker.ts";
import { ensureProxyImage } from "./images.ts";

const PROXY_PORT = 3128;
const PIDS_LIMIT = 2048;
const PROXY_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SWEEP_AGE_MS = 60 * 60 * 1000;

export interface StartOptions {
  worktree: string;
  image: string;
  allow?: string[];
  attemptId: string;
  uid: number;
  gid: number;
  limits?: SandboxLimits;
  docker?: Docker;
}

export type RunResult = ExecResult;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Sandbox {
  readonly #docker: Docker;
  readonly #network: string;
  readonly #proxy: string;
  readonly #box: string;

  private constructor(docker: Docker, network: string, proxy: string, box: string) {
    this.#docker = docker;
    this.#network = network;
    this.#proxy = proxy;
    this.#box = box;
  }

  static async start(options: StartOptions): Promise<Sandbox> {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(options.attemptId)) throw new Error(`"${options.attemptId}" is not a valid attempt id`);
    const docker = options.docker ?? new Docker();
    const network = `proseco-${options.attemptId}`;
    const sandbox = new Sandbox(docker, network, `proseco-proxy-${options.attemptId}`, `proseco-box-${options.attemptId}`);
    const limits = options.limits ?? DEFAULT_SANDBOX_LIMITS;
    const allow = options.allow ?? DEFAULT_PROXY_ALLOW;
    try {
      const proxyImage = await ensureProxyImage(docker);
      await docker.networkCreate(network, true, options.attemptId);
      await docker.run({
        name: sandbox.#proxy,
        image: proxyImage,
        network,
        attempt: options.attemptId,
        memory: "256m",
        pidsLimit: 256,
        command: ["--listen", `0.0.0.0:${PROXY_PORT}`, "--allow", allow.join(",")],
      });
      await docker.networkConnect("bridge", sandbox.#proxy);
      await sandbox.#waitForProxy();
      const proxyUrl = `http://${sandbox.#proxy}:${PROXY_PORT}`;
      await docker.run({
        name: sandbox.#box,
        image: options.image,
        network,
        attempt: options.attemptId,
        user: `${options.uid}:${options.gid}`,
        workdir: "/work",
        env: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: "",
          no_proxy: "",
          NODE_USE_ENV_PROXY: "1",
          HOME: "/tmp/home",
          UV_LINK_MODE: "copy",
          PIP_NO_INPUT: "1",
        },
        binds: [`${options.worktree}:/work`],
        tmpfs: ["/tmp:exec,mode=1777"],
        memory: limits.memory,
        cpus: limits.cpus,
        pidsLimit: PIDS_LIMIT,
        command: ["sleep", "infinity"],
      });
    } catch (error) {
      await sandbox.stop().catch(() => undefined);
      throw error;
    }
    return sandbox;
  }

  async #waitForProxy(): Promise<void> {
    const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.proxyLog()).includes("listening on")) return;
      await sleep(100);
    }
    throw new Error(`the proxy container ${this.#proxy} did not start listening within ${PROXY_READY_TIMEOUT_MS} ms`);
  }

  run(command: string[], timeoutMs: number): Promise<RunResult> {
    return this.#docker.exec(this.#box, command, timeoutMs);
  }

  proxyLog(): Promise<string> {
    return this.#docker.logs(this.#proxy);
  }

  async stop(): Promise<void> {
    const failures: string[] = [];
    for (const container of [this.#box, this.#proxy]) {
      try {
        await this.#docker.rm(container);
      } catch (error) {
        if (!/No such container/i.test((error as Error).message)) failures.push((error as Error).message);
      }
    }
    try {
      await this.#docker.networkRemove(this.#network);
    } catch (error) {
      if (!/not found/i.test((error as Error).message)) failures.push((error as Error).message);
    }
    if (failures.length > 0) throw new Error(`sandbox cleanup incomplete: ${failures.join("; ")}`);
  }

  static async sweep(maxAgeMs = DEFAULT_SWEEP_AGE_MS, docker = new Docker(), now = Date.now()): Promise<{ containers: number; networks: number }> {
    const stale = (entries: { id: string; created: Date }[]) => entries.filter((entry) => now - entry.created.getTime() >= maxAgeMs);
    const containers = stale(await docker.listByLabel("container"));
    for (const container of containers) await docker.rm(container.id);
    const networks = stale(await docker.listByLabel("network"));
    for (const network of networks) await docker.networkRemove(network.id);
    return { containers: containers.length, networks: networks.length };
  }
}
