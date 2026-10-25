import { dirname, join } from "node:path/posix";
import { highestVersion, packageKey } from "../../core/versions.ts";
import type { Ecosystem } from "./ecosystem.ts";
import { shortestChain } from "./graph.ts";
import { pytestFailures, pythonReview } from "./pytest.ts";
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

export const UV_NOTES = [
  "Ecosystem notes (uv):",
  "- Run every uv command from the lockfile's directory. The lockfile is uv.lock, the manifest is pyproject.toml.",
  "- Resolve one package at a time with `uv lock --upgrade-package <package>`. It rewrites uv.lock with the newest version the constraints in pyproject.toml allow.",
  "- A direct dependency whose constraint in pyproject.toml excludes the target (for example an exact pin below it): change the constraint to the smallest version at or above the target, then run `uv lock --upgrade-package <package>`.",
  "- A transitive dependency: first try `uv lock --upgrade-package <package>`. If the lockfile stays below the target, raise the named parent's constraint in pyproject.toml and run `uv lock --upgrade-package <parent>`. If no parent release helps, add `constraint-dependencies = [\"<package>>=<target>\"]` under `[tool.uv]` in pyproject.toml, then run `uv lock`.",
  "- Never edit uv.lock by hand. Only `uv lock` may write it.",
  "- Install with `uv sync --frozen --all-extras --all-groups`; the tests run with `uv run pytest -q -rfE` when pytest is locked. `uv tree --invert --package <package>` shows what requires a package.",
  "- Dependency groups such as `dev` live under `[dependency-groups]` in pyproject.toml; a workspace member has its own pyproject.toml.",
].join("\n");

function workspaceMembers(text: string): string[] {
  const parsed = parseToml(text);
  const members = table(parsed["manifest"])["members"];
  if (!Array.isArray(members)) return [];
  const names = new Set(members.filter((member): member is string => typeof member === "string").map((member) => packageKey("pip", member)));
  const paths: string[] = [];
  for (const raw of Array.isArray(parsed["package"]) ? parsed["package"] : []) {
    const entry = table(raw);
    if (typeof entry["name"] !== "string" || !names.has(packageKey("pip", entry["name"]))) continue;
    const source = table(entry["source"]);
    const path = source["editable"] ?? source["virtual"];
    if (typeof path === "string" && path !== ".") paths.push(path);
  }
  return paths;
}

export const uv: Ecosystem = {
  name: "uv",
  findingEcosystem: "pip",
  toolchainFiles: [".python-version", "pyproject.toml"],
  imageFamily: "python",
  notes: UV_NOTES,

  installedVersions(text) {
    const installed = new Map<string, string[]>();
    for (const locked of packagesOf(text)) {
      if (locked.root) continue;
      installed.set(locked.name, [...new Set([...(installed.get(locked.name) ?? []), locked.version])].sort());
    }
    return installed;
  },

  directVersions(text) {
    const packages = packagesOf(text);
    const direct = new Map<string, string>();
    for (const root of packages.filter((locked) => locked.root)) {
      for (const dependency of root.dependencies) {
        const versions = packages.filter((locked) => !locked.root && locked.name === dependency.name && (dependency.version === null || locked.version === dependency.version)).map((locked) => locked.version);
        if (versions.length > 0) direct.set(dependency.name, highestVersion([...versions, ...(direct.has(dependency.name) ? [direct.get(dependency.name)!] : [])])[0]!);
      }
    }
    return direct;
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

  reviewCommands: (pkg, directory) => pythonReview(pkg, directory, "uv run python"),

  allowedFiles(lockfile, text) {
    const directory = dirname(lockfile);
    const inDirectory = (file: string) => (directory === "." ? file : join(directory, file));
    return [inDirectory("pyproject.toml"), inDirectory("uv.lock"), ...workspaceMembers(text).map((member) => inDirectory(join(member, "pyproject.toml")))];
  },

  harness(lockfile) {
    return {
      install: "uv sync --frozen --all-extras --all-groups",
      test: "uv run pytest -q -rfE",
      failures: pytestFailures,
      hasTests(read) {
        try {
          return uv.installedVersions(read(lockfile) ?? "").has("pytest");
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
