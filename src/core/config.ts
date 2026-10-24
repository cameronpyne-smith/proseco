import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TicketsConfig {
  repo: string;
  project: string | null;
  labels: string[];
  find: { labels: string[]; creators: string[] };
  maintainedIn: string;
}

export interface DefenderConfig {
  imageRepos: Map<string, string>;
}

export interface FixerConfig {
  labels: { fix: string };
  app: { clientId: string; installationId: number };
  cloneDir: string;
  stateFile: string;
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

function list(value: unknown, path: string, item: (value: unknown, path: string) => string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array`);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

const LABEL = (value: unknown, path: string) => text(value, path);
const LOGIN = (value: unknown, path: string) => name(value, path, /^[A-Za-z0-9-]+(\[bot\])?$/);

export function parseImageRepos(mapping: unknown, path = "imageRepos"): Map<string, string> {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    throw new ConfigError(`${path} must be an object of package name to repo name`);
  }
  const repoByPackage = new Map<string, string>();
  for (const [pkg, repo] of Object.entries(mapping)) {
    if (pkg !== pkg.toLowerCase() || !/^[a-z0-9._-]+$/.test(pkg)) {
      throw new ConfigError(`${path}: "${pkg}" is not a lowercase ghcr package name`);
    }
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo)) {
      throw new ConfigError(`${path}: "${pkg}" must map to a repo name without the org`);
    }
    repoByPackage.set(pkg, repo);
  }
  return repoByPackage;
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
    const raw = object(root["fixer"], "fixer", ["labels", "app", "cloneDir", "stateFile"]);
    const labels = object(raw["labels"], "fixer.labels", ["fix"]);
    const app = object(raw["app"], "fixer.app", ["clientId", "installationId"]);
    fixer = {
      labels: { fix: text(labels["fix"], "fixer.labels.fix") },
      app: { clientId: text(app["clientId"], "fixer.app.clientId"), installationId: positiveInteger(app["installationId"], "fixer.app.installationId") },
      cloneDir: text(raw["cloneDir"], "fixer.cloneDir"),
      stateFile: text(raw["stateFile"], "fixer.stateFile"),
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
