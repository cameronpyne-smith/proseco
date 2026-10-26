const BLOCK = 512;

export type TarEntry =
  | { type: "file"; path: string; mode: number; data: Buffer }
  | { type: "directory"; path: string; mode: number }
  | { type: "symlink"; path: string; target: string };

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(header: Buffer, offset: number, length: number, what: string): number {
  const text = field(header, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar header has an unreadable ${what}: ${JSON.stringify(text)}`);
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
  return sum === octal(header, 148, 8, "checksum");
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(32, position);
    if (space === -1) throw new Error("tar pax header is malformed");
    const length = Number(data.subarray(position, space).toString("utf8"));
    if (!Number.isInteger(length) || length <= space - position || position + length > data.length) throw new Error("tar pax header is malformed");
    const record = data.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new Error("tar pax header is malformed");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let position = 0;
  let longPath: string | null = null;
  let longTarget: string | null = null;
  let pax = new Map<string, string>();
  while (position + BLOCK <= archive.length) {
    const header = archive.subarray(position, position + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new Error(`tar header at byte ${position} has a bad checksum`);
    const type = String.fromCharCode(header[156]!);
    const paxSize = pax.get("size");
    if (paxSize !== undefined && !/^\d+$/.test(paxSize)) throw new Error(`tar entry at byte ${position} has an invalid pax size: ${JSON.stringify(paxSize)}`);
    const size = paxSize !== undefined ? Number(paxSize) : octal(header, 124, 12, "size");
    const start = position + BLOCK;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > archive.length) throw new Error(`tar entry at byte ${position} runs past the end of the archive`);
    const data = archive.subarray(start, start + size);
    position = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L" || type === "K") {
      const text = data.toString("utf8").replace(/\0+$/, "");
      if (type === "L") longPath = text;
      else longTarget = text;
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = pax.get("path") ?? longPath ?? (prefix ? `${prefix}/${name}` : name);
    const target = pax.get("linkpath") ?? longTarget ?? field(header, 157, 100);
    const mode = octal(header, 100, 8, "mode");
    pax = new Map();
    longPath = null;
    longTarget = null;
    if (type === "0" || type === "\0" || type === "7") entries.push({ type: "file", path, mode, data });
    else if (type === "5") entries.push({ type: "directory", path, mode });
    else if (type === "2") entries.push({ type: "symlink", path, target });
    else throw new Error(`${path} is a ${type === "1" ? "hard link" : `tar entry of type ${JSON.stringify(type)}`}, which cannot be copied out of the sandbox`);
  }
  return entries;
}
