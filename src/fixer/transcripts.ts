import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptLimits } from "../core/config.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MEGABYTE = 1024 * 1024;

export interface PruneResult {
  removed: number;
  freedBytes: number;
}

export function pruneTranscripts(cloneDir: string, limits: TranscriptLimits, now = Date.now()): PruneResult {
  const directory = join(cloneDir, "transcripts");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { removed: 0, freedBytes: 0 };
  }
  const files = names.flatMap((name) => {
    try {
      const stats = statSync(join(directory, name));
      return stats.isFile() ? [{ path: join(directory, name), size: stats.size, modified: stats.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  files.sort((a, b) => b.modified - a.modified);
  let kept = 0;
  let removed = 0;
  let freedBytes = 0;
  for (const file of files) {
    const tooOld = now - file.modified > limits.maxAgeDays * DAY_MS;
    const tooBig = kept + file.size > limits.maxMegabytes * MEGABYTE;
    if (tooOld || tooBig) {
      try {
        rmSync(file.path, { force: true });
        removed++;
        freedBytes += file.size;
      } catch {
        kept += file.size;
      }
    } else {
      kept += file.size;
    }
  }
  return { removed, freedBytes };
}
