import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { TarEntry } from "./tar.ts";

export const NOT_COPIED = ["node_modules", ".venv"];

function relativePath(raw: string): string | null {
  const path = posix.normalize(raw.replace(/\/+$/, ""));
  if (path === "." || path === "") return null;
  if (posix.isAbsolute(path) || path === ".." || path.startsWith("../") || raw.split("/").includes("..")) throw new Error(`${JSON.stringify(raw)} leaves the repository`);
  return path.replace(/^\.\//, "");
}

function skipped(path: string): boolean {
  const parts = path.split("/");
  return parts[0] === ".git" || parts.some((part) => NOT_COPIED.includes(part));
}

function linkTarget(path: string, target: string): string {
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../") || resolved === ".git" || resolved.startsWith(".git/")) {
    throw new Error(`${path} is a symlink to ${JSON.stringify(target)}, outside the repository`);
  }
  return target;
}

function realDirectory(root: string, path: string): void {
  let current = root;
  for (const part of posix.dirname(path).split("/").filter((part) => part !== ".")) {
    current = join(current, part);
    try {
      if (!lstatSync(current).isDirectory()) throw new Error(`${path} is inside ${posix.relative(root, current)}, which is not a directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o755 });
    }
  }
}

export function replaceTree(root: string, entries: TarEntry[]): void {
  const kept = entries.flatMap((entry) => {
    const path = relativePath(entry.path);
    return path === null || skipped(path) ? [] : [{ ...entry, path }];
  });
  const links = kept.flatMap((entry) => (entry.type === "symlink" ? [{ path: entry.path, target: linkTarget(entry.path, entry.target) }] : []));
  for (const name of readdirSync(root)) if (name !== ".git") rmSync(join(root, name), { recursive: true, force: true });
  for (const entry of kept) {
    if (entry.type === "symlink") continue;
    realDirectory(root, entry.path);
    const target = join(root, entry.path);
    if (entry.type === "directory") {
      try {
        mkdirSync(target, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(target).isDirectory()) throw error;
      }
      continue;
    }
    const mode = entry.mode & 0o111 ? 0o755 : 0o644;
    writeFileSync(target, entry.data, { flag: "wx", mode });
    chmodSync(target, mode);
  }
  for (const link of links) {
    realDirectory(root, link.path);
    symlinkSync(link.target, join(root, link.path));
  }
}
