import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectOk } from "./github.ts";

export interface AppIdentity {
  clientId: string;
  installationId: number;
}

export interface TokenScope {
  repositories?: string[];
  permissions: Record<string, "read" | "write">;
}

export type TokenProvider = (scope: TokenScope) => Promise<string>;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signJwt(clientId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: clientId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

export function readPrivateKey(env: Record<string, string | undefined>): string {
  const path = env["PROSECO_APP_KEY"] || (env["CREDENTIALS_DIRECTORY"] ? join(env["CREDENTIALS_DIRECTORY"], "private-key") : null);
  if (!path) throw new Error("no app private key: set PROSECO_APP_KEY to a key file, or provide a systemd credential named private-key (CREDENTIALS_DIRECTORY)");
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read the app private key file at ${path}`);
  }
}

export async function mintInstallationToken(
  app: AppIdentity,
  privateKeyPem: string,
  scope: TokenScope,
  fetchImpl: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const response = await expectOk(
    await fetchImpl(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signJwt(app.clientId, privateKeyPem, nowSeconds)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(scope),
    }),
    "installation token",
  );
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) throw new Error("installation token response had no token");
  return payload.token;
}

export function tokenProvider(env: Record<string, string | undefined>, app: AppIdentity, fetchImpl: typeof fetch = fetch): TokenProvider {
  return async (scope) => mintInstallationToken(app, readPrivateKey(env), scope, fetchImpl);
}
