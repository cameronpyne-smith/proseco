import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TicketsConfig {
  repo: string;
  project: string | null;
  labels: string[];
  find: { labels: string[]; creators: string[] };
  maintainedIn: string;
}

export interface ImageRouting {
  own: Map<string, string>;
  thirdParty: Map<string, string>;
  ignore: string[];
}

export interface DefenderConfig {
  imageRepos: ImageRouting;
}

export interface SandboxLimits {
  memory: string;
  cpus: number;
}

export const DEFAULT_PROXY_ALLOW = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.nuget.org", "*.nuget.org"];
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { memory: "8g", cpus: 4 };

export interface OllamaConfig {
  url: string;
  model: string;
  numCtx: number;
  numPredict: number;
  think: boolean;
  timeoutMinutes: number;
}

export interface BudgetConfig {
  minutes: number;
  toolCalls: number;
  commandMinutes: number;
}

export const DEFAULT_OLLAMA: OllamaConfig = { url: "http://127.0.0.1:11434", model: "qwen3.8:27b", numCtx: 65536, numPredict: 12288, think: true, timeoutMinutes: 20 };
export const DEFAULT_BUDGET: BudgetConfig = { minutes: 30, toolCalls: 200, commandMinutes: 10 };

export interface FixerConfig {
  bot: string;
  app: { clientId: string; installationId: number };
  cloneDir: string;
  stateFile: string;
  proxy: { allow: string[] };
  sandbox: SandboxLimits;
  ollama: OllamaConfig;
  budget: BudgetConfig;
}

export interface Config {
  org: string;
  tickets: TicketsConfig;
  sources: { dependabot: boolean; defender: DefenderConfig | null };
  fixer: FixerConfig | null;
}

type Json = Record<string, unknown>;

class ConfigError extends Error {}

function object(value: unknown, path: string, keys: string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new ConfigError(`${path} has unknown keys: ${unknown.join(", ")}`);
  return value as Json;
}

function name(value: unknown, path: string, pattern = /^[A-Za-z0-9._-]+$/): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ConfigError(`${path} must be a name matching ${pattern}`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${path} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new ConfigError(`${path} must be a positive integer`);
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ConfigError(`${path} must be a positive number`);
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be true or false`);
  return value;
}

function httpUrl(value: unknown, path: string): string {
  const message = `${path} must be an http or https URL`;
  if (typeof value !== "string") throw new ConfigError(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(message);
  return value.replace(/\/+$/, "");
}

function option<T>(raw: Json, key: string, path: string, fallback: T, read: (value: unknown, path: string) => T): T {
  return raw[key] === undefined ? fallback : read(raw[key], `${path}.${key}`);
}

function list(value: unknown, path: string, item: (value: unknown, path: string) => string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array`);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

const LABEL = (value: unknown, path: string) => text(value, path);
const ALLOWED_HOST = (value: unknown, path: string) =>
  name(value, path, /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/);
const LOGIN = (value: unknown, path: string) => name(value, path, /^[A-Za-z0-9-]+(\[bot\])?$/);

const IMAGE_PREFIX = /^[a-z0-9._/-]*\/[a-z0-9._/-]*$/;

function imagePrefix(value: unknown, path: string): string {
  if (typeof value !== "string" || !IMAGE_PREFIX.test(value)) {
    throw new ConfigError(`${path}: ${JSON.stringify(value)} is not an image reference prefix: lowercase, [a-z0-9._/-], at least one "/", no tag or digest`);
  }
  return value;
}

function imageSection(value: unknown, path: string): Map<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(`${path} must be an object`);
  const section = new Map<string, string>();
  for (const [prefix, repo] of Object.entries(value)) {
    imagePrefix(prefix, path);
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo)) {
      throw new ConfigError(`${path}: "${prefix}" must map to a repo name without the org`);
    }
    section.set(prefix, repo);
  }
  return section;
}

export function parseImageRepos(mapping: unknown, path = "imageRepos"): ImageRouting {
  const root = object(mapping, path, ["own", "thirdParty", "ignore"]);
  for (const key of ["own", "thirdParty", "ignore"]) {
    if (root[key] === undefined) throw new ConfigError(`${path} is missing "${key}"`);
  }
  const own = imageSection(root["own"], `${path}.own`);
  const thirdParty = imageSection(root["thirdParty"], `${path}.thirdParty`);
  const ignore = list(root["ignore"], `${path}.ignore`, imagePrefix);
  const seen = new Set<string>();
  for (const prefix of [...own.keys(), ...thirdParty.keys(), ...ignore]) {
    if (seen.has(prefix)) throw new ConfigError(`${path}: "${prefix}" is listed in more than one section`);
    seen.add(prefix);
  }
  return { own, thirdParty, ignore };
}

export function parseConfig(raw: unknown, readJson: (relativePath: string) => unknown): Config {
  const root = object(raw, "config", ["org", "tickets", "sources", "fixer"]);
  const tickets = object(root["tickets"], "tickets", ["repo", "project", "labels", "find", "maintainedIn"]);
  const find = object(tickets["find"], "tickets.find", ["labels", "creators"]);
  const findLabels = list(find["labels"], "tickets.find.labels", LABEL);
  const creators = list(find["creators"], "tickets.find.creators", LOGIN);
  if (findLabels.length + creators.length === 0) {
    throw new ConfigError("tickets.find needs at least one label or creator, or existing tickets cannot be found");
  }
  const sources = object(root["sources"], "sources", ["dependabot", "defender"]);
  if (sources["dependabot"] !== undefined) object(sources["dependabot"], "sources.dependabot", []);
  let defender: DefenderConfig | null = null;
  if (sources["defender"] !== undefined) {
    const raw = object(sources["defender"], "sources.defender", ["imageRepos"]);
    const file = text(raw["imageRepos"], "sources.defender.imageRepos");
    defender = { imageRepos: parseImageRepos(readJson(file), file) };
  }
  if (sources["dependabot"] === undefined && !defender) throw new ConfigError("sources must enable at least one source");
  let fixer: FixerConfig | null = null;
  if (root["fixer"] !== undefined) {
    const raw = object(root["fixer"], "fixer", ["bot", "app", "cloneDir", "stateFile", "proxy", "sandbox", "ollama", "budget"]);
    const app = object(raw["app"], "fixer.app", ["clientId", "installationId"]);
    const proxy = raw["proxy"] === undefined ? {} : object(raw["proxy"], "fixer.proxy", ["allow"]);
    const sandbox = raw["sandbox"] === undefined ? {} : object(raw["sandbox"], "fixer.sandbox", ["memory", "cpus"]);
    const ollama = raw["ollama"] === undefined ? {} : object(raw["ollama"], "fixer.ollama", ["url", "model", "numCtx", "numPredict", "think", "timeoutMinutes"]);
    const budget = raw["budget"] === undefined ? {} : object(raw["budget"], "fixer.budget", ["minutes", "toolCalls", "commandMinutes"]);
    const allow = proxy["allow"] === undefined ? DEFAULT_PROXY_ALLOW : list(proxy["allow"], "fixer.proxy.allow", ALLOWED_HOST);
    if (allow.length === 0) throw new ConfigError("fixer.proxy.allow must list at least one host, or the container could install nothing");
    fixer = {
      bot: name(raw["bot"], "fixer.bot", /^[A-Za-z0-9-]+$/),
      app: { clientId: text(app["clientId"], "fixer.app.clientId"), installationId: positiveInteger(app["installationId"], "fixer.app.installationId") },
      cloneDir: text(raw["cloneDir"], "fixer.cloneDir"),
      stateFile: text(raw["stateFile"], "fixer.stateFile"),
      proxy: { allow: [...allow] },
      sandbox: {
        memory: sandbox["memory"] === undefined ? DEFAULT_SANDBOX_LIMITS.memory : name(sandbox["memory"], "fixer.sandbox.memory", /^[1-9][0-9]*[bkmg]$/),
        cpus: sandbox["cpus"] === undefined ? DEFAULT_SANDBOX_LIMITS.cpus : positiveNumber(sandbox["cpus"], "fixer.sandbox.cpus"),
      },
      ollama: {
        url: option(ollama, "url", "fixer.ollama", DEFAULT_OLLAMA.url, httpUrl),
        model: option(ollama, "model", "fixer.ollama", DEFAULT_OLLAMA.model, (value, path) => name(value, path, /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)),
        numCtx: option(ollama, "numCtx", "fixer.ollama", DEFAULT_OLLAMA.numCtx, positiveInteger),
        numPredict: option(ollama, "numPredict", "fixer.ollama", DEFAULT_OLLAMA.numPredict, positiveInteger),
        think: option(ollama, "think", "fixer.ollama", DEFAULT_OLLAMA.think, flag),
        timeoutMinutes: option(ollama, "timeoutMinutes", "fixer.ollama", DEFAULT_OLLAMA.timeoutMinutes, positiveNumber),
      },
      budget: {
        minutes: option(budget, "minutes", "fixer.budget", DEFAULT_BUDGET.minutes, positiveNumber),
        toolCalls: option(budget, "toolCalls", "fixer.budget", DEFAULT_BUDGET.toolCalls, positiveInteger),
        commandMinutes: option(budget, "commandMinutes", "fixer.budget", DEFAULT_BUDGET.commandMinutes, positiveNumber),
      },
    };
  }
  return {
    org: name(root["org"], "org"),
    tickets: {
      repo: name(tickets["repo"], "tickets.repo"),
      project: tickets["project"] === undefined ? null : text(tickets["project"], "tickets.project"),
      labels: list(tickets["labels"], "tickets.labels", LABEL),
      find: { labels: findLabels, creators },
      maintainedIn: text(tickets["maintainedIn"], "tickets.maintainedIn"),
    },
    sources: { dependabot: sources["dependabot"] !== undefined, defender },
    fixer,
  };
}

export function loadConfig(path: string): Config {
  const file = resolve(path);
  const read = (target: string) => JSON.parse(readFileSync(target, "utf8")) as unknown;
  try {
    return parseConfig(read(file), (relativePath) => read(resolve(dirname(file), relativePath)));
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`${file}: ${error.message}`);
    throw error;
  }
}
