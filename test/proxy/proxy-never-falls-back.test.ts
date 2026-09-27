// An instance with a proxy must never reach WhatsApp from the server's own address, not for a
// moment. Three ways it still could:
// - loadProxy (every connect) switched the proxy off, then read the Proxy row: a media download
//   in that window (a reconnect while messages arrive) went out directly, and a failed read left
//   the proxy off for good.
// - A proxyscrape list that could not be fetched switched the proxy off, and the socket connected
//   directly.
// - A media download for a proxyscrape proxy with no socket exit to share went out directly.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';

import { encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';
import { type Listening, loopbackOnly, startCdn, startHttpProxy } from '../helpers/local-net';

socketSpy.mockImplementation(fakeSocket);

const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const PATH = '/v/t62.7118-24/media.enc';

let cdn: Listening;
let proxy: Listening;
let mediaKey: Uint8Array;
let netGuard: ReturnType<typeof loopbackOnly>;
const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

// A proxyscrape-style list server that is down: every request answers 503.
let listServer: http.Server;
let listUrl: string;

beforeAll(async () => {
  netGuard = loopbackOnly();
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(PLAIN, 'image', {});
  mediaKey = enc.mediaKey;
  const body = await readFile(enc.encFilePath);
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({ [PATH]: body });
  proxy = await startHttpProxy();
  listServer = http.createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((r) => listServer.listen(0, '127.0.0.1', r));
  listUrl = `http://127.0.0.1:${(listServer.address() as AddressInfo).port}/proxyscrape/v2/list`;
});

afterAll(async () => {
  await cdn.close();
  await proxy.close();
  await new Promise((r) => listServer.close(r));
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
  expect(netGuard.refused).toEqual([]);
  netGuard.restore();
});

beforeEach(() => {
  cdn.log.splice(0);
  proxy.log.splice(0);
  socketSpy.mockClear();
});
afterEach(() => vi.restoreAllMocks());

const imageMessage = () => ({
  key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: '3EB0BBBBBBBBBBBBBBBB' },
  message: {
    imageMessage: {
      url: `http://127.0.0.1:${cdn.port}${PATH}`,
      mediaKey,
      mimetype: 'image/jpeg',
      fileLength: PLAIN.length,
    },
  },
  messageTimestamp: 1_700_000_000,
});

async function serviceBehind(host = '127.0.0.1', port = String(proxy.port)) {
  const made = await makeService();
  await made.service.setProxy({ enabled: true, host, port, protocol: 'http', username: '', password: '' });
  await made.service.loadProxy();
  return made;
}

/** A download, and where it went: through the proxy, directly, or nowhere (it failed). */
async function download(service: any) {
  const result = await service
    .getBase64FromMediaMessage({ message: imageMessage() })
    .then(() => 'ok')
    .catch(() => 'failed');
  return { result, viaProxy: proxy.log.length > 0, reachedCdn: cdn.log.length > 0 };
}

describe('a proxied instance never leaves from the server address', () => {
  it('a media download while the proxy is being reloaded still goes through it', async () => {
    const { service, prisma } = await serviceBehind();
    let release: () => void;
    const held = new Promise<void>((r) => (release = r));
    const read = prisma.proxy.findUnique;
    prisma.proxy.findUnique = async (args: any) => {
      await held;
      return read(args);
    };
    const reload = service.loadProxy();
    const during = await download(service);
    release();
    await reload;
    expect(during).toEqual({ result: 'ok', viaProxy: true, reachedCdn: true });
  });

  it('a proxy row that cannot be read leaves the proxy in force', async () => {
    const { service, prisma } = await serviceBehind();
    prisma.proxy.findUnique = async () => {
      throw new Error("Can't reach database server");
    };
    await service.loadProxy().catch(() => undefined);
    expect(await download(service)).toEqual({ result: 'ok', viaProxy: true, reachedCdn: true });
  });

  it('a proxyscrape list that cannot be fetched fails the connect instead of connecting directly', async () => {
    const { service } = await serviceBehind(listUrl, '80');
    stubAuthState(service);
    const outcome = await service.connectToWhatsapp().then(
      () => 'connected',
      () => 'failed',
    );
    const direct = socketSpy.mock.calls.filter(([config]) => !config?.agent).length;
    expect({ outcome, direct }).toEqual({ outcome: 'failed', direct: 0 });
  });

  it('a media download for a proxyscrape proxy with no exit to share fails instead of going directly', async () => {
    const { service } = await serviceBehind(listUrl, '80');
    expect(await download(service)).toEqual({ result: 'failed', viaProxy: false, reachedCdn: false });
  });
});
