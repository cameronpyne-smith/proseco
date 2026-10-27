import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createVerify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TeamsConfig } from "../src/core/config.ts";
import { clientAssertion, parseCredential, readTeamsCredential, TeamsClient, tokenEndpoint } from "../src/fixer/teams.ts";

const TEAMS: TeamsConfig = { tenantId: "00000000-0000-4000-8000-000000000001", appId: "00000000-0000-4000-8000-000000000002", chatId: "19:abc@thread.v2", serviceUrl: "https://smba.trafficmanager.net/teams" };

function certificate(): { pem: string; key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "proseco-teams-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=proseco-test", "-days", "1"], { stdio: "ignore" });
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  return { pem: `${key}${cert}`, key, cert };
}

const ONE = certificate();
const OTHER = certificate();

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

interface Call {
  url: string;
  init: RequestInit;
}

function recorder(...replies: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return replies.shift() ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("Teams certificate", () => {
  it("reads the key and the certificate from one PEM file in either order", () => {
    assert.equal(parseCredential(ONE.pem).certificate, ONE.cert.trim());
    assert.equal(parseCredential(`${ONE.cert}${ONE.key}`).privateKey, ONE.key.trim());
  });

  it("refuses a file without both parts, or with a certificate for another key", () => {
    assert.throws(() => parseCredential(ONE.key), /must hold the private key and the certificate/);
    assert.throws(() => parseCredential(ONE.cert), /must hold the private key and the certificate/);
    assert.throws(() => parseCredential(`${ONE.key}${OTHER.cert}`), /does not match its private key/);
  });

  it("reads the systemd credential or the file named by PROSECO_TEAMS_CERT, and says which is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-credentials-"));
    writeFileSync(join(dir, "teams-certificate"), ONE.pem);
    assert.equal(readTeamsCredential({ CREDENTIALS_DIRECTORY: dir }).certificate, ONE.cert.trim());
    assert.equal(readTeamsCredential({ PROSECO_TEAMS_CERT: join(dir, "teams-certificate") }).certificate, ONE.cert.trim());
    assert.throws(() => readTeamsCredential({}), /no Teams certificate/);
    assert.throws(() => readTeamsCredential({ PROSECO_TEAMS_CERT: join(dir, "absent") }), /cannot read the Teams certificate file/);
  });

  it("signs a client assertion for the tenant's token endpoint, naming the certificate by thumbprint", () => {
    const credential = parseCredential(ONE.pem);
    const jwt = clientAssertion(TEAMS, credential, 1_000_000, "id-1");
    const [header, payload, signature] = jwt.split(".");
    const thumbprint = createHash("sha1").update(new X509Certificate(ONE.cert).raw).digest("base64url");
    assert.deepEqual(decode(header!), { alg: "RS256", typ: "JWT", x5t: thumbprint });
    assert.deepEqual(decode(payload!), { aud: tokenEndpoint(TEAMS.tenantId), iss: TEAMS.appId, sub: TEAMS.appId, jti: "id-1", nbf: 999_940, iat: 999_940, exp: 1_000_600 });
    assert.ok(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(new X509Certificate(ONE.cert).publicKey, Buffer.from(signature!, "base64url")));
  });
});

describe("Teams client", () => {
  it("gets a Bot Framework token with the certificate, then posts the message to the chat as xml", async () => {
    const { fetch, calls } = recorder(new Response(JSON.stringify({ access_token: "bot-token" })), new Response("{}", { status: 201 }));
    await new TeamsClient(TEAMS, () => parseCredential(ONE.pem), fetch, () => 1_000_000).send("<a href=\"u\">12</a> - Fix");
    assert.equal(calls[0]!.url, `https://login.microsoftonline.com/${TEAMS.tenantId}/oauth2/v2.0/token`);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), TEAMS.appId);
    assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    assert.equal(form.get("scope"), "https://api.botframework.com/.default");
    assert.equal(form.get("client_secret"), null);
    assert.equal(decode(form.get("client_assertion")!.split(".")[1]!)["iss"], TEAMS.appId);
    assert.equal(calls[1]!.url, "https://smba.trafficmanager.net/teams/v3/conversations/19%3Aabc%40thread.v2/activities");
    assert.equal((calls[1]!.init.headers as Record<string, string>)["authorization"], "Bearer bot-token");
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { type: "message", textFormat: "xml", text: "<a href=\"u\">12</a> - Fix" });
  });

  it("names the step and the status when sign-in or posting fails", async () => {
    const signIn = recorder(new Response("AADSTS700027: certificate not registered", { status: 401, statusText: "Unauthorized" }));
    await assert.rejects(new TeamsClient(TEAMS, () => parseCredential(ONE.pem), signIn.fetch).send("x"), /Teams sign-in failed: 401 Unauthorized AADSTS700027/);
    const post = recorder(new Response(JSON.stringify({ access_token: "t" })), new Response('{"error":{"code":"BotNotInConversationRoster"}}', { status: 403, statusText: "Forbidden" }));
    await assert.rejects(new TeamsClient(TEAMS, () => parseCredential(ONE.pem), post.fetch).send("x"), /Teams post failed: 403 Forbidden .*BotNotInConversationRoster/);
    const empty = recorder(new Response("{}"));
    await assert.rejects(new TeamsClient(TEAMS, () => parseCredential(ONE.pem), empty.fetch).token(), /returned no access token/);
  });
});
