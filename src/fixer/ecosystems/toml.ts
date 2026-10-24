export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
type Table = { [key: string]: TomlValue };

class Reader {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  get line(): number {
    let count = 1;
    for (let index = 0; index < this.pos && index < this.text.length; index++) if (this.text[index] === "\n") count++;
    return count;
  }

  fail(message: string): never {
    throw new Error(`uv.lock line ${this.line}: ${message}`);
  }

  peek(length = 1): string {
    return this.text.slice(this.pos, this.pos + length);
  }

  blanks(newlines: boolean): void {
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!;
      if (char === " " || char === "\t" || char === "\r" || (newlines && char === "\n")) this.pos++;
      else if (char === "#") while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
      else break;
    }
  }

  expect(token: string): void {
    if (this.peek(token.length) !== token) this.fail(`expected "${token}"`);
    this.pos += token.length;
  }

  endOfLine(): void {
    this.blanks(false);
    if (this.pos < this.text.length && this.text[this.pos] !== "\n") this.fail("unexpected text after a value");
  }
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function basicString(reader: Reader): string {
  if (reader.peek(3) === '"""') reader.fail("unsupported TOML: multi-line strings");
  reader.expect('"');
  let value = "";
  for (;;) {
    const char = reader.text[reader.pos];
    if (char === undefined || char === "\n") reader.fail("unterminated string");
    reader.pos++;
    if (char === '"') return value;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escape = reader.text[reader.pos++];
    if (escape !== undefined && escape in ESCAPES) value += ESCAPES[escape];
    else if (escape === "u" || escape === "U") {
      const length = escape === "u" ? 4 : 8;
      const hex = reader.text.slice(reader.pos, reader.pos + length);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) reader.fail("bad unicode escape");
      value += String.fromCodePoint(parseInt(hex, 16));
      reader.pos += length;
    } else reader.fail(`unsupported escape \\${escape ?? ""}`);
  }
}

function literalString(reader: Reader): string {
  if (reader.peek(3) === "'''") reader.fail("unsupported TOML: multi-line strings");
  reader.expect("'");
  const end = reader.text.indexOf("'", reader.pos);
  const newline = reader.text.indexOf("\n", reader.pos);
  if (end === -1 || (newline !== -1 && newline < end)) reader.fail("unterminated string");
  const value = reader.text.slice(reader.pos, end);
  reader.pos = end + 1;
  return value;
}

function key(reader: Reader): string {
  const char = reader.peek();
  if (char === '"') return basicString(reader);
  if (char === "'") return literalString(reader);
  const match = /^[A-Za-z0-9_-]+/.exec(reader.text.slice(reader.pos, reader.pos + 256));
  if (!match) reader.fail("expected a key");
  reader.pos += match[0].length;
  return match[0];
}

function keyPath(reader: Reader): string[] {
  const keys = [key(reader)];
  for (;;) {
    reader.blanks(false);
    if (reader.peek() !== ".") return keys;
    reader.pos++;
    reader.blanks(false);
    keys.push(key(reader));
  }
}

function value(reader: Reader): TomlValue {
  const char = reader.peek();
  if (char === '"') return basicString(reader);
  if (char === "'") return literalString(reader);
  if (char === "[") return array(reader);
  if (char === "{") return inlineTable(reader);
  const word = /^[^\s,\]}#]+/.exec(reader.text.slice(reader.pos, reader.pos + 256))?.[0] ?? "";
  if (word === "true" || word === "false") {
    reader.pos += word.length;
    return word === "true";
  }
  if (/^[+-]?\d+(_\d+)*$/.test(word)) {
    reader.pos += word.length;
    return Number(word.replaceAll("_", ""));
  }
  return reader.fail(`unsupported TOML value "${word}"`);
}

function array(reader: Reader): TomlValue[] {
  reader.expect("[");
  const items: TomlValue[] = [];
  for (;;) {
    reader.blanks(true);
    if (reader.peek() === "]") {
      reader.pos++;
      return items;
    }
    items.push(value(reader));
    reader.blanks(true);
    if (reader.peek() === ",") reader.pos++;
    else if (reader.peek() !== "]") reader.fail('expected "," or "]"');
  }
}

function assign(reader: Reader, table: Table, path: string[], item: TomlValue): void {
  let target = table;
  for (const part of path.slice(0, -1)) {
    const next = target[part] ?? (target[part] = {});
    if (typeof next !== "object" || Array.isArray(next)) reader.fail(`key ${part} is not a table`);
    target = next;
  }
  const last = path[path.length - 1]!;
  if (last in target) reader.fail(`duplicate key ${last}`);
  target[last] = item;
}

function inlineTable(reader: Reader): Table {
  reader.expect("{");
  const table: Table = {};
  reader.blanks(false);
  if (reader.peek() === "}") {
    reader.pos++;
    return table;
  }
  for (;;) {
    reader.blanks(false);
    const path = keyPath(reader);
    reader.blanks(false);
    reader.expect("=");
    reader.blanks(false);
    assign(reader, table, path, value(reader));
    reader.blanks(false);
    if (reader.peek() === ",") reader.pos++;
    else if (reader.peek() === "}") {
      reader.pos++;
      return table;
    } else reader.fail('expected "," or "}"');
  }
}

function enter(reader: Reader, root: Table, path: string[], arrayTable: boolean): Table {
  let target = root;
  path.forEach((part, index) => {
    const last = index === path.length - 1;
    let next = target[part];
    if (last && arrayTable) {
      if (next === undefined) next = target[part] = [];
      if (!Array.isArray(next)) reader.fail(`${part} is not an array of tables`);
      const created: Table = {};
      next.push(created);
      target = created;
      return;
    }
    if (next === undefined) next = target[part] = {};
    if (Array.isArray(next)) {
      const tail = next[next.length - 1];
      if (typeof tail !== "object" || tail === null || Array.isArray(tail)) reader.fail(`${part} is not a table`);
      target = tail;
    } else if (typeof next === "object") target = next;
    else reader.fail(`${part} is not a table`);
  });
  return target;
}

export function parseToml(text: string): Table {
  const reader = new Reader(text);
  const root: Table = {};
  let current = root;
  for (;;) {
    reader.blanks(true);
    if (reader.pos >= text.length) return root;
    if (reader.peek(2) === "[[") {
      reader.pos += 2;
      reader.blanks(false);
      const path = keyPath(reader);
      reader.blanks(false);
      reader.expect("]]");
      current = enter(reader, root, path, true);
    } else if (reader.peek() === "[") {
      reader.pos++;
      reader.blanks(false);
      const path = keyPath(reader);
      reader.blanks(false);
      reader.expect("]");
      current = enter(reader, root, path, false);
    } else {
      const path = keyPath(reader);
      reader.blanks(false);
      reader.expect("=");
      reader.blanks(false);
      assign(reader, current, path, value(reader));
    }
    reader.endOfLine();
  }
}
