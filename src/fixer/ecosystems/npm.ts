import type { Ecosystem } from "./ecosystem.ts";
import { shortestChain } from "./graph.ts";

interface Entry {
  version?: string;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const MARKER = "node_modules/";

function packagesOf(text: string): Record<string, Entry> {
  const packages = (JSON.parse(text) as { packages?: Record<string, Entry> }).packages;
  if (!packages) throw new Error("package-lock.json has no packages map: only lockfileVersion 2 and 3 are supported");
  return packages;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf(MARKER) + MARKER.length);
}

function resolve(packages: Record<string, Entry>, from: string, dependency: string): string | null {
  let base = from;
  for (;;) {
    const candidate = base === "" ? `${MARKER}${dependency}` : `${base}/${MARKER}${dependency}`;
    if (candidate in packages) {
      const entry = packages[candidate]!;
      return entry.link && entry.resolved && entry.resolved in packages ? entry.resolved : candidate;
    }
    if (base === "") return null;
    const cut = base.lastIndexOf(MARKER);
    base = cut <= 0 ? "" : base.slice(0, cut - 1);
  }
}

function dependencyNames(path: string, entry: Entry): string[] {
  const groups = [entry.dependencies, entry.optionalDependencies, entry.peerDependencies, path === "" ? entry.devDependencies : undefined];
  return groups.flatMap((group) => Object.keys(group ?? {}));
}

export function workspaceMembers(text: string): string[] {
  return Object.keys(packagesOf(text)).filter((path) => path !== "" && !path.includes(MARKER) && !path.startsWith("node_modules"));
}

export const npm: Ecosystem = {
  name: "npm",
  findingEcosystem: "npm",
  toolchainFiles: [".nvmrc", "package.json"],

  installedVersions(text) {
    const installed = new Map<string, string[]>();
    for (const [path, entry] of Object.entries(packagesOf(text))) {
      if (path === "" || entry.link || !entry.version) continue;
      const name = nameOf(path);
      installed.set(name, [...new Set([...(installed.get(name) ?? []), entry.version])].sort());
    }
    return installed;
  },

  parentChain(text, pkg, version) {
    const packages = packagesOf(text);
    const edges = (path: string) =>
      dependencyNames(path, packages[path]!).flatMap((dependency) => {
        const target = resolve(packages, path, dependency);
        return target ? [target] : [];
      });
    const roots = edges("");
    return shortestChain(
      roots,
      edges,
      (path) => nameOf(path) === pkg && packages[path]!.version === version,
      nameOf,
    );
  },

  toolchainVersion(files) {
    const nvmrc = files[".nvmrc"]?.split("\n").map((line) => line.trim()).find(Boolean);
    if (nvmrc) return nvmrc;
    const manifest = files["package.json"];
    if (!manifest) return null;
    const engines = (JSON.parse(manifest) as { engines?: { node?: string } }).engines;
    return engines?.node ?? null;
  },
};
