import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pruneTranscripts } from "../src/fixer/transcripts.ts";

const DAY = 24 * 60 * 60;
const NOW = 2_000_000_000_000;

function setup(files: { name: string; bytes: number; ageDays: number }[]): string {
  const clone = mkdtempSync(join(tmpdir(), "proseco-transcripts-"));
  const directory = join(clone, "transcripts");
  mkdirSync(directory);
  for (const file of files) {
    const path = join(directory, file.name);
    writeFileSync(path, Buffer.alloc(file.bytes, 120));
    const when = NOW / 1000 - file.ageDays * DAY;
    utimesSync(path, when, when);
  }
  return clone;
}

const exists = (clone: string, name: string) => existsSync(join(clone, "transcripts", name));

describe("pruneTranscripts", () => {
  it("removes transcripts older than the limit and keeps the rest", () => {
    const clone = setup([{ name: "old.jsonl", bytes: 10, ageDays: 20 }, { name: "new.jsonl", bytes: 10, ageDays: 2 }]);
    const result = pruneTranscripts(clone, { maxAgeDays: 14, maxMegabytes: 100 }, NOW);
    assert.deepEqual(result, { removed: 1, freedBytes: 10 });
    assert.deepEqual([exists(clone, "old.jsonl"), exists(clone, "new.jsonl")], [false, true]);
  });

  it("drops the oldest first once the total passes the size limit", () => {
    const mb = 1024 * 1024;
    const clone = setup([{ name: "a.jsonl", bytes: mb, ageDays: 3 }, { name: "b.jsonl", bytes: mb, ageDays: 2 }, { name: "c.jsonl", bytes: mb, ageDays: 1 }]);
    const result = pruneTranscripts(clone, { maxAgeDays: 14, maxMegabytes: 2 }, NOW);
    assert.equal(result.removed, 1);
    assert.deepEqual([exists(clone, "a.jsonl"), exists(clone, "b.jsonl"), exists(clone, "c.jsonl")], [false, true, true]);
  });

  it("leaves other files alone and copes with a missing directory", () => {
    const clone = setup([{ name: "notes.txt", bytes: 5, ageDays: 400 }]);
    assert.deepEqual(pruneTranscripts(clone, { maxAgeDays: 1, maxMegabytes: 1 }, NOW), { removed: 0, freedBytes: 0 });
    assert.equal(exists(clone, "notes.txt"), true);
    assert.deepEqual(pruneTranscripts(join(clone, "missing"), { maxAgeDays: 1, maxMegabytes: 1 }, NOW), { removed: 0, freedBytes: 0 });
  });
});
