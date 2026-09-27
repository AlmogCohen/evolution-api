// A media CDN and the two kinds of proxy Evolution supports (HTTP CONNECT and
// SOCKS5), all on 127.0.0.1. Each proxy records every connection it relays and
// refuses any target that is not 127.0.0.1 (or one it was told to remap to a
// local server), so nothing a test does can leave the machine through it.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export type Listening = { port: number; log: string[]; close: () => Promise<void> };

const LOCAL = '127.0.0.1';

function track(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => resolve());
    });
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, LOCAL, resolve));
  return (server.address() as net.AddressInfo).port;
}

/** Serves `files` (path -> bytes) and logs `METHOD path` for every request. */
/** Serves `files` by path; a number instead of a body answers that status. Anything else is 404. */
export async function startCdn(files: Record<string, Buffer | number>): Promise<Listening> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const body = files[req.url ?? ''];
    if (!body) return void res.writeHead(404).end();
    if (typeof body === 'number') return void res.writeHead(body).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body);
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}

function pipeTo(client: net.Socket, host: string, port: number, onOpen: () => void) {
  const upstream = net.connect(port, host, () => {
    onOpen();
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
}

/** `host:port` the client asked for -> the 127.0.0.1 `host:port` to connect instead, or undefined to refuse. */
type Remap = Record<string, string>;
function resolveTarget(target: string, remap: Remap = {}): [string, number] | undefined {
  const to = remap[target] ?? target;
  const i = to.lastIndexOf(':');
  const host = to.slice(0, i);
  return host === LOCAL ? [host, Number(to.slice(i + 1))] : undefined;
}

/** An HTTP proxy: CONNECT tunnels, and absolute-URI forwarding. Logs `CONNECT host:port` / `GET url`. */
export async function startHttpProxy(opts: { remap?: Remap } = {}): Promise<Listening> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const target = new URL(req.url ?? '');
    if (target.hostname !== LOCAL) return void res.writeHead(403).end();
    const upstream = http.request(
      { host: LOCAL, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    log.push(`CONNECT ${req.url}`);
    const target = resolveTarget(req.url ?? '', opts.remap);
    if (!target) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    pipeTo(client, target[0], target[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) client.unshift(head);
    });
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}

/** A SOCKS5 proxy, no authentication, CONNECT only. Logs `SOCKS5 host:port`. */
export async function startSocks5Proxy(opts: { remap?: Remap } = {}): Promise<Listening> {
  const log: string[] = [];
  const server = net.createServer((client) => {
    client.once('data', (greeting) => {
      if (greeting[0] !== 5) return void client.destroy();
      client.write(Buffer.from([5, 0]));
      client.once('data', (req) => {
        let host: string;
        let offset: number;
        if (req[3] === 1) {
          host = [...req.subarray(4, 8)].join('.');
          offset = 8;
        } else if (req[3] === 3) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          offset = 5 + len;
        } else return void client.destroy();
        const port = req.readUInt16BE(offset);
        log.push(`SOCKS5 ${host}:${port}`);
        const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
        const target = resolveTarget(`${host}:${port}`, opts.remap);
        if (req[1] !== 1 || !target) return void client.end(reply(2));
        pipeTo(client, target[0], target[1], () => client.write(reply(0)));
      });
    });
    client.on('error', () => client.destroy());
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}

const TLS_DIR = new URL('../fixtures/tls/', import.meta.url);
/** A self-signed test certificate for 127.0.0.1, web.whatsapp.com and raw.githubusercontent.com. */
export const testTls = {
  key: readFileSync(new URL('local.key', TLS_DIR)),
  cert: readFileSync(new URL('local.crt', TLS_DIR)),
};

/** Trust the test certificate process-wide (added to the default CAs, verification stays on). Returns undo. */
export function trustTestCertificate() {
  const before = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...before, testTls.cert.toString()]);
  return () => tls.setDefaultCACertificates(before);
}

/** An HTTPS server on 127.0.0.1 with the test certificate. Logs `METHOD path` for every request. */
export async function startHttpsServer(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
): Promise<Listening> {
  const log: string[] = [];
  const server = https.createServer(testTls, (req, res) => {
    log.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks), res));
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}

/**
 * Refuse every socket connection that is not to the loopback address, in this
 * process, whatever library opens it (http, https, axios, undici, ws). The
 * refused `host:port`s are recorded, so a test can say what tried to leave.
 * Returns undo.
 */
export function loopbackOnly() {
  const refused: string[] = [];
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] };
    const host = opts.path ? LOCAL : (opts.host ?? 'localhost');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      refused.push(`${host}:${opts.port}`);
      process.nextTick(() => this.destroy(new Error(`test: refused a connection to ${host}:${opts.port}`)));
      return this;
    }
    return original.apply(this, args as any);
  } as any;
  return { refused, restore: () => void (net.Socket.prototype.connect = original) };
}
