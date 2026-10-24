import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EcosystemName } from "../ecosystems/ecosystem.ts";
import type { Docker } from "./docker.ts";

const run = promisify(execFile);

export const UV_VERSION = "0.9.5";
export const NODE_DEFAULT_MAJOR = "24";
export const PYTHON_DEFAULT_VERSION = "3.13";

const SANDBOX_DIR = import.meta.dirname;
const IMAGES_DIR = join(SANDBOX_DIR, "images");

export interface ImageSpec {
  name: string;
  tag: string;
  dockerfile: string;
  buildArgs: Record<string, string>;
}

export function imageReference(image: Pick<ImageSpec, "name" | "tag">): string {
  return `${image.name}:${image.tag}`;
}

function nodeMajor(declared: string | null): string {
  return (declared && /\d+/.exec(declared)?.[0]) || NODE_DEFAULT_MAJOR;
}

function pythonVersion(declared: string | null): string {
  const match = declared ? /(\d+)\.(\d+)/.exec(declared) : null;
  return match ? `${match[1]}.${match[2]}` : PYTHON_DEFAULT_VERSION;
}

export function imageFor(ecosystem: EcosystemName, declared: string | null): ImageSpec {
  if (ecosystem === "npm") {
    const major = nodeMajor(declared);
    return { name: "proseco/node", tag: major, dockerfile: join(IMAGES_DIR, "node", "Dockerfile"), buildArgs: { NODE_MAJOR: major } };
  }
  const version = pythonVersion(declared);
  return { name: "proseco/python", tag: version, dockerfile: join(IMAGES_DIR, "python", "Dockerfile"), buildArgs: { PYTHON_VERSION: version, UV_VERSION } };
}

export async function ensureImage(docker: Docker, image: ImageSpec): Promise<string> {
  const reference = imageReference(image);
  if (!(await docker.imageExists(reference))) {
    await docker.build({ tag: reference, dockerfile: image.dockerfile, context: dirname(image.dockerfile), buildArgs: image.buildArgs });
  }
  return reference;
}

async function git(args: string[]): Promise<string | null> {
  try {
    return (await run("git", ["-C", SANDBOX_DIR, ...args])).stdout.trim();
  } catch {
    return null;
  }
}

export async function proxyImageTag(): Promise<string> {
  const sha = await git(["rev-parse", "--short", "HEAD"]);
  const dirty = await git(["status", "--porcelain", "--", "proxy.ts"]);
  return sha && dirty === "" ? sha : "dev";
}

export async function ensureProxyImage(docker: Docker): Promise<string> {
  const tag = await proxyImageTag();
  const reference = `proseco/proxy:${tag}`;
  if (tag === "dev" || !(await docker.imageExists(reference))) {
    await docker.build({ tag: reference, dockerfile: join(IMAGES_DIR, "proxy", "Dockerfile"), context: SANDBOX_DIR, buildArgs: {} });
  }
  return reference;
}
