// Every auth-state store Evolution ships revives an app-state sync key with
// AppStateSyncKeyData.create(). After a JSON round trip (a restart, or any read
// back from storage) the key's bytes are a base64 STRING, because JSON.stringify
// calls the proto's toJSON before BufferJSON.replacer sees it. create() keeps the
// string; fromObject() turns it back into bytes (Baileys' own store,
// lib/Utils/use-multi-file-auth-state.js). With the string, Baileys derives the
// wrong keys and skips every app-state patch: saved contact names, labels, mutes,
// archives, all silently gone after the first restart.
//
// Each test saves a real key through the real store, opens the store AGAIN (as a
// restart does) and decodes a real encrypted contact patch with the key it reads.
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { contactPatch, decodeContactNames, freshAppStateKey } from '../helpers/app-state';

// The Prisma store keeps creds in the session table (the fake Prisma's) and, with
// Redis off, keys in files under INSTANCE_DIR (a temp dir here, not the repo).
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-auth-'));
});
vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));

const JID = '972500000001@s.whatsapp.net';
const NAME = 'Dana Levi';

type Open = () => Promise<{ keys: any }>;

/** Save a key through one opening of the store, decode a patch with what a second opening reads. */
async function saveReloadDecode(open: Open) {
  const { keyId, key } = freshAppStateKey();
  const patch = await contactPatch(keyId, key, JID, NAME);
  await (await open()).keys.set({ 'app-state-sync-key': { [keyId]: key } });
  const reopened = await open();
  const getKey = async (id: string) => (await reopened.keys.get('app-state-sync-key', [id]))[id];
  return decodeContactNames(patch, getKey);
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('an app-state sync key survives a reload in every auth store', () => {
  it('prisma store (creds in the session table, keys in local files)', async () => {
    const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
    const open = async () => (await useMultiFileAuthStatePrisma('prisma-session', null as any)).state;
    expect(await saveReloadDecode(open)).toEqual([NAME]);
  });

  it('redis-db store (over Evolution cache engine, which serialises as Redis does)', async () => {
    const { CacheService } = await import('@api/services/cache.service');
    const { LocalCache } = await import('@cache/localcache');
    const { ConfigService } = await import('@config/env.config');
    const { useMultiFileAuthStateRedisDb } = await import('@utils/use-multi-file-auth-state-redis-db');
    const configService = new ConfigService();
    // A new CacheService per opening, over the same engine, as after a restart with Redis.
    const open = async () =>
      (await useMultiFileAuthStateRedisDb('redis-session', new CacheService(new LocalCache(configService, 'auth-test'))))
        .state;
    expect(await saveReloadDecode(open)).toEqual([NAME]);
  });

  it('provider-files store (over a local file server that stores what it is sent)', async () => {
    // The file provider stores the posted `data` (a JSON string) and serves it back as JSON.
    const files = new Map<string, string>();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const path = req.url ?? '';
        if (req.method === 'POST') {
          const parsed = body ? JSON.parse(body) : {};
          if (typeof parsed.data === 'string') files.set(path, parsed.data);
          res.setHeader('content-type', 'application/json');
          return res.end('{}');
        }
        if (req.method === 'GET' && files.has(path)) {
          res.setHeader('content-type', 'application/json');
          return res.end(files.get(path));
        }
        if (req.method === 'DELETE') return files.delete(path), res.end('{}');
        res.statusCode = 404;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      Object.assign(process.env, {
        PROVIDER_ENABLED: 'true',
        PROVIDER_HOST: '127.0.0.1',
        PROVIDER_PORT: String((server.address() as AddressInfo).port),
        PROVIDER_PREFIX: 'test',
      });
      const { ConfigService } = await import('@config/env.config');
      const { ProviderFiles } = await import('@api/provider/sessions');
      const { AuthStateProvider } = await import('@utils/use-multi-file-auth-state-provider-files');
      const open = async () =>
        (await new AuthStateProvider(new ProviderFiles(new ConfigService())).authStateProvider('provider-session')).state;
      expect(await saveReloadDecode(open)).toEqual([NAME]);
      expect([...files.keys()].some((k) => k.includes('app-state-sync-key-'))).toBe(true);
    } finally {
      for (const k of ['PROVIDER_ENABLED', 'PROVIDER_HOST', 'PROVIDER_PORT', 'PROVIDER_PREFIX']) delete process.env[k];
      await new Promise((r) => server.close(r));
    }
  });
});
