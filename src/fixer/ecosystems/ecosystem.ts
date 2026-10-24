import { npm } from "./npm.ts";
import { requirements } from "./requirements.ts";
import { uv } from "./uv.ts";

export type EcosystemName = "npm" | "uv" | "requirements";

export interface Ecosystem {
  name: EcosystemName;
  findingEcosystem: string;
  toolchainFiles: string[];
  installedVersions(lockfileText: string): Map<string, string[]>;
  parentChain(lockfileText: string, pkg: string, version: string): string[] | null;
  toolchainVersion(files: Record<string, string>): string | null;
}

export function ecosystemFor(lockfilePath: string): Ecosystem | null {
  const file = lockfilePath.split("/").pop()!;
  if (file === "package-lock.json") return npm;
  if (file === "uv.lock") return uv;
  if (/^requirements.*\.txt$/.test(file)) return requirements;
  return null;
}
