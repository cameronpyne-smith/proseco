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
