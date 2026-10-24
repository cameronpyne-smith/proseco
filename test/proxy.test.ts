import assert from "node:assert/strict";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { after, before, describe, it } from "node:test";
import { allowed, createProxy } from "../src/fixer/sandbox/proxy.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.write(payload);
  });
}

describe("allowed", () => {
  const list = ["registry.npmjs.org", "*.nuget.org"];
  it("matches exact hosts and subdomains of a wildcard, ignoring case and a trailing dot", () => {
    assert.equal(allowed(list, "registry.npmjs.org"), true);
    assert.equal(allowed(list, "Registry.NpmJS.org."), true);
    assert.equal(allowed(list, "globalcdn.nuget.org"), true);
  });
  it("refuses the wildcard apex, look-alikes and unlisted hosts", () => {
    assert.equal(allowed(list, "nuget.org"), false);
    assert.equal(allowed(list, "evilnuget.org"), false);
    assert.equal(allowed(list, "registry.npmjs.org.evil.com"), false);
    assert.equal(allowed(list, "example.com"), false);
  });
});

describe("proxy", () => {
  const echo = createServer((socket) => socket.pipe(socket));
  const lines: string[] = [];
  let proxy: Server;
  let proxyPort = 0;
  let echoPort = 0;

  before(async () => {
    echoPort = await listen(echo);
    proxy = createProxy({ allow: ["127.0.0.1"], ports: [echoPort], log: (line) => lines.push(line) });
    proxyPort = await listen(proxy);
  });
  after(() => {
    proxy.close();
    echo.close();
  });

  it("tunnels bytes both ways for an allowed CONNECT", async () => {
    const socket: Socket = connect(proxyPort, "127.0.0.1");
    const received = await new Promise<string>((resolve, reject) => {
      let data = "";
      let tunnelled = false;
      socket.on("data", (chunk) => {
        data += chunk;
        if (!tunnelled && data.includes("\r\n\r\n")) {
          tunnelled = true;
          assert.match(data, /^HTTP\/1\.1 200/);
          data = "";
          socket.write("ping");
        } else if (tunnelled && data === "ping") {
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    });
    assert.equal(received, "ping");
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(lines.some((line) => line.startsWith(`allowed 127.0.0.1:${echoPort} bytes=`)), lines.join("\n"));
  });

  it("refuses a CONNECT to a host that is not allowed with 403 naming the host", async () => {
    const response = await exchange(proxyPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.match(response, /example\.com/);
    assert.ok(lines.includes("refused example.com:443 bytes=0"), lines.join("\n"));
  });

  it("refuses an allowed host on a port that is not allowed", async () => {
    const response = await exchange(proxyPort, `CONNECT 127.0.0.1:${echoPort + 1} HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 403 /);
  });

  it("refuses plain HTTP, even to an allowed host", async () => {
    const response = await exchange(proxyPort, "GET http://127.0.0.1/pkg HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.match(response, /127\.0\.0\.1/);
  });

  it("answers 400 and closes on a CONNECT with no port", async () => {
    const response = await exchange(proxyPort, "CONNECT registry HTTP/1.1\r\nHost: registry\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 400 /);
  });

  it("answers 400 and closes on garbage", async () => {
    const response = await exchange(proxyPort, "\u0000\u0001 not http\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 400 /);
  });

  it("answers 400 to a request that is not addressed to a proxy", async () => {
    const response = await exchange(proxyPort, "GET /pkg HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 400 /);
  });
});
