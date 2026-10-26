import { dirname, join } from "node:path/posix";
import { highestVersion } from "../../core/versions.ts";
import type { Ecosystem, PreflightBox, ReviewSources } from "./ecosystem.ts";
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
const DIFF_SCRIPT = `const fs = require("fs");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8")).packages || {};
const before = read(process.argv[1]);
const after = read(process.argv[2]);
let removed = 0, added = 0, changed = 0;
for (const key of Object.keys(before)) {
  if (!(key in after)) removed++;
  else if (before[key].version !== after[key].version) changed++;
}
for (const key of Object.keys(after)) if (!(key in before)) added++;
console.log("PRESOLVE " + JSON.stringify({ removed, added, changed }));`;

interface Drift {
  removed: number;
  added: number;
  changed: number;
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
  return `${drift.removed} removed, ${drift.added} added, ${drift.changed} changed`;
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
    const bundled = await reresolve(box, directory, name, "npm", timeoutMs);
    if (bundled && bundled.removed + bundled.added + bundled.changed === 0) return { notes: [] };
    for (const major of OLDER_NPM) {
      const command = `npx -y npm@${major}`;
      const drift = await reresolve(box, directory, name, command, timeoutMs);
      if (drift && drift.removed + drift.added + drift.changed === 0) {
        return {
          tool: command,
          notes: [
            `The npm in the sandbox rewrites this lockfile even when nothing is asked of it (${bundled ? describeDrift(bundled) : "it fails on the untouched lockfile"}), because the lockfile was written by an older npm. Measured on a scratch copy: \`${command}\` leaves it unchanged. Use \`${command}\` in place of \`npm\` for every npm command: the resolver (\`${command} ${RESOLVE_FLAGS}\`, \`${command} update ...\`, \`${command} ls\`), \`${command} ci --no-audit --no-fund\` for installing, and \`${command} test\`. Do not run bare \`npm install\`, \`npm update\` or \`npm ci\`: the bundled npm would delete or rewrite packages unrelated to the task, or refuse the lockfile. The host's own install and test runs use \`${command}\` too.`,
          ],
        };
      }
    }
    if (!bundled) return { notes: [] };
    return {
      notes: [
        `Re-resolving the untouched lockfile with the sandbox's npm and with npm 10, 9, 8 and 7 changes packages unrelated to the task (with the bundled npm: ${describeDrift(bundled)}). No npm version reproduces it. Expect unrelated changes after every resolver run; keep them as small as you can and look at the lockfile diff for removed packages after each run.`,
      ],
    };
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
