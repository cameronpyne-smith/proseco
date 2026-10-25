import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceTree } from "../src/fixer/sandbox/copy.ts";
import type { ExecOptions, ExecResult } from "../src/fixer/sandbox/docker.ts";
import { readTar } from "../src/fixer/sandbox/tar.ts";

export class LocalBox {
  readonly work = mkdtempSync(join(tmpdir(), "proseco-box-"));

  async run(command: string[], _timeoutMs: number, options: ExecOptions = {}): Promise<ExecResult> {
    const result = spawnSync(command[0]!, command.slice(1), { cwd: this.work, input: options.input ?? "", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, truncated: false, timedOut: false };
  }

  async load(directory: string): Promise<void> {
    for (const name of readdirSync(this.work)) rmSync(join(this.work, name), { recursive: true, force: true });
    execFileSync("sh", ["-c", `tar -C "$1" --exclude=./.git -cf - . | tar -C "$2" -xf -`, "sh", directory, this.work]);
    execFileSync("git", ["init", "-q", "-b", "proseco"], { cwd: this.work });
  }

  async save(directory: string): Promise<void> {
    replaceTree(directory, readTar(execFileSync("tar", ["-C", this.work, "--exclude=./.git", "--exclude=node_modules", "--exclude=.venv", "-cf", "-", "."], { maxBuffer: 64 * 1024 * 1024 })));
  }

  async stop(): Promise<void> {
    rmSync(this.work, { recursive: true, force: true });
  }
}
