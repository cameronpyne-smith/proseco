import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path/posix";
import { highestVersion, packageKey } from "../../core/versions.ts";
import type { Ecosystem, ManifestPair, PreflightBox, ResolverReference, Verification } from "./ecosystem.ts";
import { shellQuote } from "../shell.ts";
import { failureExcerpt } from "../excerpt.ts";
import { shortestChain } from "./graph.ts";
import { pytestFailures, pythonSources } from "./pytest.ts";
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
  "- Call `lockfile_status` to see which locked packages changed against the default branch and whether every target is met, instead of parsing `git diff uv.lock`.",
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

const ALLOWED_PATHS = [
  ["project", "dependencies"],
  ["project", "optional-dependencies"],
  ["dependency-groups"],
  ["tool", "uv", "constraint-dependencies"],
  ["tool", "uv", "override-dependencies"],
  ["tool", "uv", "dev-dependencies"],
];
const RISKY_PATHS = [["project", "scripts"], ["project", "gui-scripts"], ["project", "entry-points"], ["build-system"]];

function without(document: Table, paths: string[][]): Table {
  const copy = structuredClone(document) as Table;
  for (const path of paths) {
    let at: Table = copy;
    for (const key of path.slice(0, -1)) {
      const next = at[key];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        at = {};
        break;
      }
      at = next;
    }
    delete at[path.at(-1)!];
  }
  return copy;
}

function valueAt(document: Table, path: string[]): TomlValue | undefined {
  let at: TomlValue | undefined = document;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = at[key];
  }
  return at;
}

function differences(a: TomlValue | undefined, b: TomlValue | undefined, prefix: string[], depth: number): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const left = typeof a === "object" && a !== null && !Array.isArray(a) ? a : null;
  const right = typeof b === "object" && b !== null && !Array.isArray(b) ? b : null;
  if (!left || !right || depth >= 3) return [prefix.join(".") || "(file)"];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => differences(left[key], right[key], [...prefix, key], depth + 1));
}

function tomlOf(text: string): Table | null {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}

interface Sourced {
  name: string;
  version: string;
  source: TomlValue | undefined;
}

function sourcedOf(text: string): Sourced[] {
  const parsed = parseToml(text)["package"];
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw) => {
    const entry = table(raw);
    return typeof entry["name"] === "string" ? [{ name: packageKey("pip", entry["name"]), version: typeof entry["version"] === "string" ? entry["version"] : "", source: entry["source"] }] : [];
  });
}

export function uvLockfileProblems(before: string, after: string): string[] {
  const was = sourcedOf(before);
  const registries = new Set(was.flatMap((item) => (typeof table(item.source)["registry"] === "string" ? [table(item.source)["registry"] as string] : [])));
  const problems: string[] = [];
  for (const item of sourcedOf(after)) {
    const known = was.filter((other) => other.name === item.name);
    if (known.some((other) => other.version === item.version && isDeepStrictEqual(other.source, item.source))) continue;
    const source = table(item.source);
    if (source["virtual"] !== undefined || source["editable"] !== undefined) {
      if (!known.some((other) => isDeepStrictEqual(other.source, item.source))) problems.push(`${item.name} is a local package that the default branch's lockfile does not have`);
      continue;
    }
    const registry = source["registry"];
    if (typeof registry !== "string") problems.push(`${item.name} ${item.version} does not come from a registry (${Object.keys(source).join(", ") || "no source"})`);
    else if (!registries.has(registry)) problems.push(`${item.name} ${item.version} comes from ${registry}, which no package of the default branch's lockfile uses`);
    else if (known.length > 0 && !known.some((other) => table(other.source)["registry"] === registry)) problems.push(`${item.name} ${item.version} comes from ${registry}, not the registry it came from before`);
  }
  return problems;
}

async function lockCheck(box: PreflightBox, lockfile: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const directory = dirname(lockfile);
  const prefix = directory === "." ? "" : `cd ${shellQuote(`/work/${directory}`)} && `;
  const result = await box.run(["sh", "-c", `${prefix}uv lock --check`], timeoutMs);
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`, timedOut: result.timedOut };
}

export const uv: Ecosystem = {
  name: "uv",
  findingEcosystem: "pip",
  toolchainFiles: [".python-version", "pyproject.toml"],
  imageFamily: "python",
  absentIsFixed: true,
  notes: UV_NOTES,

  installedVersions(text) {
    const installed = new Map<string, string[]>();
    for (const locked of packagesOf(text)) {
      if (locked.root) continue;
      installed.set(locked.name, [...new Set([...(installed.get(locked.name) ?? []), locked.version])].sort());
    }
    return installed;
  },

  manifestFile: "pyproject.toml",

  async preflight(box, lockfile, timeoutMs) {
    const check = await lockCheck(box, lockfile, timeoutMs);
    const reference: ResolverReference | undefined = check.timedOut ? undefined : { exact: check.exitCode === 0, removed: 0, added: 0, changed: 0, swapped: 0 };
    return { notes: [], summary: `uv lock --check on the default branch: ${check.timedOut ? "timed out" : check.exitCode === 0 ? "exact" : `exit ${check.exitCode}`}`, ...(reference ? { reference } : {}) };
  },

  async verify(box, lockfile, timeoutMs, reference): Promise<Verification> {
    const check = await lockCheck(box, lockfile, timeoutMs);
    if (check.timedOut) return { outcome: "unknown", text: "`uv lock --check` timed out, so the committed lockfile could not be checked against pyproject.toml" };
    if (check.exitCode === 0) return { outcome: "ok", text: "`uv lock --check` finds the committed uv.lock up to date with pyproject.toml" };
    const reason = failureExcerpt(check.output, 400);
    if (reference?.exact) return { outcome: "tampered", text: `\`uv lock --check\` fails on the committed uv.lock although it passes on the default branch: ${reason}` };
    return { outcome: "drift", text: `\`uv lock --check\` fails on the committed uv.lock (it already failed on the default branch, or could not be run there): ${reason}` };
  },

  lockfileProblems(before, after, _manifests: ManifestPair[]) {
    return uvLockfileProblems(before, after);
  },

  manifestViolations(before, after) {
    const was = tomlOf(before);
    const now = tomlOf(after);
    if (!now) return ["the file is not valid TOML"];
    if (!was) return [];
    return differences(without(was, ALLOWED_PATHS), without(now, ALLOWED_PATHS), [], 0);
  },

  riskyManifestChanges(before, after) {
    const was = tomlOf(before);
    const now = tomlOf(after);
    if (!was || !now) return [];
    return RISKY_PATHS.filter((path) => !isDeepStrictEqual(valueAt(was, path), valueAt(now, path))).map((path) => path.join("."));
  },

  overridesPackage(manifestText, pkg) {
    try {
      const tool = table(table(parseToml(manifestText)["tool"])["uv"]);
      const wanted = packageKey("pip", pkg);
      return ["constraint-dependencies", "override-dependencies"].some((key) => {
        const list = tool[key];
        return Array.isArray(list) && list.some((item) => typeof item === "string" && packageKey("pip", /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(item)?.[1] ?? "") === wanted);
      });
    } catch {
      return false;
    }
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

  reviewSources: (pkg, directory) => pythonSources(pkg, directory, "uv run python"),

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
