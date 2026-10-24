export interface StartupCheck {
  name: string;
  required?: boolean;
  run(): Promise<string>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runChecks(checks: StartupCheck[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, ok: true, detail: await check.run() });
    } catch (error) {
      results.push({ name: check.name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      if (check.required) break;
    }
  }
  return results;
}

export function formatChecks(results: CheckResult[]): string {
  return results.map((result) => `${result.ok ? "ok" : "FAILED"} ${result.name}: ${result.detail}`).join("\n");
}

export function allPassed(results: CheckResult[]): boolean {
  return results.every((result) => result.ok);
}

export async function checkOllama(url: string, model: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Ollama does not answer at ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`Ollama at ${url} answered /api/tags with ${response.status}`);
  const names = ((await response.json()) as { models?: { name?: string }[] }).models?.flatMap((entry) => (entry.name ? [entry.name] : [])) ?? [];
  const wanted = model.includes(":") ? model : `${model}:latest`;
  if (!names.includes(wanted)) throw new Error(`Ollama at ${url} does not have the model ${model} (it has ${names.length === 0 ? "none" : names.join(", ")})`);
  return `${url} has ${model}`;
}
