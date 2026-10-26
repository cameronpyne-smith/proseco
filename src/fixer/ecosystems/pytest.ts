import { shellWord } from "../shell.ts";
import type { ReviewSources } from "./ecosystem.ts";

const ANSI = /\u001b\[[0-9;]*m/g;

function sorted(ids: Set<string>): string[] | null {
  return ids.size === 0 ? null : [...ids].sort();
}

export function npmFailures(output: string): string[] | null {
  const ids = new Set<string>();
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const match = /^\s*(?:FAIL|✕|×|✗|✖)\s+(.+?)\s*$/.exec(line) ?? /^\s*not ok \d+ - (.+?)\s*$/.exec(line) ?? /^\s*\d+\) (.+?)\s*$/.exec(line);
    if (!match) continue;
    const id = match[1]!.replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, "").replace(/\s+\d+(?:\.\d+)?\s*m?s$/, "").trim();
    if (id !== "") ids.add(id);
  }
  return sorted(ids);
}

export function pytestFailures(output: string): string[] | null {
  const ids = new Set<string>();
  for (const line of output.replace(ANSI, "").split("\n")) {
    const match = /^(?:FAILED|ERROR) (.+)$/.exec(line);
    if (match) ids.add(match[1]!.replace(/ - .*$/, "").trim());
  }
  return sorted(ids);
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOPS = "print(' '.join(sorted({f.parts[0] for f in (d.files or []) if f.parts[0] != '..' and not f.parts[0].endswith(('.dist-info', '__pycache__', '.data', '.pth'))})))";

export function pythonSources(pkg: string, directory: string, python: string): ReviewSources | null {
  if (!SAFE_NAME.test(pkg)) return null;
  const query = (print: string) => `${python} -c "import importlib.metadata as m, sys; d = m.distribution(sys.argv[1]); ${print}" ${pkg}`;
  const head = `cd ${shellWord(directory === "." ? "/work" : `/work/${directory}`)} && base=$(${query("print(d.locate_file(''))")}) && tops=$(${query(TOPS)})`;
  return {
    search: `${head} && for t in $tops; do grep -rhoiEI "[^\\"']*(no longer|has been removed|removed in|was removed|not supported in|is deprecated)[^\\"']*" "$base/$t" --include='*.py' --include='*.md' --include='*.rst'; done | sort -u | head -3000`,
    files: `${head} && for t in $tops; do find "$base/$t" -maxdepth 2 -type f \\( -iname 'readme*' -o -iname 'changelog*' -o -iname 'changes*' -o -iname '*migrat*' -o -iname 'history*' -o -iname 'upgrad*' \\) -print; done | head -30`,
  };
}
