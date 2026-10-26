import { basename } from "node:path/posix";
import { shellWord } from "../shell.ts";
import { packageKey } from "../../core/versions.ts";
import type { Ecosystem } from "./ecosystem.ts";
import { pytestFailures, pythonSources } from "./pytest.ts";
import { pythonToolchain } from "./uv.ts";

export const REQUIREMENTS_NOTES = [
  "Ecosystem notes (requirements.txt):",
  "- The lockfile is a pinned requirements file. The fix is a text edit: change the `==` pin of each vulnerable package to the smallest released version at or above the target. There is no resolver to run.",
  "- A transitive package is pinned in the same file as its own line; edit that line. Keep the other pins as they are unless pip reports a conflict.",
  "- Check the result from the file's directory with `python -m pip install -r <file>` and `python -m pip check`. The sandbox installs into the user site, so no virtual environment is needed. Run the tests with `python -m pytest -q -rfE` when pytest is pinned in the file.",
  "- Call `lockfile_status` to see which pins changed against the default branch and whether every target is met.",
  "- This file may belong to a script or a tool rather than the application. Change nothing but the pins in this one file: no other requirements file, no pyproject.toml, no setup files, no constraints or lock files.",
].join("\n");

export const REQUIREMENTS_FILE = /^(?:.*[-_.])?requirements(?:[-_.].*)?\.txt$/i;

export function isRequirementsPath(path: string): boolean {
  const parts = path.split("/");
  const file = parts.pop()!;
  return REQUIREMENTS_FILE.test(file) || (/\.txt$/i.test(file) && parts.some((part) => part.toLowerCase() === "requirements"));
}

const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;\\]+)/;

function pins(text: string): Map<string, string[]> {
  const installed = new Map<string, string[]>();
  const joined = text.replaceAll("\r\n", "\n").replace(/\\\n/g, " ");
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const match = PIN.exec(line);
    if (!match) continue;
    const name = packageKey("pip", match[1]!);
    installed.set(name, [...new Set([...(installed.get(name) ?? []), match[2]!])].sort());
  }
  return installed;
}

export const requirements: Ecosystem = {
  name: "requirements",
  findingEcosystem: "pip",
  toolchainFiles: [".python-version", "pyproject.toml"],
  imageFamily: "python",
  absentIsFixed: false,
  notes: REQUIREMENTS_NOTES,
  installedVersions: pins,
  directVersions: () => new Map(),
  parentChain(text, pkg, version) {
    const name = packageKey("pip", pkg);
    return pins(text).get(name)?.includes(version) ? [name] : null;
  },
  toolchainVersion: pythonToolchain,
  reviewSources: (pkg, directory) => pythonSources(pkg, directory, "python"),

  allowedFiles(lockfile) {
    return [lockfile];
  },
  harness(lockfile) {
    return {
      install: `python -m pip install -r ${shellWord(basename(lockfile))}`,
      test: "python -m pytest -q -rfE",
      failures: pytestFailures,
      hasTests(read) {
        return pins(read(lockfile) ?? "").has("pytest");
      },
    };
  },
  unsupported(text) {
    return /(^|\s)--hash[=\s]/m.test(text) ? "hash-pinned requirements files are not supported yet: the hashes would need regenerating with pip-compile" : null;
  },
};
