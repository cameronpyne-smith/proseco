import { dirname, join } from "node:path/posix";
import { highestVersion } from "../../core/versions.ts";
import type { Ecosystem, LockfileChange, PreflightBox, ReviewSources } from "./ecosystem.ts";
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

const OLDER_NPM = [10, 9, 8, 7];
const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/;
const RESOLVE_FLAGS = "install --package-lock-only --no-audit --no-fund";
export const DIFF_SCRIPT = `const fs = require("fs");
const { isDeepStrictEqual } = require("util");
const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const was = before.packages || {};
const now = after.packages || {};
let removed = 0, added = 0, changed = 0;
for (const key of Object.keys(was)) {
  if (!(key in now)) removed++;
  else if (was[key].version !== now[key].version) changed++;
}
for (const key of Object.keys(now)) if (!(key in was)) added++;
console.log("PRESOLVE " + JSON.stringify({ removed, added, changed, exact: isDeepStrictEqual(before, after), sameVersion: before.lockfileVersion === after.lockfileVersion }));`;

interface Drift {
  removed: number;
  added: number;
  changed: number;
  exact: boolean;
  sameVersion: boolean;
}

function size(drift: Drift): number {
  return drift.removed + drift.added + drift.changed;
}

function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

async function reresolve(box: PreflightBox, directory: string, lockfile: string, command: string, timeoutMs: number): Promise<Drift | null> {
  const dir = shellWord(`/work/${directory}`);
  const name = shellWord(lockfile);
  const script = [
    `d=$(mktemp -d /tmp/preflight.XXXXXX) || exit 1`,
    `tar -C ${dir} --exclude=node_modules --exclude=.git -cf - . | tar -C "$d" -xf - || exit 1`,
    `cd "$d" && ${command} ${RESOLVE_FLAGS} >/dev/null 2>&1`,
    `status=$?`,
    `if [ "$status" -eq 0 ]; then node -e ${shellWord(DIFF_SCRIPT)} ${dir}/${name} "$d"/${name}; fi`,
    `rm -rf "$d"`,
    `exit $status`,
  ].join("\n");
  const result = await box.run(["sh", "-c", script], timeoutMs);
  if (result.exitCode !== 0 || result.timedOut) return null;
  const line = result.stdout.split("\n").find((text) => text.startsWith("PRESOLVE "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("PRESOLVE ".length)) as Drift;
  } catch {
    return null;
  }
}

function describeDrift(drift: Drift): string {
  return `${drift.removed} removed, ${drift.added} added, ${drift.changed} changed${drift.sameVersion ? "" : ", lockfileVersion rewritten"}`;
}

export const NPM_NOTES = [
  "Ecosystem notes (npm):",
  "- Resolve the lockfile with `npm install --package-lock-only --no-audit --no-fund`, run from the lockfile's directory. It rewrites package-lock.json from package.json without installing.",
  "- Install with `npm ci --no-audit --no-fund` and run the tests with `npm test`. Install scripts may run inside the sandbox container.",
  "- A direct dependency: change its range in package.json to the smallest version that is at or above the target, then resolve.",
  "- `npm install --package-lock-only` never moves a package whose locked version still satisfies its range. To move one within its range, run `npm update <package> --package-lock-only --no-audit --no-fund`.",
  "- A transitive dependency: first check whether a fixed version is already inside the range its parent declares (`npm ls <package>` shows the chain; `npm view <parent>@<locked version> dependencies` shows the ranges). If it is, `npm update <package> --package-lock-only` is the whole fix and package.json does not change. If not, bump the named parent (the direct dependency the chain starts with) to a release whose range allows a fixed version, then resolve. Only if no parent release does, add an `overrides` entry with a caret range at the fixed version (`\"^1.2.3\"`), never an exact version, then resolve.",
  "- When several direct dependencies must change together, for example because of peer dependencies, change them in one command: `npm install <name>@<range> <name>@<range> --package-lock-only --no-audit --no-fund`.",
  "- If the resolver stops with ERESOLVE and names a package already in the lockfile that still requires the previous major of what you are upgrading (often an old nested plugin or helper), upgrade that package too in the same command: `npm install <name>@<range> <other>@<range> --package-lock-only --no-audit --no-fund`. Use `--force` or `--legacy-peer-deps` only as a last resort; afterwards run `npm ls --all` and confirm it reports no `invalid` or `ERESOLVE` peer dependency problems.",
  "- Do not accept a resolver run that removes, adds or changes packages the task does not touch. Compare `git diff --stat` and the list of removed packages in package-lock.json after every resolve, and undo unrelated removals (restore the lockfile with `git checkout package-lock.json` and resolve again more narrowly) instead of committing them.",
  "- Never edit package-lock.json by hand. Only the resolver may write it. Never delete it to get past a resolver error: that re-resolves every package in the project.",
  "- `npm ls <package>` shows every installed copy and which package requires it.",
  "- Call `lockfile_status` to see which lockfile entries changed against the default branch and whether every target is met, with the path of every copy. Use it instead of parsing `git diff package-lock.json`: the `\"node_modules/x\": {` key lines are unchanged context there.",
].join("\n");

function overridesName(overrides: unknown, pkg: string): boolean {
  if (typeof overrides !== "object" || overrides === null) return false;
  return Object.entries(overrides).some(([key, value]) => {
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    return name === pkg || overridesName(value, pkg);
  });
}

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

  directVersions(text) {
    const packages = packagesOf(text);
    const direct = new Map<string, string>();
    for (const root of ["", ...workspaceMembers(text)]) {
      const entry = packages[root]!;
      const names = [entry.dependencies, entry.optionalDependencies, entry.peerDependencies, entry.devDependencies].flatMap((group) => Object.keys(group ?? {}));
      for (const name of names) {
        const path = resolve(packages, root, name);
        const version = path === null ? undefined : packages[path]!.version;
        if (version) direct.set(name, highestVersion([version, ...(direct.has(name) ? [direct.get(name)!] : [])])[0]!);
      }
    }
    return direct;
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

  async preflight(box, lockfile, timeoutMs) {
    const directory = dirname(lockfile);
    const name = lockfile.split("/").pop()!;
    const results: { command: string; drift: Drift | null }[] = [];
    for (const command of ["npm", ...OLDER_NPM.map((major) => `npx -y npm@${major}`)]) {
      const drift = await reresolve(box, directory, name, command, timeoutMs);
      results.push({ command, drift });
      if (drift?.exact) break;
    }
    const summary = results.map(({ command, drift }) => `${command}: ${drift ? (drift.exact ? "exact" : describeDrift(drift)) : "failed"}`).join("; ");
    const exact = results.find((result) => result.drift?.exact);
    if (exact) {
      if (exact.command === "npm") return { notes: [], summary };
      return {
        tool: exact.command,
        summary,
        notes: [
          `The npm in the sandbox rewrites this lockfile even when nothing is asked of it (${results[0]!.drift ? describeDrift(results[0]!.drift) : "it fails on the untouched lockfile"}), because the lockfile was written by an older npm. Measured on a scratch copy: \`${exact.command}\` leaves it exactly unchanged. Use \`${exact.command}\` in place of \`npm\` for every npm command: the resolver (\`${exact.command} ${RESOLVE_FLAGS}\`, \`${exact.command} update ...\`, \`${exact.command} ls\`), \`${exact.command} ci --no-audit --no-fund\` for installing, and \`${exact.command} test\`. Do not run bare \`npm install\`, \`npm update\` or \`npm ci\`: the bundled npm would delete or rewrite packages unrelated to the task, or refuse the lockfile. The host's own install and test runs use \`${exact.command}\` too.`,
        ],
      };
    }
    const usable = results.flatMap((result, index) => (result.drift && result.drift.sameVersion ? [{ ...result, drift: result.drift, index }] : []));
    if (usable.length === 0) return { notes: [], summary };
    const best = usable.reduce((winner, item) => (size(item.drift) < size(winner.drift) ? item : winner));
    const bundled = best.command === "npm";
    return {
      ...(bundled ? {} : { tool: best.command }),
      summary,
      notes: [
        `No npm available in the sandbox reproduces this lockfile exactly (the ones that rewrite lockfileVersion were not considered). ${bundled ? "The sandbox's npm is the closest" : `\`${best.command}\` is the closest`}: on the untouched lockfile it ${size(best.drift) === 0 ? "changes only the file's formatting or other top-level fields" : `changes ${size(best.drift)} packages unrelated to the task (${describeDrift(best.drift)})`}. Expect about that much unrelated change after every resolver run; keep it as small as you can and look at the lockfile diff for removed packages after each run.${bundled ? "" : ` Use \`${best.command}\` in place of \`npm\` for every npm command, \`ci\` and \`test\` included; the host's own install and test runs use it too.`}`,
      ],
    };
  },

  manifestFile: "package.json",

  overridesPackage(manifestText, pkg) {
    try {
      return overridesName((JSON.parse(manifestText) as { overrides?: unknown }).overrides, pkg);
    } catch {
      return false;
    }
  },

  changes(before, after) {
    const was = packagesOf(before);
    const now = packagesOf(after);
    const changes: LockfileChange[] = [];
    for (const path of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (path === "") continue;
      const from = was[path]?.version ?? (path in was ? "link" : null);
      const to = now[path]?.version ?? (path in now ? "link" : null);
      if (from !== to) changes.push({ path, name: nameOf(path), from, to });
    }
    return changes;
  },

  copiesOf(text, pkg) {
    return Object.entries(packagesOf(text)).flatMap(([path, entry]) => (path !== "" && !entry.link && entry.version && nameOf(path) === pkg ? [{ version: entry.version, where: path }] : []));
  },

  reviewSources(pkg, directory): ReviewSources | null {
    if (!SAFE_NAME.test(pkg)) return null;
    const root = directory === "." ? `node_modules/${pkg}` : `${directory}/node_modules/${pkg}`;
    const guard = `cd /work && [ -d ${root} ] || { echo PROSECO_MISSING; exit 0; }`;
    return {
      search: `${guard}; grep -rhoiEI "[^\\"']*(no longer|has been removed|removed in|was removed|not supported in|is deprecated)[^\\"']*" ${root} --exclude-dir=node_modules | sort -u | head -3000`,
      files: `${guard}; find ${root} -maxdepth 2 -path ${root}/node_modules -prune -o -type f \\( -iname 'readme*' -o -iname 'changelog*' -o -iname 'changes*' -o -iname '*migrat*' -o -iname 'history*' -o -iname 'upgrad*' \\) -print | head -30`,
    };
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

  harness(lockfile, tool = "npm") {
    const manifest = join(dirname(lockfile), "package.json");
    return {
      install: `${tool} ci --no-audit --no-fund`,
      test: `${tool} test --if-present`,
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
