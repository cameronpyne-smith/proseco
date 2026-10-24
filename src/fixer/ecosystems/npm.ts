import { dirname, join } from "node:path/posix";
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

export const NPM_NOTES = [
  "Ecosystem notes (npm):",
  "- Resolve the lockfile with `npm install --package-lock-only --no-audit --no-fund`, run from the lockfile's directory. It rewrites package-lock.json from package.json without installing.",
  "- Install with `npm ci --no-audit --no-fund` and run the tests with `npm test`. Install scripts may run inside the sandbox container.",
  "- A direct dependency: change its range in package.json to the smallest version that is at or above the target, then resolve.",
  "- A transitive dependency: prefer bumping the named parent (the direct dependency the chain starts with) to a release that pulls in a fixed version, then resolve. If no parent release does, add an `overrides` entry to package.json for the vulnerable package, then resolve.",
  "- Never edit package-lock.json by hand. Only the resolver may write it.",
  "- `npm ls <package>` shows every installed copy and which package requires it.",
].join("\n");

export const npm: Ecosystem = {
  name: "npm",
  findingEcosystem: "npm",
  toolchainFiles: [".nvmrc", "package.json"],
  imageFamily: "node",
  notes: NPM_NOTES,

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

  allowedFiles(lockfile, text) {
    const directory = dirname(lockfile);
    const inDirectory = (file: string) => (directory === "." ? file : join(directory, file));
    return [
      ...["package.json", "package-lock.json", "npm-shrinkwrap.json"].map(inDirectory),
      ...workspaceMembers(text).map((member) => inDirectory(join(member, "package.json"))),
    ];
  },

  harness(lockfile) {
    const manifest = join(dirname(lockfile), "package.json");
    return {
      install: "npm ci --no-audit --no-fund",
      test: "npm test --if-present",
      hasTests(read) {
        try {
          const scripts = (JSON.parse(read(manifest) ?? "") as { scripts?: { test?: unknown } }).scripts;
          return typeof scripts?.test === "string";
        } catch {
          return false;
        }
      },
    };
  },

  unsupported() {
    return null;
  },
};
