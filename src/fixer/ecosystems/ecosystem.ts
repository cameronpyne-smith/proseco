import { npm } from "./npm.ts";
import { requirements } from "./requirements.ts";
import { uv } from "./uv.ts";

export type EcosystemName = "npm" | "uv" | "requirements";

export type ImageFamily = "node" | "python";

export interface Harness {
  install: string;
  test: string;
  hasTests(read: (path: string) => string | null): boolean;
}

export interface Ecosystem {
  name: EcosystemName;
  findingEcosystem: string;
  toolchainFiles: string[];
  imageFamily: ImageFamily;
  notes: string;
  installedVersions(lockfileText: string): Map<string, string[]>;
  parentChain(lockfileText: string, pkg: string, version: string): string[] | null;
  toolchainVersion(files: Record<string, string>): string | null;
  allowedFiles(lockfile: string, lockfileText: string): string[];
  harness(lockfile: string): Harness;
  unsupported(lockfileText: string): string | null;
}

export function ecosystemFor(lockfilePath: string): Ecosystem | null {
  const file = lockfilePath.split("/").pop()!;
  if (file === "package-lock.json") return npm;
  if (file === "uv.lock") return uv;
  if (/^requirements.*\.txt$/.test(file)) return requirements;
  return null;
}
