import { posix } from "node:path";
import type { ToolDefinition } from "./ollama.ts";
import type { ExecOptions } from "../sandbox/docker.ts";
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
  commandTimeoutMs: number;
  run(command: string[], timeoutMs: number, options?: ExecOptions): Promise<RunResult>;
  wrote?(path: string): void;
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
const FILE_TIMEOUT_MS = 60_000;
const MISSING = 3;
const DIRECTORY = 4;
const NOT_DIRECTORY = 5;
const TOO_LARGE = 6;
const READ_SCRIPT = `[ -e "$1" ] || exit ${MISSING}; [ -d "$1" ] && exit ${DIRECTORY}; [ "$(stat -L -c %s -- "$1")" -gt "$2" ] && exit ${TOO_LARGE}; exec cat -- "$1"`;
const LIST_SCRIPT = `[ -e "$1" ] || exit ${MISSING}; [ -d "$1" ] || exit ${NOT_DIRECTORY}; exec find "$1" -mindepth 1 -maxdepth 1 -printf '%f\\t%Y\\n'`;
const SEARCH_SCRIPT = `exec git grep --untracked -I -n -E --no-color -e "$1" -- "$2" ':(exclude,glob)**/node_modules/**'`;
const WRITE_SCRIPT = `mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"`;

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

function confine(input: unknown, options: { write?: boolean } = {}): { shown: string; relative: string; operand: string } {
  const path = input === undefined || input === null ? "" : text(input, "path", true);
  if (posix.isAbsolute(path)) throw new ToolError(`absolute paths are not allowed: "${path}"; use a path relative to the repository root`);
  const rel = posix.normalize(path === "" ? "." : path).replace(/\/+$/, "") || ".";
  if (rel === ".." || rel.startsWith("../")) throw new ToolError(`"${path}" leaves the repository directory; only paths inside it can be used`);
  if (options.write && (rel === ".git" || rel.startsWith(".git/"))) throw new ToolError(`${path} is inside .git, which cannot be written`);
  return { shown: path === "" ? "." : path, relative: rel, operand: rel === "." ? "." : `./${rel}` };
}

async function sh(env: ToolEnv, script: string, args: string[], options: ExecOptions = {}): Promise<RunResult> {
  const result = await env.run(["sh", "-c", script, "sh", ...args], FILE_TIMEOUT_MS, options);
  if (result.timedOut) throw new ToolError(`the file operation timed out after ${FILE_TIMEOUT_MS / 1000} s`);
  return result;
}

function failed(result: RunResult): ToolError {
  return new ToolError(result.stderr.trim() || `exit code ${result.exitCode}`);
}

function numbered(lines: string[], from: number): string {
  return lines.map((line, index) => `${from + index}\t${line}`).join("\n");
}

async function contents(env: ToolEnv, input: unknown): Promise<{ path: string; operand: string; content: string }> {
  const target = confine(input);
  const path = text(input, "path");
  const result = await sh(env, READ_SCRIPT, [target.operand, String(MAX_FILE_BYTES)], { limit: MAX_FILE_BYTES + 1 });
  if (result.exitCode === MISSING) throw new ToolError(`${path} does not exist`);
  if (result.exitCode === DIRECTORY) throw new ToolError(`${path} is a directory; use list_dir`);
  if (result.exitCode === TOO_LARGE) throw new ToolError(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; use search or run`);
  if (result.exitCode !== 0) throw failed(result);
  return { path, operand: target.operand, content: result.stdout };
}

async function readFile(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  const start = lineNumber(args["start"], "start");
  const end = lineNumber(args["end"], "end");
  const { path, content } = await contents(env, args["path"]);
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let output: string;
  if (start === undefined && end === undefined) {
    if (Buffer.byteLength(content) > LARGE_FILE_BYTES) {
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

async function listDir(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  const directory = confine(args["path"]);
  if (NOT_EXPANDED.has(directory.relative.split("/").at(-1)!)) return `${directory.shown} is not expanded; read a specific file in it, use search, or use run`;
  const result = await sh(env, LIST_SCRIPT, [directory.operand]);
  if (result.exitCode === MISSING) throw new ToolError(`${directory.shown} does not exist`);
  if (result.exitCode === NOT_DIRECTORY) throw new ToolError(`${directory.shown} is a file; use read_file`);
  if (result.exitCode !== 0) throw failed(result);
  const entries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.lastIndexOf("\t");
      return line.slice(tab + 1) === "d" ? `${line.slice(0, tab)}/` : line.slice(0, tab);
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "(empty)" : entries.join("\n");
}

async function search(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  if (args["pattern"] === undefined) throw new ToolError("pattern is required");
  const pattern = text(args["pattern"], "pattern");
  const target = confine(args["path"]);
  const result = await sh(env, SEARCH_SCRIPT, [pattern, target.relative]);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw failed(result);
  const lines = result.stdout.split("\n").filter(Boolean);
  if (lines.length === 0) return "no matches";
  if (lines.length <= SEARCH_LINES) return lines.join("\n");
  return `${lines.slice(0, SEARCH_LINES).join("\n")}\n[${lines.length - SEARCH_LINES} more lines not shown; narrow the pattern or the path]`;
}

async function store(env: ToolEnv, target: { relative: string; operand: string }, content: string): Promise<void> {
  const result = await sh(env, WRITE_SCRIPT, [target.operand], { input: content });
  if (result.exitCode !== 0) throw failed(result);
  env.wrote?.(target.relative);
}

async function writeFile(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  const path = text(args["path"], "path");
  const content = text(args["content"], "content", true);
  await store(env, confine(path, { write: true }), content);
  return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
}

async function editFile(env: ToolEnv, args: Record<string, unknown>): Promise<string> {
  const path = text(args["path"], "path");
  const old = text(args["old"], "old");
  const replacement = text(args["new"], "new", true);
  const target = confine(path, { write: true });
  const { content } = await contents(env, path);
  const count = content.split(old).length - 1;
  if (count !== 1) {
    throw new ToolError(`old text occurs ${count} times in ${path}; it must occur exactly once${count > 1 ? ": include surrounding lines to make it unique" : ""}`);
  }
  await store(env, target, content.replace(old, () => replacement));
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
        return { content: await readFile(env, args) };
      case "list_dir":
        return { content: await listDir(env, args) };
      case "search":
        return { content: await search(env, args) };
      case "write_file":
        return { content: await writeFile(env, args) };
      case "edit_file":
        return { content: await editFile(env, args) };
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
