import { createHash, createPrivateKey, createSign, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamsConfig } from "../core/config.ts";

const BOT_SCOPE = "https://api.botframework.com/.default";
const ASSERTION_SECONDS = 600;
const REQUEST_MS = 30_000;
const MAX_ERROR_BODY = 300;

export interface TeamsCredential {
  privateKey: string;
  certificate: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function pemBlocks(pem: string, label: RegExp): string[] {
  return [...pem.matchAll(/-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g)].filter((match) => label.test(match[1]!)).map((match) => match[0]);
}

export function parseCredential(pem: string): TeamsCredential {
  const [privateKey] = pemBlocks(pem, /PRIVATE KEY$/);
  const [certificate] = pemBlocks(pem, /^CERTIFICATE$/);
  if (!privateKey || !certificate) throw new Error("the Teams certificate file must hold the private key and the certificate, both PEM encoded");
  const cert = new X509Certificate(certificate);
  if (!cert.checkPrivateKey(createPrivateKey(privateKey))) throw new Error("the Teams certificate does not match its private key");
  return { privateKey, certificate };
}

export function readTeamsCredential(env: Record<string, string | undefined>): TeamsCredential {
  const path = env["PROSECO_TEAMS_CERT"] || (env["CREDENTIALS_DIRECTORY"] ? join(env["CREDENTIALS_DIRECTORY"], "teams-certificate") : null);
  if (!path) throw new Error("no Teams certificate: set PROSECO_TEAMS_CERT to a PEM file, or provide a systemd credential named teams-certificate (CREDENTIALS_DIRECTORY)");
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read the Teams certificate file at ${path}`);
  }
  return parseCredential(pem);
}

export function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

export function clientAssertion(teams: Pick<TeamsConfig, "tenantId" | "appId">, credential: TeamsCredential, nowSeconds: number, id: string = randomUUID()): string {
  const thumbprint = createHash("sha1").update(new X509Certificate(credential.certificate).raw).digest();
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", x5t: base64url(thumbprint) }));
  const payload = base64url(
    JSON.stringify({ aud: tokenEndpoint(teams.tenantId), iss: teams.appId, sub: teams.appId, jti: id, nbf: nowSeconds - 60, iat: nowSeconds - 60, exp: nowSeconds + ASSERTION_SECONDS }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(credential.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = (await response.text()).slice(0, MAX_ERROR_BODY);
  return new Error(`${what} failed: ${response.status} ${response.statusText}${body ? ` ${body}` : ""}`);
}

export class TeamsClient {
  readonly #teams: TeamsConfig;
  readonly #credential: () => TeamsCredential;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(teams: TeamsConfig, credential: () => TeamsCredential, fetchImpl: typeof fetch = fetch, now = () => Math.floor(Date.now() / 1000)) {
    this.#teams = teams;
    this.#credential = credential;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async token(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#teams.appId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion(this.#teams, this.#credential(), this.#now()),
      scope: BOT_SCOPE,
    });
    const response = await this.#fetch(tokenEndpoint(this.#teams.tenantId), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) throw await failure(response, "Teams sign-in");
    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) throw new Error("Teams sign-in returned no access token");
    return payload.access_token;
  }

  async send(html: string): Promise<void> {
    const token = await this.token();
    const url = `${this.#teams.serviceUrl}/v3/conversations/${encodeURIComponent(this.#teams.chatId)}/activities`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", textFormat: "xml", text: html }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) throw await failure(response, "Teams post");
  }
}
