// Every connect starts by asking WhatsApp Web for its current version
// (fetchLatestWaWebVersion: web.whatsapp.com/sw.js, falling back to Baileys'
// version file on GitHub). On an instance with a proxy that request must leave
// through the proxy too, or every account's connect is announced from the
// server's own IP. The proxy here maps those two hosts to local HTTPS servers.
import { vi } from 'vitest';

const { socketSpy, baileysVersion } = vi.hoisted(() => ({ socketSpy: vi.fn(), baileysVersion: { value: undefined } }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  baileysVersion.value = orig.DEFAULT_CONNECTION_CONFIG.version;
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});

import net from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connectBehind, fakeSocket, type ProxyProtocol } from '../helpers/connect';
import {
  type Listening,
  loopbackOnly,
  startHttpProxy,
  startHttpsServer,
  startSocks5Proxy,
  trustTestCertificate,
} from '../helpers/local-net';

socketSpy.mockImplementation(fakeSocket);

const BAILEYS_DEFAULTS = '/WhiskeySockets/Baileys/master/src/Defaults/index.ts';

let guard: ReturnType<typeof loopbackOnly>;
let untrust: () => void;
let web: Listening;
let github: Listening;
let swHasRevision = true;
const proxies: Listening[] = [];

beforeAll(async () => {
  guard = loopbackOnly();
  untrust = trustTestCertificate();
  web = await startHttpsServer((req, _body, res) => {
    if (req.url !== '/sw.js') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(swHasRevision ? 'self.__swData=JSON.parse("{\\"client_revision\\":1027654321}");' : 'self.__swData={};');
  });
  github = await startHttpsServer((req, _body, res) => {
    if (req.url !== BAILEYS_DEFAULTS) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(['// 1', '// 2', '// 3', '// 4', '// 5', '// 6', 'const version = [2, 3000, 1011111111]', ''].join('\n'));
  });
});

afterAll(async () => {
  await web.close();
  await github.close();
  untrust();
  guard.restore();
});

beforeEach(() => {
  swHasRevision = true;
  guard.refused.splice(0);
  web.log.splice(0);
  github.log.splice(0);
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
});

async function proxyFor(protocol: ProxyProtocol) {
  const remap = {
    'web.whatsapp.com:443': `127.0.0.1:${web.port}`,
    'raw.githubusercontent.com:443': `127.0.0.1:${github.port}`,
  };
  const proxy = protocol === 'http' ? await startHttpProxy({ remap }) : await startSocks5Proxy({ remap });
  proxies.push(proxy);
  return proxy;
}

const via = (protocol: ProxyProtocol, host: string) => (protocol === 'http' ? `CONNECT ${host}:443` : `SOCKS5 ${host}:443`);

describe('the WhatsApp Web version fetch on connect', () => {
  for (const protocol of ['http', 'socks5'] as ProxyProtocol[]) {
    it(`leaves through a ${protocol} proxy`, async () => {
      const proxy = await proxyFor(protocol);
      const { config } = await connectBehind(socketSpy, { protocol, port: proxy.port });
      expect(guard.refused).toEqual([]);
      expect(proxy.log).toEqual([via(protocol, 'web.whatsapp.com')]);
      expect(web.log).toEqual(['GET /sw.js']);
      expect(config.version).toEqual([2, 3000, 1027654321]);
    });
  }

  it('falls back to Baileys version file through the proxy too', async () => {
    swHasRevision = false;
    const proxy = await proxyFor('http');
    const { config } = await connectBehind(socketSpy, { protocol: 'http', port: proxy.port });
    expect(guard.refused).toEqual([]);
    expect(proxy.log).toEqual([via('http', 'web.whatsapp.com'), via('http', 'raw.githubusercontent.com')]);
    expect(github.log).toEqual([`GET ${BAILEYS_DEFAULTS}`]);
    expect(config.version).toEqual([2, 3000, 1011111111]);
  });
});

/** An exit that has died: it accepts the TCP connection and never answers. Logs one line per connection. */
async function startDeadExit(): Promise<Listening> {
  const log: string[] = [];
  const held = new Set<net.Socket>();
  const server = net.createServer((s) => {
    log.push('connection');
    held.add(s);
    s.on('error', () => undefined);
    s.on('close', () => held.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    log,
    close: () =>
      new Promise<void>((r) => {
        held.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}

// Kept last in the file: before the fix the connect it starts never finishes.
describe('when the exit never answers', () => {
  it('gives up on the version fetch after 10s and connects with the version Baileys ships', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const dead = await startDeadExit();
    proxies.push(dead);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const connecting = connectBehind(socketSpy, { protocol: 'http', port: dead.port });
      let settled = false;
      connecting.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Not vi.waitFor: under fake timers it advances the clock while it polls.
      for (let i = 0; i < 200 && dead.log.length === 0; i++) await new Promise((r) => realSetTimeout(r, 10));
      expect(dead.log).toEqual(['connection']);
      await vi.advanceTimersByTimeAsync(9_999);
      const early = settled ? 'connected' : 'waiting';
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await Promise.race([
        connecting.then(({ config }) => config.version),
        new Promise((r) => realSetTimeout(() => r('still waiting on the version fetch'), 2_000)),
      ]);
      expect({ early, outcome }).toEqual({ early: 'waiting', outcome: baileysVersion.value });
      expect(guard.refused).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
