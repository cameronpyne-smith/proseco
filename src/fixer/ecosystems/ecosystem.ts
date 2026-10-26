import { npm } from "./npm.ts";
import { isRequirementsPath, requirements } from "./requirements.ts";
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

export interface LockfileChange {
  path: string;
  name: string;
  from: string | null;
  to: string | null;
}

export interface ResolverReference {
  tool?: string;
  exact: boolean;
  removed: number;
  added: number;
  changed: number;
  swapped: number;
}

export interface Verification {
  outcome: "ok" | "tampered" | "drift" | "unknown";
  text: string;
}

export interface ManifestPair {
  path: string;
  before: string | null;
  after: string | null;
}

export interface Preflight {
  notes: string[];
  tool?: string;
  summary?: string;
  reference?: ResolverReference;
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
  absentIsFixed: boolean;
  notes: string;
  installedVersions(lockfileText: string): Map<string, string[]>;
  directVersions(lockfileText: string): Map<string, string>;
  parentChain(lockfileText: string, pkg: string, version: string): string[] | null;
  toolchainVersion(files: Record<string, string>): string | null;
  allowedFiles(lockfile: string, lockfileText: string): string[];
  harness(lockfile: string, tool?: string): Harness;
  unsupported(lockfileText: string): string | null;
  preflight?(box: PreflightBox, lockfile: string, timeoutMs: number, now?: () => number): Promise<Preflight>;
  manifestFile?: string;
  verify?(box: PreflightBox, lockfile: string, timeoutMs: number, reference: ResolverReference | undefined): Promise<Verification>;
  lockfileProblems?(before: string, after: string, manifests: ManifestPair[]): string[];
  manifestViolations?(before: string, after: string): string[];
  riskyManifestChanges?(before: string, after: string): string[];
  overridesPackage?(manifestText: string, pkg: string): boolean;
  changes?(before: string, after: string): LockfileChange[];
  copiesOf?(lockfileText: string, pkg: string): { version: string; where: string }[];
  reviewSources?(pkg: string, directory: string): ReviewSources | null;
}

export function ecosystemFor(lockfilePath: string): Ecosystem | null {
  const file = lockfilePath.split("/").pop()!;
  if (file === "package-lock.json") return npm;
  if (file === "uv.lock") return uv;
  if (isRequirementsPath(lockfilePath)) return requirements;
  return null;
}
