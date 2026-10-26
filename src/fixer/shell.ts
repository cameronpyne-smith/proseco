const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function shellWord(text: string): string {
  return PLAIN.test(text) ? text : shellQuote(text);
}
