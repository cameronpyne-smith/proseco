import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./ollama.ts";
import type { RunResult } from "../sandbox/sandbox.ts";

export const CHANGE_HOWS = ["direct-bump", "parent-bump", "override"] as const;

export interface FinishChange {
  package: string;
  from: string;
  to: string;
  how: (typeof CHANGE_HOWS)[number];
}

export interface FinishArgs {
  summary: string;
  changes: FinishChange[];
}

export interface ToolEnv {
  root: string;
  commandTimeoutMs: number;
  git(args: string[], okCodes?: number[]): Promise<string>;
  run(command: string[], timeoutMs: number): Promise<RunResult>;
}

export interface ToolResult {
  content: string;
  finish?: FinishArgs;
}

const LARGE_FILE_BYTES = 24 * 1024;
const LARGE_FILE_LINES = 200;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_READ_CHARS = 60_000;
const SEARCH_LINES = 200;
const DEFAULT_RUN_SECONDS = 300;
const RUN_STREAM_CHARS = 12_000;
const NOT_EXPANDED = new Set(["node_modules", ".git"]);

class ToolError extends Error {}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  fn(
    "read_file",
    "Read a file from the repository with numbered lines. A file over 24 KB read without a range returns only its first 200 lines; use start and end to read the rest.",
    {
      path: { type: "string", description: "path relative to the repository root" },
      start: { type: "integer", description: "first line to return, 1-based" },
      end: { type: "integer", description: "last line to return, inclusive" },
    },
    ["path"],
  ),
  fn(
    "list_dir",
    "List one directory. Directories end with a slash. node_modules and .git are listed but never expanded.",
    { path: { type: "string", description: "directory relative to the repository root; empty for the root" } },
    [],
  ),
  fn(
    "search",
    "Search file contents with an extended regular expression (git grep -E). Returns at most 200 lines as path:line:text. node_modules is skipped.",
    { pattern: { type: "string" }, path: { type: "string", description: "optional directory or file to limit the search to" } },
    ["pattern"],
  ),
  fn(
    "write_file",
    "Write a whole file, replacing it if it exists. Parent directories are created.",
    { path: { type: "string" }, content: { type: "string" } },
    ["path", "content"],
  ),
  fn(
    "edit_file",
    "Replace one piece of text in a file. old must occur exactly once in the file; include surrounding lines to make it unique.",
    { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
    ["path", "old", "new"],
  ),
  fn(
    "run",
    "Run a shell command (sh -c) in the sandbox container, in the repository root. The container reaches package registries and nothing else. Returns the exit code, stdout and stderr.",
    {
      command: { type: "string" },
      timeout_seconds: { type: "integer", description: "default 300; capped at the configured command limit" },
    },
    ["command"],
  ),
  fn(
    "finish",
    "Call once when the work is done, or when you cannot make further progress. summary is for a reviewer, as long as the task asks. changes lists every package version change you made.",
    {
      summary: { type: "string" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            package: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            how: { type: "string", enum: [...CHANGE_HOWS] },
          },
          required: ["package", "from", "to", "how"],
        },
      },
    },
    ["summary", "changes"],
  ),
];

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new ToolError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function lineNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new ToolError(`${name} must be a positive integer`);
  return number;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function confine(env: ToolEnv, input: unknown, options: { write?: boolean } = {}): { absolute: string; relative: string } {
  const path = input === undefined || input === null ? "" : text(input, "path", true);
  if (isAbsolute(path)) throw new ToolError(`absolute paths are not allowed: "${path}"; use a path relative to the repository root`);
  const root = realpathSync(env.root);
  const absolute = resolve(env.root, path === "" ? "." : path);
  const rel = relative(resolve(env.root), absolute);
  const leaves = () => new ToolError(`"${path}" leaves the repository directory; only paths inside it can be used`);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw leaves();
  let probe = absolute;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw leaves();
  }
  if (!inside(root, real)) throw leaves();
  if (options.write && (rel === ".git" || rel.startsWith(`.git${sep}`))) throw new ToolError(`${path} is inside .git, which cannot be written`);
  return { absolute, relative: rel === "" ? "." : rel };
}

function existing(env: ToolEnv, input: unknown): { absolute: string; relative: string; isDirectory: boolean; size: number } {
  const target = confine(env, input);
  try {
    const stat = statSync(target.absolute);
    return { ...target, isDirectory: stat.isDirectory(), size: stat.size };
  } catch {
    throw new ToolError(`${text(input, "path", true)} does not exist`);
  }
}

function numbered(lines: string[], from: number): string {
  return lines.map((line, index) => `${from + index}\t${line}`).join("\n");
}

function readFile(env: ToolEnv, args: Record<string, unknown>): string {
  const file = existing(env, args["path"]);
  const path = text(args["path"], "path");
  if (file.isDirectory) throw new ToolError(`${path} is a directory; use list_dir`);
  if (file.size > MAX_FILE_BYTES) throw new ToolError(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; use search or run`);
  const start = lineNumber(args["start"], "start");
  const end = lineNumber(args["end"], "end");
  const content = readFileSync(file.absolute, "utf8");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let output: string;
  if (start === undefined && end === undefined) {
    if (file.size > LARGE_FILE_BYTES) {
      output = `${numbered(lines.slice(0, LARGE_FILE_LINES), 1)}\n[showing lines 1-${Math.min(LARGE_FILE_LINES, lines.length)} of ${lines.length}; the file is larger than 24 KB, call read_file with start and end for the rest]`;
    } else {
      output = numbered(lines, 1);
    }
  } else {
    const first = start ?? 1;
    if (first > lines.length) throw new ToolError(`${path} has ${lines.length} lines; start ${first} is past the end`);
    output = numbered(lines.slice(first - 1, end ?? lines.length), first);
  }
  return output.length > MAX_READ_CHARS ? `${output.slice(0, MAX_READ_CHARS)}\n[output cut at ${MAX_READ_CHARS} characters; read a narrower range]` : output;
}

function listDir(env: ToolEnv, args: Record<string, unknown>): string {
  const directory = existing(env, args["path"]);
  const shown = args["path"] === undefined || args["path"] === "" ? "." : text(args["path"], "path");
  if (!directory.isDirectory) throw new ToolError(`${shown} is a file; use read_file`);
  const name = directory.relative.split(sep).at(-1)!;
  if (NOT_EXPANDED.has(name)) return `${shown} is not expanded; read a specific file in it, use search, or use run`;
  const entries = readdirSync(directory.absolute, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryLink(resolve(directory.absolute, entry.name))) ? `${entry.name}/` : entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "(empty)" : entries.join("\n");
}

function isDirectoryLink(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function search(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  if (args["pattern"] === undefined) throw new ToolError("pattern is required");
  const pattern = text(args["pattern"], "pattern");
  const target = confine(env, args["path"]);
  let output: string;
  try {
    output = await env.git(["grep", "--untracked", "-I", "-n", "-E", "--no-color", "-e", pattern, "--", target.relative, ":(exclude,glob)**/node_modules/**"], [0, 1]);
  } catch (error) {
    throw new ToolError((error as Error).message);
  }
  const lines = output.split("\n").filter(Boolean);
  if (lines.length === 0) return "no matches";
  if (lines.length <= SEARCH_LINES) return lines.join("\n");
  return `${lines.slice(0, SEARCH_LINES).join("\n")}\n[${lines.length - SEARCH_LINES} more lines not shown; narrow the pattern or the path]`;
}

function writeFile(env: ToolEnv, args: Record<string, unknown>): string {
  const path = text(args["path"], "path");
  const content = text(args["content"], "content", true);
  const target = confine(env, path, { write: true });
  mkdirSync(dirname(target.absolute), { recursive: true });
  writeFileSync(target.absolute, content);
  return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
}

function editFile(env: ToolEnv, args: Record<string, unknown>): string {
  const path = text(args["path"], "path");
  const old = text(args["old"], "old");
  const replacement = text(args["new"], "new", true);
  const target = confine(env, path, { write: true });
  let content: string;
  try {
    content = readFileSync(target.absolute, "utf8");
  } catch {
    throw new ToolError(`${path} does not exist`);
  }
  const count = content.split(old).length - 1;
  if (count !== 1) {
    throw new ToolError(`old text occurs ${count} times in ${path}; it must occur exactly once${count > 1 ? ": include surrounding lines to make it unique" : ""}`);
  }
  writeFileSync(target.absolute, content.replace(old, () => replacement));
  return `edited ${path}`;
}

function tail(value: string): string {
  return value.length <= RUN_STREAM_CHARS ? value : `[earlier output dropped]\n${value.slice(-RUN_STREAM_CHARS)}`;
}

async function run(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  const command = text(args["command"], "command");
  const requested = args["timeout_seconds"] === undefined ? DEFAULT_RUN_SECONDS : Number(args["timeout_seconds"]);
  if (!Number.isFinite(requested) || requested <= 0) throw new ToolError("timeout_seconds must be a positive number");
  const timeoutMs = Math.min(requested * 1000, env.commandTimeoutMs);
  const result = await env.run(["sh", "-c", command], timeoutMs);
  const lines = [`exit code: ${result.exitCode}${result.timedOut ? ` (timed out after ${timeoutMs / 1000} s)` : ""}${result.truncated ? " (output truncated)" : ""}`];
  if (result.stdout) lines.push("--- stdout ---", tail(result.stdout.replace(/\n$/, "")));
  if (result.stderr) lines.push("--- stderr ---", tail(result.stderr.replace(/\n$/, "")));
  return lines.join("\n");
}

export function parseFinish(args: Record<string, unknown>): FinishArgs | string {
  const fail = (message: string) => message;
  const summary = args["summary"];
  if (typeof summary !== "string" || summary.trim() === "") return fail("summary must be a non-empty string");
  const raw = args["changes"];
  if (!Array.isArray(raw)) return fail("changes must be a list of { package, from, to, how }");
  const changes: FinishChange[] = [];
  for (const [index, item] of raw.entries()) {
    const change = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    for (const key of ["package", "from", "to"]) {
      if (typeof change[key] !== "string" || change[key].trim() === "") return fail(`changes[${index}].${key} must be a non-empty string`);
    }
    if (!CHANGE_HOWS.includes(change["how"] as FinishChange["how"])) return fail(`changes[${index}].how must be one of ${CHANGE_HOWS.join(", ")}`);
    changes.push({ package: change["package"] as string, from: change["from"] as string, to: change["to"] as string, how: change["how"] as FinishChange["how"] });
  }
  return { summary: summary.trim(), changes };
}

export async function executeTool(env: ToolEnv, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file":
        return { content: readFile(env, args) };
      case "list_dir":
        return { content: listDir(env, args) };
      case "search":
        return { content: await search(env, args) };
      case "write_file":
        return { content: writeFile(env, args) };
      case "edit_file":
        return { content: editFile(env, args) };
      case "run":
        return { content: await run(env, args) };
      case "finish": {
        const parsed = parseFinish(args);
        if (typeof parsed === "string") return { content: `error: invalid finish arguments: ${parsed}; call finish again with corrected arguments` };
        return { content: "finished", finish: parsed };
      }
      default:
        return { content: `error: unknown tool "${name}"; the tools are ${TOOL_DEFINITIONS.map((tool) => tool.function.name).join(", ")}` };
    }
  } catch (error) {
    return { content: `error: ${(error as Error).message}` };
  }
}
