const ERROR_LINE = /\berror\b|\bERR!/i;
const HEAD_SHARE = 0.4;

export function failureExcerpt(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let from = -1;
  let offset = 0;
  for (const line of trimmed.split("\n")) {
    if (ERROR_LINE.test(line)) {
      from = offset;
      break;
    }
    offset += line.length + 1;
  }
  if (from < 0) return `…${trimmed.slice(-max)}`;
  if (trimmed.length - from <= max) return `${from > 0 ? "…\n" : ""}${trimmed.slice(from)}`;
  const head = Math.ceil(max * HEAD_SHARE);
  return `${from > 0 ? "…\n" : ""}${trimmed.slice(from, from + head)}\n…\n${trimmed.slice(-(max - head))}`;
}
