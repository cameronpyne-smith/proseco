function numericVersion(value: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(value.trim());
  return match ? match[1]!.split(".").map(Number) : null;
}

function compareNumeric(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function highestVersion(versions: string[]): string[] {
  const distinct = [...new Set(versions)].sort();
  const parsed = distinct.map(numericVersion);
  if (distinct.length <= 1 || parsed.some((version) => version === null)) return distinct;
  let best = 0;
  for (let index = 1; index < parsed.length; index++) {
    if (compareNumeric(parsed[index]!, parsed[best]!) > 0) best = index;
  }
  return [distinct[best]!];
}

export function isMajorUpgrade(installed: string, target: string[]): boolean | null {
  if (target.length !== 1) return null;
  const from = numericVersion(installed);
  const to = numericVersion(target[0]!);
  if (!from || !to) return null;
  const leading = from.findIndex((part) => part !== 0);
  const last = leading === -1 ? from.length - 1 : leading;
  for (let index = 0; index <= last; index++) {
    if ((from[index] ?? 0) !== (to[index] ?? 0)) return true;
  }
  return false;
}

export function packageKey(ecosystem: string | null, name: string): string {
  switch (ecosystem) {
    case "pip":
      return name.toLowerCase().replace(/[-_.]+/g, "-");
    case "nuget":
      return name.toLowerCase();
    default:
      return name;
  }
}

interface ParsedVersion {
  epoch: number;
  release: number[];
  pre: { rank: number; tag: string; number: number[] } | null;
  post: number | null;
  dev: number | null;
}

const PRE_RANK: Record<string, number> = { alpha: 0, a: 0, beta: 1, b: 1, rc: 2, c: 2, pre: 2, preview: 2 };

function parseVersion(value: string): ParsedVersion | null {
  const head = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(.*)$/.exec(value.trim());
  if (!head) return null;
  const parsed: ParsedVersion = { epoch: Number(head[1] ?? 0), release: head[2]!.split(".").map(Number), pre: null, post: null, dev: null };
  let rest = head[3]!.replace(/\+.*$/, "");
  while (rest !== "") {
    let match: RegExpExecArray | null;
    if (parsed.pre === null && (match = /^[-._]?(alpha|beta|preview|pre|rc|a|b|c)(?![A-Za-z])[-._]?(\d+(?:\.\d+)*)?/i.exec(rest))) {
      parsed.pre = { rank: PRE_RANK[match[1]!.toLowerCase()]!, tag: "", number: (match[2] ?? "").split(".").filter(Boolean).map(Number) };
    } else if (parsed.post === null && (match = /^[-._]?post[-._]?(\d+)?/i.exec(rest))) {
      parsed.post = Number(match[1] ?? 0);
    } else if (parsed.dev === null && (match = /^[-._]?dev[-._]?(\d+)?/i.exec(rest))) {
      parsed.dev = Number(match[1] ?? 0);
    } else if (parsed.pre === null && (match = /^-([A-Za-z][A-Za-z0-9]*)(?:\.(\d+))?/.exec(rest))) {
      parsed.pre = { rank: 0, tag: match[1]!.toLowerCase(), number: match[2] === undefined ? [] : [Number(match[2])] };
    } else {
      return null;
    }
    rest = rest.slice(match[0].length);
  }
  return parsed;
}

function preKey(version: ParsedVersion): number {
  if (version.pre) return version.pre.rank;
  return version.post === null && version.dev !== null ? -Infinity : Infinity;
}

export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const steps = [
    left.epoch - right.epoch,
    compareNumeric(left.release, right.release),
    preKey(left) === preKey(right) ? 0 : preKey(left) < preKey(right) ? -1 : 1,
    (left.pre?.tag ?? "") === (right.pre?.tag ?? "") ? 0 : (left.pre?.tag ?? "") < (right.pre?.tag ?? "") ? -1 : 1,
    compareNumeric(left.pre?.number ?? [], right.pre?.number ?? []),
    (left.post ?? -1) - (right.post ?? -1),
    (left.dev ?? Infinity) === (right.dev ?? Infinity) ? 0 : (left.dev ?? Infinity) < (right.dev ?? Infinity) ? -1 : 1,
  ];
  return steps.find((step) => step !== 0) ?? 0;
}

export function inRange(version: string, range: string): boolean {
  const clauses = range.split(",").map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(<=|>=|<|>|=)?\s*(\S+)$/.exec(clause);
    const order = match ? compareVersions(version, match[2]!) : null;
    if (!match || order === null) return false;
    switch (match[1] ?? "=") {
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case ">=":
        return order >= 0;
      default:
        return order === 0;
    }
  });
}
