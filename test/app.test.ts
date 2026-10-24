import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mintInstallationToken, readPrivateKey, signJwt, tokenProvider } from "../src/core/app.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("app JWT", () => {
  it("signs RS256 over header.payload so the public key verifies it", () => {
    const jwt = signJwt("Iv1.acme", PEM, 1_700_000_000);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(decode(payload), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "Iv1.acme" });
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
  });

  it("does not verify once the payload is altered", () => {
    const [header, , signature] = signJwt("Iv1.acme", PEM, 1_700_000_000).split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ iss: "other" })).toString("base64url");
    assert.equal(verify("sha256", Buffer.from(`${header}.${forged}`), publicKey, Buffer.from(signature, "base64url")), false);
  });
});

describe("installation tokens", () => {
  const app = { clientId: "Iv1.acme", installationId: 42 };

  it("posts the repositories and permissions with the app JWT and returns the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ token: "ghs_installation" }), { status: 201 });
    }) as unknown as typeof fetch;
    const token = await mintInstallationToken(app, PEM, { repositories: ["acme-api"], permissions: { contents: "read" } }, fetchImpl, 1_700_000_000);
    assert.equal(token, "ghs_installation");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.github.com/app/installations/42/access_tokens");
    assert.equal(calls[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { repositories: ["acme-api"], permissions: { contents: "read" } });
    const auth = (calls[0]!.init.headers as Record<string, string>)["authorization"]!;
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(decode(auth.split(".")[1]!), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "Iv1.acme" });
  });

  it("names the failure and never echoes the key", async () => {
    const fetchImpl = (async () => new Response("Bad credentials", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await assert.rejects(
      mintInstallationToken(app, PEM, { repositories: ["acme-api"], permissions: { contents: "read" } }, fetchImpl),
      (error: Error) => /installation token failed: 401/.test(error.message) && !error.message.includes("PRIVATE KEY"),
    );
  });
});

describe("private key location", () => {
  const dir = mkdtempSync(join(tmpdir(), "proseco-key-"));
  const viaEnv = join(dir, "env.pem");
  writeFileSync(viaEnv, "from env");
  const credentials = mkdtempSync(join(tmpdir(), "proseco-cred-"));
  writeFileSync(join(credentials, "private-key"), "from credentials");

  it("prefers PROSECO_APP_KEY", () => {
    assert.equal(readPrivateKey({ PROSECO_APP_KEY: viaEnv, CREDENTIALS_DIRECTORY: credentials }), "from env");
  });

  it("falls back to the systemd credential", () => {
    assert.equal(readPrivateKey({ CREDENTIALS_DIRECTORY: credentials }), "from credentials");
  });

  it("says where it looked when there is no key", () => {
    assert.throws(() => readPrivateKey({}), /PROSECO_APP_KEY.*CREDENTIALS_DIRECTORY/);
  });
});

describe("token provider", () => {
  it("mints per scope using the key from the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-key-"));
    writeFileSync(join(dir, "key.pem"), PEM);
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ token: `ghs_${bodies.length}` }), { status: 201 });
    }) as unknown as typeof fetch;
    const provider = tokenProvider({ PROSECO_APP_KEY: join(dir, "key.pem") }, { clientId: "Iv1.acme", installationId: 42 }, fetchImpl);
    assert.equal(await provider({ repositories: ["a"], permissions: { issues: "read" } }), "ghs_1");
    assert.equal(await provider({ repositories: ["b"], permissions: { contents: "read" } }), "ghs_2");
    assert.deepEqual(bodies, [
      { repositories: ["a"], permissions: { issues: "read" } },
      { repositories: ["b"], permissions: { contents: "read" } },
    ]);
  });
});
