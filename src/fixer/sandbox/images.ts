import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImageFamily } from "../ecosystems/ecosystem.ts";
import type { Docker } from "./docker.ts";

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

function contentTag(...parts: Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 12);
}

export async function imageReference(image: Pick<ImageSpec, "name" | "tag" | "dockerfile">): Promise<string> {
  return `${image.name}:${image.tag}-${contentTag(await readFile(image.dockerfile))}`;
}

function nodeMajor(declared: string | null): string {
  return (declared && /\d+/.exec(declared)?.[0]) || NODE_DEFAULT_MAJOR;
}

function pythonVersion(declared: string | null): string {
  const match = declared ? /(\d+)\.(\d+)/.exec(declared) : null;
  return match ? `${match[1]}.${match[2]}` : PYTHON_DEFAULT_VERSION;
}

export function imageFor(family: ImageFamily, declared: string | null): ImageSpec {
  if (family === "node") {
    const major = nodeMajor(declared);
    return { name: "proseco/node", tag: major, dockerfile: join(IMAGES_DIR, "node", "Dockerfile"), buildArgs: { NODE_MAJOR: major } };
  }
  const version = pythonVersion(declared);
  return { name: "proseco/python", tag: version, dockerfile: join(IMAGES_DIR, "python", "Dockerfile"), buildArgs: { PYTHON_VERSION: version, UV_VERSION } };
}

export async function ensureImage(docker: Docker, image: ImageSpec): Promise<string> {
  const reference = await imageReference(image);
  if (!(await docker.imageExists(reference))) {
    await docker.build({ tag: reference, dockerfile: image.dockerfile, context: dirname(image.dockerfile), buildArgs: image.buildArgs });
  }
  return reference;
}

export async function proxyImageTag(): Promise<string> {
  return contentTag(await readFile(join(SANDBOX_DIR, "proxy.ts")));
}

export async function ensureProxyImage(docker: Docker): Promise<string> {
  const tag = await proxyImageTag();
  const reference = `proseco/proxy:${tag}`;
  if (!(await docker.imageExists(reference))) {
    await docker.build({ tag: reference, dockerfile: join(IMAGES_DIR, "proxy", "Dockerfile"), context: SANDBOX_DIR, buildArgs: {} });
  }
  return reference;
}
