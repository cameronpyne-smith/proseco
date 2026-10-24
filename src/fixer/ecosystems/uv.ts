import { packageKey } from "../../core/versions.ts";
import type { Ecosystem } from "./ecosystem.ts";
import { shortestChain } from "./graph.ts";
import { parseToml, type TomlValue } from "./toml.ts";

interface Locked {
  id: string;
  name: string;
  version: string;
  root: boolean;
  dependencies: { name: string; version: string | null }[];
}

type Table = { [key: string]: TomlValue };

function table(value: TomlValue | undefined): Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function references(value: TomlValue | undefined): { name: string; version: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = table(item);
    return typeof entry["name"] === "string"
      ? [{ name: packageKey("pip", entry["name"]), version: typeof entry["version"] === "string" ? entry["version"] : null }]
      : [];
  });
}

function groups(value: TomlValue | undefined): { name: string; version: string | null }[] {
  return Object.values(table(value)).flatMap(references);
}

function packagesOf(text: string): Locked[] {
  const parsed = parseToml(text)["package"];
  if (!Array.isArray(parsed)) throw new Error("uv.lock has no [[package]] tables");
  return parsed.map((raw, index) => {
    const entry = table(raw);
    if (typeof entry["name"] !== "string" || typeof entry["version"] !== "string") {
      if (table(entry["source"])["virtual"] !== undefined || table(entry["source"])["editable"] !== undefined) {
        return { id: `#${index}`, name: String(entry["name"]), version: "", root: true, dependencies: [] };
      }
      throw new Error(`uv.lock package ${index + 1} has no name and version`);
    }
    const source = table(entry["source"]);
    return {
      id: `#${index}`,
      name: packageKey("pip", entry["name"]),
      version: entry["version"],
      root: source["virtual"] !== undefined || source["editable"] !== undefined,
      dependencies: [
        ...references(entry["dependencies"]),
        ...groups(entry["optional-dependencies"]),
        ...groups(entry["dev-dependencies"]),
      ],
    };
  });
}

export function pythonToolchain(files: Record<string, string>): string | null {
  const pinned = files[".python-version"]?.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (pinned) return pinned;
  return /^\s*requires-python\s*=\s*"([^"]+)"/m.exec(files["pyproject.toml"] ?? "")?.[1] ?? null;
}

export const uv: Ecosystem = {
  name: "uv",
  findingEcosystem: "pip",
  toolchainFiles: [".python-version", "pyproject.toml"],

  installedVersions(text) {
    const installed = new Map<string, string[]>();
    for (const locked of packagesOf(text)) {
      if (locked.root) continue;
      installed.set(locked.name, [...new Set([...(installed.get(locked.name) ?? []), locked.version])].sort());
    }
    return installed;
  },

  parentChain(text, pkg, version) {
    const packages = packagesOf(text);
    const byId = new Map(packages.map((locked) => [locked.id, locked]));
    const edges = (id: string) =>
      byId.get(id)!.dependencies.flatMap((dependency) =>
        packages
          .filter((locked) => !locked.root && locked.name === dependency.name && (dependency.version === null || locked.version === dependency.version))
          .map((locked) => locked.id),
      );
    const roots = [...new Set(packages.filter((locked) => locked.root).flatMap((locked) => edges(locked.id)))];
    const name = packageKey("pip", pkg);
    return shortestChain(
      roots,
      edges,
      (id) => byId.get(id)!.name === name && byId.get(id)!.version === version,
      (id) => byId.get(id)!.name,
    );
  },

  toolchainVersion: pythonToolchain,
};
