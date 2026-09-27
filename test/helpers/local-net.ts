// A media CDN and the two kinds of proxy Evolution supports (HTTP CONNECT and
// SOCKS5), all on 127.0.0.1. Each proxy records every connection it relays and
// refuses any target that is not 127.0.0.1, so nothing a test does can leave
// the machine through it.
import http from 'node:http';
import net from 'node:net';

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
export async function startCdn(files: Record<string, Buffer>): Promise<Listening> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const body = files[req.url ?? ''];
    if (!body) return void res.writeHead(404).end();
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

/** An HTTP proxy: CONNECT tunnels, and absolute-URI forwarding. Logs `CONNECT host:port` / `GET url`. */
export async function startHttpProxy(): Promise<Listening> {
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
    const [host, port] = (req.url ?? '').split(':');
    if (host !== LOCAL) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    pipeTo(client, host, Number(port), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) client.unshift(head);
    });
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}

/** A SOCKS5 proxy, no authentication, CONNECT only. Logs `SOCKS5 host:port`. */
export async function startSocks5Proxy(): Promise<Listening> {
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
        if (req[1] !== 1 || host !== LOCAL) return void client.end(reply(2));
        pipeTo(client, host, port, () => client.write(reply(0)));
      });
    });
    client.on('error', () => client.destroy());
  });
  const close = track(server);
  return { port: await listen(server), log, close };
}
