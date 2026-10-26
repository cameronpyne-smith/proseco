import { npm } from "./npm.ts";
import { requirements, REQUIREMENTS_FILE } from "./requirements.ts";
import { uv } from "./uv.ts";

export type EcosystemName = "npm" | "uv" | "requirements";

export type ImageFamily = "node" | "python";

export interface Harness {
  install: string;
  test: string;
  hasTests(read: (path: string) => string | null): boolean;
  failures?(output: string): string[] | null;
}

export interface PreflightBox {
  run(command: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

export interface Preflight {
  notes: string[];
  tool?: string;
  summary?: string;
}

export interface ReviewSources {
  search: string;
  files: string;
}

export interface Ecosystem {
  name: EcosystemName;
  findingEcosystem: string;
  toolchainFiles: string[];
  imageFamily: ImageFamily;
  notes: string;
  installedVersions(lockfileText: string): Map<string, string[]>;
  directVersions(lockfileText: string): Map<string, string>;
  parentChain(lockfileText: string, pkg: string, version: string): string[] | null;
  toolchainVersion(files: Record<string, string>): string | null;
  allowedFiles(lockfile: string, lockfileText: string): string[];
  harness(lockfile: string, tool?: string): Harness;
  unsupported(lockfileText: string): string | null;
  preflight?(box: PreflightBox, lockfile: string, timeoutMs: number): Promise<Preflight>;
  copiesOf?(lockfileText: string, pkg: string): { version: string; where: string }[];
  reviewSources?(pkg: string, directory: string): ReviewSources | null;
}

export function ecosystemFor(lockfilePath: string): Ecosystem | null {
  const file = lockfilePath.split("/").pop()!;
  if (file === "package-lock.json") return npm;
  if (file === "uv.lock") return uv;
  if (REQUIREMENTS_FILE.test(file)) return requirements;
  return null;
}
