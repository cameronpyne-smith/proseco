import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { executeTool, parseFinish, TOOL_DEFINITIONS, type ToolEnv } from "../src/fixer/agent/tools.ts";
import type { RunResult } from "../src/fixer/sandbox/sandbox.ts";
import { LocalBox } from "./local-box.ts";

interface Fixture {
  root: string;
  outside: string;
  env: ToolEnv;
  ran: { command: string[]; timeoutMs: number }[];
}

let fixture: Fixture;

function setup(runResult: Partial<RunResult> = {}): Fixture {
  const box = new LocalBox();
  const root = box.work;
  const outside = mkdtempSync(join(tmpdir(), "proseco-tools-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const ran: Fixture["ran"] = [];
  const env: ToolEnv = {
    commandTimeoutMs: 10 * 60 * 1000,
    run: async (command, timeoutMs, options) => {
      if (command.length > 3) return box.run(command, timeoutMs, options);
      ran.push({ command, timeoutMs });
      return { exitCode: 0, stdout: "out\n", stderr: "", truncated: false, timedOut: false, ...runResult };
    },
  };
  return { root, outside, env, ran };
}

function call(name: string, args: Record<string, unknown>) {
  return executeTool(fixture.env, name, args);
}

beforeEach(() => {
  fixture = setup();
});

describe("tool definitions", () => {
  it("names every tool in ollama's function shape with a required-arguments list", () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((tool) => tool.function.name),
      ["read_file", "list_dir", "search", "write_file", "edit_file", "run", "finish"],
    );
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.type, "function");
      assert.equal(tool.function.parameters["type"], "object");
    }
  });
});

describe("read_file", () => {
  it("returns numbered lines", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "one\ntwo\nthree\n");
    assert.equal((await call("read_file", { path: "a.txt" })).content, "1\tone\n2\ttwo\n3\tthree");
  });

  it("returns an inclusive line range, clamped to the end of the file", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "one\ntwo\nthree\nfour\n");
    assert.equal((await call("read_file", { path: "a.txt", start: 2, end: 3 })).content, "2\ttwo\n3\tthree");
    assert.equal((await call("read_file", { path: "a.txt", start: "3", end: 99 })).content, "3\tthree\n4\tfour");
  });

  it("shows the first 200 lines of a file over 24 KB read without a range, with a note to read by range", async () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`);
    writeFileSync(join(fixture.root, "big.txt"), lines.join("\n"));
    const { content } = await call("read_file", { path: "big.txt" });
    const shown = content.split("\n");
    assert.ok(shown[0]!.startsWith("1\tline 1 "));
    assert.ok(shown[199]!.startsWith("200\tline 200 "));
    assert.match(shown[200]!, /showing lines 1-200 of 1000.*start and end/);
    assert.equal(shown.length, 201);
    assert.ok((await call("read_file", { path: "big.txt", start: 500, end: 501 })).content.startsWith("500\tline 500 "));
  });

  it("explains a missing file, a directory and a range past the end", async () => {
    mkdirSync(join(fixture.root, "d"));
    writeFileSync(join(fixture.root, "a.txt"), "one\n");
    assert.match((await call("read_file", { path: "nope.txt" })).content, /^error: nope\.txt does not exist/);
    assert.match((await call("read_file", { path: "d" })).content, /^error: d is a directory; use list_dir/);
    assert.match((await call("read_file", { path: "a.txt", start: 5 })).content, /^error: a\.txt has 1 lines/);
    assert.match((await call("read_file", { path: "a.txt", start: 0 })).content, /^error: start must be a positive integer/);
  });

  it("caps the characters returned for a single enormous line", async () => {
    writeFileSync(join(fixture.root, "min.js"), "x".repeat(500_000));
    const { content } = await call("read_file", { path: "min.js", start: 1, end: 1 });
    assert.ok(content.length < 70_000);
    assert.match(content, /output cut at/);
  });
});

describe("file tools", () => {
  it("act only through the sandbox", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "one");
    fixture.env.run = async () => ({ exitCode: 125, stdout: "", stderr: "no sandbox", truncated: false, timedOut: false });
    for (const [name, args] of [["read_file", { path: "a.txt" }], ["list_dir", {}], ["search", { pattern: "one" }], ["write_file", { path: "b.txt", content: "x" }], ["edit_file", { path: "a.txt", old: "one", new: "two" }]] as const) {
      assert.match((await call(name, args)).content, /^error: no sandbox/, name);
    }
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "one");
    assert.equal(existsSync(join(fixture.root, "b.txt")), false);
  });
});

describe("path confinement", () => {
  it("refuses .. segments that leave the directory", async () => {
    const result = await call("read_file", { path: "../outside/secret.txt" });
    assert.match(result.content, /^error: .* leaves the repository directory/);
    assert.equal(result.content.includes("TOPSECRET"), false);
  });

  it("refuses absolute paths even when they point inside the directory", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "one");
    assert.match((await call("read_file", { path: join(fixture.root, "a.txt") })).content, /^error: absolute paths are not allowed/);
    assert.match((await call("list_dir", { path: "/etc" })).content, /^error: absolute paths are not allowed/);
  });

  it("allows a symlink that stays inside", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "one");
    symlinkSync("a.txt", join(fixture.root, "alias"));
    assert.equal((await call("read_file", { path: "alias" })).content, "1\tone");
  });

  it("refuses to write under .git", async () => {
    assert.match((await call("write_file", { path: ".git/config", content: "x" })).content, /^error: .*\.git/);
    assert.match((await call("edit_file", { path: ".git/HEAD", old: "main", new: "x" })).content, /^error: .*\.git/);
  });
});

describe("list_dir", () => {
  it("lists entries sorted, directories with a trailing slash", async () => {
    mkdirSync(join(fixture.root, "src"));
    writeFileSync(join(fixture.root, "b.txt"), "");
    writeFileSync(join(fixture.root, "a.txt"), "");
    assert.equal((await call("list_dir", { path: "" })).content, ".git/\na.txt\nb.txt\nsrc/");
    assert.equal((await call("list_dir", { path: "." })).content, ".git/\na.txt\nb.txt\nsrc/");
    assert.equal((await call("list_dir", {})).content, ".git/\na.txt\nb.txt\nsrc/");
  });

  it("lists node_modules and .git in their parent but does not expand them", async () => {
    mkdirSync(join(fixture.root, "node_modules", "left-pad"), { recursive: true });
    assert.match((await call("list_dir", { path: "" })).content, /\.git\/\nnode_modules\//);
    assert.match((await call("list_dir", { path: "node_modules" })).content, /^node_modules is not expanded/);
    assert.match((await call("list_dir", { path: ".git" })).content, /^\.git is not expanded/);
    assert.equal((await call("list_dir", { path: "node_modules/left-pad" })).content, "(empty)");
  });

  it("explains a missing directory and a file", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "");
    assert.match((await call("list_dir", { path: "nope" })).content, /^error: nope does not exist/);
    assert.match((await call("list_dir", { path: "a.txt" })).content, /^error: a\.txt is a file; use read_file/);
  });
});

describe("search", () => {
  it("greps tracked and untracked files with line numbers, skipping node_modules", async () => {
    writeFileSync(join(fixture.root, "a.js"), "const minimist = require('minimist');\n");
    mkdirSync(join(fixture.root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(fixture.root, "node_modules", "x", "i.js"), "minimist\n");
    assert.equal((await call("search", { pattern: "min[a-z]+" })).content, "a.js:1:const minimist = require('minimist');");
  });

  it("limits the search to a path and reports no matches", async () => {
    mkdirSync(join(fixture.root, "src"));
    writeFileSync(join(fixture.root, "src", "a.js"), "needle\n");
    writeFileSync(join(fixture.root, "b.js"), "needle\n");
    assert.equal((await call("search", { pattern: "needle", path: "src" })).content, "src/a.js:1:needle");
    assert.equal((await call("search", { pattern: "absent" })).content, "no matches");
  });

  it("caps the output at 200 lines and says how many were left out", async () => {
    writeFileSync(join(fixture.root, "many.txt"), Array.from({ length: 250 }, () => "hit").join("\n"));
    const lines = (await call("search", { pattern: "hit" })).content.split("\n");
    assert.equal(lines.length, 201);
    assert.match(lines[200]!, /50 more lines/);
  });

  it("explains an invalid pattern and refuses a path outside", async () => {
    assert.match((await call("search", { pattern: "(" })).content, /^error: /);
    assert.match((await call("search", { pattern: "x", path: "../outside" })).content, /leaves the repository directory/);
    assert.match((await call("search", {})).content, /^error: pattern is required/);
  });
});

describe("write_file and edit_file", () => {
  it("writes a whole file, creating parent directories", async () => {
    const result = await call("write_file", { path: "a/b/c.txt", content: "hello" });
    assert.match(result.content, /wrote 5 bytes to a\/b\/c\.txt/);
    assert.equal(readFileSync(join(fixture.root, "a", "b", "c.txt"), "utf8"), "hello");
  });

  it("requires string content", async () => {
    assert.match((await call("write_file", { path: "a.txt" })).content, /^error: content must be a string/);
  });

  it("replaces text that occurs exactly once", async () => {
    writeFileSync(join(fixture.root, "a.txt"), 'x "1.2.5" y');
    const result = await call("edit_file", { path: "a.txt", old: '"1.2.5"', new: '"$&1.2.8"' });
    assert.match(result.content, /edited a\.txt/);
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), 'x "$&1.2.8" y');
  });

  it("says how many times the text occurs when it is not exactly once", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "aa aa");
    assert.match((await call("edit_file", { path: "a.txt", old: "aa", new: "b" })).content, /^error: old text occurs 2 times in a\.txt; it must occur exactly once/);
    assert.match((await call("edit_file", { path: "a.txt", old: "zz", new: "b" })).content, /^error: old text occurs 0 times in a\.txt/);
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "aa aa");
  });

  it("rejects an empty old text and a missing file", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "aa");
    assert.match((await call("edit_file", { path: "a.txt", old: "", new: "b" })).content, /^error: old must be a non-empty string/);
    assert.match((await call("edit_file", { path: "nope.txt", old: "a", new: "b" })).content, /^error: nope\.txt does not exist/);
  });

  it("reports each path it wrote, relative to the repository root, and nothing for a failed write", async () => {
    const wrote: string[] = [];
    fixture.env.wrote = (path) => wrote.push(path);
    writeFileSync(join(fixture.root, "a.txt"), "aa");
    await call("write_file", { path: "./src//new.js", content: "x" });
    await call("edit_file", { path: "a.txt", old: "aa", new: "b" });
    await call("edit_file", { path: "a.txt", old: "zz", new: "b" });
    await call("write_file", { path: "../escape.txt", content: "x" });
    assert.deepEqual(wrote, ["src/new.js", "a.txt"]);
  });

  it("allows deleting text with an empty replacement", async () => {
    writeFileSync(join(fixture.root, "a.txt"), "abc");
    await call("edit_file", { path: "a.txt", old: "b", new: "" });
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "ac");
  });
});

describe("run", () => {
  it("runs the command under sh -c in the container with a five minute default and returns exit code and output", async () => {
    const { content } = await call("run", { command: "npm ls minimist" });
    assert.deepEqual(fixture.ran, [{ command: ["sh", "-c", "npm ls minimist"], timeoutMs: 300_000 }]);
    assert.equal(content, "exit code: 0\n--- stdout ---\nout");
  });

  it("honours a timeout up to the configured command limit and caps anything larger", async () => {
    fixture.env.commandTimeoutMs = 120_000;
    await call("run", { command: "a", timeout_seconds: 30 });
    await call("run", { command: "b", timeout_seconds: 9999 });
    await call("run", { command: "c" });
    assert.deepEqual(fixture.ran.map((entry) => entry.timeoutMs), [30_000, 120_000, 120_000]);
  });

  it("reports stderr, a timeout and truncation", async () => {
    fixture = setup({ exitCode: 124, stdout: "", stderr: "boom\n", timedOut: true, truncated: true });
    const { content } = await call("run", { command: "sleep 9", timeout_seconds: 1 });
    assert.match(content, /^exit code: 124 \(timed out after 1 s\)/);
    assert.match(content, /--- stderr ---\nboom/);
    assert.match(content, /output truncated/);
  });

  it("keeps the tail of very long output for the model", async () => {
    fixture = setup({ stdout: `${"a".repeat(50_000)}END` });
    const { content } = await call("run", { command: "x" });
    assert.ok(content.length < 25_000);
    assert.ok(content.endsWith("END"));
    assert.match(content, /earlier output dropped/);
  });

  it("requires a command", async () => {
    assert.match((await call("run", {})).content, /^error: command must be a non-empty string/);
  });
});

describe("finish", () => {
  const valid = { summary: "Bumped minimist.", changes: [{ package: "minimist", from: "1.2.5", to: "1.2.8", how: "direct-bump" }] };

  it("returns the validated arguments", async () => {
    const result = await call("finish", valid);
    assert.deepEqual(result.finish, valid);
  });

  it("rejects bad arguments with a message that says what to fix", () => {
    assert.match(parseFinish({ ...valid, summary: "  " }) as string, /summary must be a non-empty string/);
    assert.match(parseFinish({ summary: "s", changes: "none" }) as string, /changes must be a list/);
    assert.match(parseFinish({ summary: "s", changes: [{ ...valid.changes[0], how: "magic" }] }) as string, /changes\[0\]\.how must be one of direct-bump, parent-bump, override/);
    assert.match(parseFinish({ summary: "s", changes: [{ package: "p", from: "1" }] }) as string, /changes\[0\]\.to must be a non-empty string/);
  });

  it("does not finish on invalid arguments", async () => {
    const result = await call("finish", { summary: "" });
    assert.equal(result.finish, undefined);
    assert.match(result.content, /^error: invalid finish arguments: .*call finish again/);
  });
});

describe("unknown tools", () => {
  it("names the tools that exist", async () => {
    assert.match((await call("rm_rf", {})).content, /^error: unknown tool "rm_rf"; the tools are read_file, list_dir/);
  });
});
