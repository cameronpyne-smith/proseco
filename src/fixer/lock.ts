import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

export interface LockChild {
  stdout: Readable | null;
  stdin: Writable | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(): boolean;
}

export type Release = () => Promise<void>;

export interface TurnLockOptions {
  spawn?(path: string): LockChild;
  log(line: string): void;
  yieldMs?: number;
  exitMs?: number;
  now?(): number;
}

const DEFAULT_YIELD_MS = 1000;
const DEFAULT_EXIT_MS = 5000;
const SLOW_MS = 1000;

function flockChild(path: string): LockChild {
  return spawn("flock", ["-x", path, "-c", "echo locked; exec cat"], { stdio: ["pipe", "pipe", "ignore"] });
}

const nothing: Release = async () => {};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TurnLock {
  readonly #path: string | null;
  readonly #spawn: (path: string) => LockChild;
  readonly #log: (line: string) => void;
  readonly #yieldMs: number;
  readonly #exitMs: number;
  readonly #now: () => number;
  #warned = false;

  constructor(path: string | null, options: TurnLockOptions) {
    this.#path = path;
    this.#spawn = options.spawn ?? flockChild;
    this.#log = options.log;
    this.#yieldMs = options.yieldMs ?? DEFAULT_YIELD_MS;
    this.#exitMs = options.exitMs ?? DEFAULT_EXIT_MS;
    this.#now = options.now ?? Date.now;
  }

  get path(): string | null {
    return this.#path;
  }

  #unlocked(reason: string): Release {
    if (!this.#warned) this.#log(`turn lock: ${reason}, running without it`);
    this.#warned = true;
    return nothing;
  }

  async acquire(): Promise<Release> {
    const path = this.#path;
    if (!path) return nothing;
    try {
      if (!statSync(path).isDirectory()) return this.#unlocked(`${path} is not a directory`);
    } catch {
      return this.#unlocked(`${path} does not exist`);
    }
    const started = this.#now();
    let child: LockChild;
    try {
      child = this.#spawn(path);
    } catch (error) {
      return this.#unlocked(`cannot run flock: ${(error as Error).message}`);
    }
    let exited = false;
    const exit = new Promise<string>((resolve) => {
      child.on("exit", (code, signal) => {
        exited = true;
        resolve(`flock exited with ${signal ?? `code ${code}`}`);
      });
      child.on("error", (error) => {
        exited = true;
        resolve(`cannot run flock: ${error.message}`);
      });
    });
    const held = new Promise<null>((resolve) => child.stdout?.once("data", () => resolve(null)));
    const failure = await Promise.race([held, exit]);
    if (failure !== null) return this.#unlocked(failure);
    const waited = this.#now() - started;
    if (waited >= SLOW_MS) this.#log(`turn lock: acquired after ${Math.round(waited / 1000)} s`);
    return async () => {
      child.stdin?.end();
      const timer = sleep(this.#exitMs).then(() => {
        if (!exited) child.kill();
      });
      await Promise.race([exit, timer]);
      await sleep(this.#yieldMs);
    };
  }
}
