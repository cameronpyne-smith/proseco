export function pytestFailures(output: string): string[] | null {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^(?:FAILED|ERROR) (\S+)/.exec(line);
    if (match) ids.add(match[1]!);
  }
  return ids.size === 0 ? null : [...ids].sort();
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function pythonReview(pkg: string, directory: string, python: string): string[] {
  if (!SAFE_NAME.test(pkg)) return [];
  const where = `cd ${directory === "." ? "/work" : `/work/${directory}`} && ${python} -c "import importlib.metadata as m, sys; d = m.distribution(sys.argv[1]); print(d.locate_file('')); print(sorted({f.parts[0] for f in d.files if not f.parts[0].endswith(('.dist-info', '__pycache__'))}))" ${pkg}`;
  return [
    `\`${where}\` prints the install directory and the package's top-level names`,
    `then \`grep -rhoiE "[^\\"']*(no longer|has been removed|removed in|was removed|deprecated)[^\\"']*" <install directory>/<top-level name> --include=*.py --include=*.md --include=*.rst | sort -u | head -100\`, and \`ls <install directory>/<top-level name>/.. | grep -iE "changelog|migrat|history"\` for notes shipped with it`,
  ];
}
