// Sending media: Baileys uploads the encrypted file to a WhatsApp media host
// with the socket config Evolution built. On an instance with a proxy the upload
// must work, and must leave through that proxy like the rest of the account.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
// Pinned here: this file is about uploads (the version fetch has its own test).
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONNECTION_CONFIG, getWAUploadToServer } from 'baileys';
import P from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

const ENCRYPTED = Buffer.from('an encrypted photo, as Baileys uploads it '.repeat(300));
const SHA_B64 = createHash('sha256').update(ENCRYPTED).digest('base64');

let guard: ReturnType<typeof loopbackOnly>;
let untrust: () => void;
let mediaHost: Listening;
let received: Buffer[];
let dir: string;
let filePath: string;
const proxies: Listening[] = [];

beforeAll(async () => {
  guard = loopbackOnly();
  untrust = trustTestCertificate();
  mediaHost = await startHttpsServer((req, body, res) => {
    received.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: `https://127.0.0.1:${mediaHost.port}/m/1`, direct_path: '/m/1' }));
  });
  dir = await mkdtemp(join(tmpdir(), 'evo-upload-'));
  filePath = join(dir, 'image-enc');
  await writeFile(filePath, ENCRYPTED);
});

afterAll(async () => {
  await mediaHost.close();
  await rm(dir, { recursive: true, force: true });
  untrust();
  guard.restore();
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
});

// Baileys logs each host's failure at warn and throws only "failed on all hosts"; keep the cause.
const warnings: string[] = [];
const logger = Object.assign(P({ level: 'silent' }), {
  warn: (obj: any, msg?: string) => void warnings.push(`${msg}: ${String(obj?.trace ?? '').split('\n')[0]}`),
});

/** Baileys' own upload, built from the socket config the way makeWASocket builds it. */
function uploaderFor(config: any) {
  const merged = { ...DEFAULT_CONNECTION_CONFIG, ...config, logger };
  return getWAUploadToServer(merged, async () => ({
    hosts: [{ hostname: `127.0.0.1:${mediaHost.port}`, maxContentLengthBytes: 1e9 }],
    auth: 'test-auth',
    ttl: 3600,
    fetchDate: new Date(),
  }));
}

async function upload(config: any) {
  received = [];
  mediaHost.log.splice(0);
  warnings.splice(0);
  return uploaderFor(config)(filePath, { mediaType: 'image', fileEncSha256B64: SHA_B64, timeoutMs: 10_000 }).catch(
    (error) => {
      throw new Error(`${error.message}. ${warnings.join(' | ')}`);
    },
  );
}

describe('media uploads on an instance with a proxy', () => {
  it('control: with no proxy, the upload reaches the media host directly', async () => {
    const { config } = await connectBehind(socketSpy);
    const result = await upload(config);
    expect(result).toEqual({ mediaUrl: `https://127.0.0.1:${mediaHost.port}/m/1`, directPath: '/m/1', meta_hmac: undefined, fbid: undefined, ts: undefined });
    expect(Buffer.concat(received).equals(ENCRYPTED)).toBe(true);
  });

  for (const protocol of ['http', 'socks5'] as ProxyProtocol[]) {
    it(`works, and leaves through a ${protocol} proxy`, async () => {
      const proxy = protocol === 'http' ? await startHttpProxy() : await startSocks5Proxy();
      proxies.push(proxy);
      const { config } = await connectBehind(socketSpy, { protocol, port: proxy.port });
      const result = await upload(config);
      expect(result).toEqual({ mediaUrl: `https://127.0.0.1:${mediaHost.port}/m/1`, directPath: '/m/1', meta_hmac: undefined, fbid: undefined, ts: undefined });
      expect(Buffer.concat(received).equals(ENCRYPTED)).toBe(true);
      expect(mediaHost.log).toHaveLength(1);
      expect(proxy.log).toEqual([protocol === 'http' ? `CONNECT 127.0.0.1:${mediaHost.port}` : `SOCKS5 127.0.0.1:${mediaHost.port}`]);
    });
  }

  it('nothing tried to leave 127.0.0.1', () => {
    expect(guard.refused).toEqual([]);
  });
});
