import { packageKey } from "../../core/versions.ts";
import type { Ecosystem } from "./ecosystem.ts";
import { pythonToolchain } from "./uv.ts";

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
  installedVersions: pins,
  parentChain(text, pkg, version) {
    const name = packageKey("pip", pkg);
    return pins(text).get(name)?.includes(version) ? [name] : null;
  },
  toolchainVersion: pythonToolchain,
};
