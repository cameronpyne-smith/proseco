import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { TurnLock, type LockChild } from "../src/fixer/lock.ts";

class FakeChild extends EventEmitter implements LockChild {
  stdout = new PassThrough();
  stdin: Writable;
  ended = false;
  killed = false;

  constructor(exitOnEnd: boolean) {
    super();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: (callback) => {
        this.ended = true;
        if (exitOnEnd) this.emit("exit", 0, null);
        callback();
      },
    });
  }

  locked(): void {
    this.stdout.write("locked\n");
  }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function directory(): string {
  return mkdtempSync(join(tmpdir(), "proseco-lock-"));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("turn lock", () => {
  it("holds the lock from the child's first output until stdin is closed, then yields", async () => {
    const children: FakeChild[] = [];
    const paths: string[] = [];
    const log: string[] = [];
    const path = directory();
    const lock = new TurnLock(path, {
      spawn: (target) => {
        paths.push(target);
        const child = new FakeChild(true);
        children.push(child);
        return child;
      },
      log: (line) => void log.push(line),
      yieldMs: 0,
      exitMs: 50,
    });
    let held = false;
    const acquiring = lock.acquire().then((release) => {
      held = true;
      return release;
    });
    await tick();
    assert.equal(held, false);
    assert.deepEqual(paths, [path]);
    children[0]!.locked();
    const release = await acquiring;
    assert.equal(held, true);
    assert.equal(children[0]!.ended, false);
    await release();
    assert.equal(children[0]!.ended, true);
    assert.equal(children[0]!.killed, false);
    assert.deepEqual(log, []);
  });

  it("kills a child that does not exit after stdin closes", async () => {
    const child = new FakeChild(false);
    const lock = new TurnLock(directory(), { spawn: () => child, log: () => {}, yieldMs: 0, exitMs: 10 });
    const acquiring = lock.acquire();
    child.locked();
    const release = await acquiring;
    await release();
    assert.equal(child.killed, true);
  });

  it("runs unlocked, warning once, when the path is unset, missing or not a directory", async () => {
    const log: string[] = [];
    let spawned = 0;
    const spawn = () => {
      spawned++;
      return new FakeChild(true);
    };
    await (await new TurnLock(null, { spawn, log: (line) => void log.push(line) }).acquire())();
    const missing = new TurnLock(join(directory(), "absent"), { spawn, log: (line) => void log.push(line) });
    await (await missing.acquire())();
    await (await missing.acquire())();
    const file = join(directory(), "file");
    writeFileSync(file, "");
    await (await new TurnLock(file, { spawn, log: (line) => void log.push(line) }).acquire())();
    assert.equal(spawned, 0);
    assert.deepEqual(log, [`turn lock: ${missing.path} does not exist, running without it`, `turn lock: ${file} is not a directory, running without it`]);
  });

  it("carries on unlocked when the child exits or fails before taking the lock, and logs a slow acquisition", async () => {
    const log: string[] = [];
    let child = new FakeChild(true);
    let now = 0;
    const lock = new TurnLock(directory(), { spawn: () => child, log: (line) => void log.push(line), yieldMs: 0, exitMs: 10, now: () => now });
    const exiting = lock.acquire();
    child.emit("exit", 1, null);
    await (await exiting)();
    child = new FakeChild(true);
    const failing = lock.acquire();
    child.emit("error", new Error("spawn flock ENOENT"));
    await (await failing)();
    assert.deepEqual(log, ["turn lock: flock exited with code 1, running without it"]);
    child = new FakeChild(true);
    const slow = lock.acquire();
    now = 12_000;
    child.locked();
    await (await slow)();
    assert.deepEqual(log.slice(1), ["turn lock: acquired after 12 s"]);
  });
});

describe("turn lock with the real flock", { skip: !execSync("command -v flock || true", { encoding: "utf8" }).trim() }, () => {
  it("serialises two holders on a directory", async () => {
    const path = directory();
    const log: string[] = [];
    const lock = new TurnLock(path, { log: (line) => void log.push(line), yieldMs: 0 });
    const first = await lock.acquire();
    let secondHeld = false;
    const second = lock.acquire().then((release) => {
      secondHeld = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(secondHeld, false);
    await first();
    await (await second)();
    assert.equal(secondHeld, true);
    assert.deepEqual(log, []);
  });
});
