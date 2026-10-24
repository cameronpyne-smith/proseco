import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface ProxyOptions {
  allow: string[];
  ports?: number[];
  log?: (line: string) => void;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function normalise(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function allowed(allow: string[], host: string): boolean {
  const name = normalise(host);
  return allow.some((entry) => {
    const pattern = normalise(entry);
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
    return name === pattern;
  });
}

function reply(socket: Duplex, status: number, reason: string, body: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function target(authority: string): { host: string; port: number } | null {
  const match = /^([^:\s]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const host = normalise(match[1]!);
  const port = Number(match[2]);
  if (!HOST.test(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function createProxy(options: ProxyOptions): Server {
  const ports = options.ports ?? [443];
  const log = options.log ?? ((line: string) => console.log(line));

  const server = createServer((request: IncomingMessage, response) => {
    const url = /^http:\/\/([^/?#]+)/i.exec(request.url ?? "");
    if (!url) {
      response.writeHead(400, { "Content-Type": "text/plain", Connection: "close" }).end("not a proxy request\n");
      return;
    }
    const authority = /^(.*?)(?::(\d+))?$/.exec(url[1]!)!;
    const host = normalise(authority[1]!);
    const label = HOST.test(host) ? host : "invalid-host";
    log(`refused ${label}:${authority[2] ?? 80} bytes=0`);
    response.writeHead(403, { "Content-Type": "text/plain", Connection: "close" }).end(`plain HTTP is refused: ${label}\n`);
  });

  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    const destination = target(request.url ?? "");
    if (!destination) {
      reply(client, 400, "Bad Request", "malformed CONNECT target\n");
      return;
    }
    const label = `${destination.host}:${destination.port}`;
    if (!allowed(options.allow, destination.host) || !ports.includes(destination.port)) {
      log(`refused ${label} bytes=0`);
      reply(client, 403, "Forbidden", `host not allowed: ${destination.host}\n`);
      return;
    }
    let bytes = 0;
    const upstream = connect(destination.port, destination.host);
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
    };
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.on("data", count);
      upstream.on("data", count);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => {
      if (client.writable && bytes === 0) reply(client, 502, "Bad Gateway", `cannot reach ${destination.host}\n`);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      log(`allowed ${label} bytes=${bytes}`);
      client.destroy();
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) reply(socket, 400, "Bad Request", "malformed request\n");
    else socket.destroy();
  });

  return server;
}

function parseArguments(args: string[]): { host: string; port: number; allow: string[] } {
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    const found = index === -1 ? undefined : args[index + 1];
    if (!found) throw new Error(`usage: proxy.ts --listen <host:port> --allow <host,host,...> (missing ${flag})`);
    return found;
  };
  const listen = /^(.+):(\d{1,5})$/.exec(value("--listen"));
  if (!listen) throw new Error("--listen must be <host>:<port>");
  const allow = value("--allow").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (allow.length === 0) throw new Error("--allow needs at least one host");
  return { host: listen[1]!, port: Number(listen[2]), allow };
}

if (process.argv[1] === import.meta.filename) {
  const { host, port, allow } = parseArguments(process.argv.slice(2));
  const server = createProxy({ allow });
  server.listen(port, host, () => console.log(`listening on ${host}:${port} allow=${allow.join(",")}`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
}
