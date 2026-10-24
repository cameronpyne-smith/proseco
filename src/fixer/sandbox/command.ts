import { declaredToolchain } from "../dryrun.ts";
import { ecosystemFor } from "../ecosystems/ecosystem.ts";
import type { GitStore } from "../git.ts";
import type { FixerConfig } from "../../core/config.ts";
import { Docker } from "./docker.ts";
import { ensureImage, imageFor } from "./images.ts";
import { Sandbox, type RunResult } from "./sandbox.ts";

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface SandboxCommand {
  store: GitStore;
  repo: string;
  lockfile: string;
  command: string[];
  fixer: Pick<FixerConfig, "proxy" | "sandbox">;
}

export interface SandboxOutcome {
  image: string;
  result: RunResult;
}

export async function runInSandbox(input: SandboxCommand): Promise<SandboxOutcome> {
  const ecosystem = ecosystemFor(input.lockfile);
  if (!ecosystem) throw new Error(`${input.lockfile} is not a lockfile of a supported ecosystem`);
  await input.store.fetch(input.repo);
  const sha = await input.store.headSha(input.repo);
  const toolchain = await declaredToolchain(ecosystem, input.lockfile, (path) => input.store.tryShow(input.repo, sha, path));
  const docker = new Docker();
  const image = await ensureImage(docker, imageFor(ecosystem.name, toolchain));
  const worktree = await input.store.worktreeAdd(input.repo, sha);
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({
      worktree,
      image,
      allow: input.fixer.proxy.allow,
      attemptId: `manual-${Date.now().toString(36)}`,
      uid: process.getuid!(),
      gid: process.getgid!(),
      limits: input.fixer.sandbox,
      docker,
    });
    return { image, result: await sandbox.run(input.command, COMMAND_TIMEOUT_MS) };
  } finally {
    try {
      await sandbox?.stop();
    } finally {
      await input.store.worktreeRemove(input.repo, worktree);
    }
  }
}

export function formatOutcome(outcome: SandboxOutcome): string {
  const { result } = outcome;
  const lines = [`image: ${outcome.image}`, `exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`];
  if (result.stdout) lines.push("--- stdout ---", result.stdout.replace(/\n$/, ""));
  if (result.stderr) lines.push("--- stderr ---", result.stderr.replace(/\n$/, ""));
  return lines.join("\n");
}
