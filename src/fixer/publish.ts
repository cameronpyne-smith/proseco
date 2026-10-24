import { rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { dirname as posixDirname, join as posixJoin } from "node:path/posix";
import { workspaceMembers } from "./ecosystems/npm.ts";
import type { GitStore } from "./git.ts";

const NEVER = ".github/workflows/";
const CHUNK = 200;
const LITERAL = "--literal-pathspecs";

type CheckoutGit = Pick<GitStore, "inCheckout">;

export interface StatusEntry {
  path: string;
  untracked: boolean;
}

export interface CommitResult {
  sha: string;
  files: string[];
}

function statusEntries(output: string): StatusEntry[] {
  const parts = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    entries.push({ path: part.slice(3), untracked: code === "??" });
    if (code.includes("R") || code.includes("C")) {
      const original = parts[++index];
      if (original) entries.push({ path: original, untracked: false });
    }
  }
  return entries;
}

export function parseStatus(output: string): string[] {
  return statusEntries(output).map((entry) => entry.path);
}

export function allowedFiles(lockfile: string, lockfileText: string): Set<string> {
  const directory = posixDirname(lockfile);
  const inDirectory = (file: string) => (directory === "." ? file : posixJoin(directory, file));
  const files = ["package.json", "package-lock.json", "npm-shrinkwrap.json"].map(inDirectory);
  for (const member of workspaceMembers(lockfileText)) files.push(inDirectory(posixJoin(member, "package.json")));
  return new Set(files);
}

export function isAllowed(allowed: Set<string>, path: string): boolean {
  return allowed.has(path) && !path.startsWith(NEVER);
}

export function splitPaths(paths: string[], allowed: Set<string>): { allowed: string[]; discarded: string[] } {
  const unique = [...new Set(paths)];
  return { allowed: unique.filter((path) => isAllowed(allowed, path)), discarded: unique.filter((path) => !isAllowed(allowed, path)) };
}

async function changes(git: CheckoutGit, path: string): Promise<StatusEntry[]> {
  return statusEntries(await git.inCheckout(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "git status"));
}

function removeEmptyDirectories(root: string, files: string[]): void {
  const directories = new Set<string>();
  for (const file of files) for (let directory = dirname(file); directory !== "." && directory !== "/"; directory = dirname(directory)) directories.add(directory);
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(root, directory));
    } catch {
      continue;
    }
  }
}

export async function discardOthers(git: CheckoutGit, path: string, base: string, allowed: Set<string>): Promise<string[]> {
  await git.inCheckout(path, ["reset", "-q", base], "git reset");
  const discard = (await changes(git, path)).filter((entry) => !isAllowed(allowed, entry.path));
  const tracked = discard.filter((entry) => !entry.untracked).map((entry) => entry.path);
  for (let index = 0; index < tracked.length; index += CHUNK) {
    await git.inCheckout(path, [LITERAL, "checkout", "--", ...tracked.slice(index, index + CHUNK)], "git checkout");
  }
  const untracked = discard.filter((entry) => entry.untracked).map((entry) => entry.path);
  for (const file of untracked) rmSync(join(path, file), { force: true });
  removeEmptyDirectories(path, untracked);
  return discard.map((entry) => entry.path);
}

export async function commitAllowed(git: CheckoutGit, path: string, options: { bot: string; message: string; allowed: Set<string> }): Promise<CommitResult | null> {
  const stage = splitPaths((await changes(git, path)).map((entry) => entry.path), options.allowed).allowed;
  if (stage.length === 0) return null;
  for (let index = 0; index < stage.length; index += CHUNK) {
    await git.inCheckout(path, [LITERAL, "add", "--", ...stage.slice(index, index + CHUNK)], "git add");
  }
  const identity = `${options.bot}[bot]`;
  const email = `${identity}@users.noreply.github.com`;
  await git.inCheckout(path, ["-c", `user.name=${identity}`, "-c", `user.email=${email}`, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", options.message], "git commit");
  const sha = (await git.inCheckout(path, ["rev-parse", "HEAD"], "git rev-parse")).trim();
  const files = (await git.inCheckout(path, ["show", "--name-only", "--format=", "HEAD"], "git show")).split("\n").filter(Boolean);
  return { sha, files };
}
