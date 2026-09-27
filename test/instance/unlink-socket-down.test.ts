// Unlinking an instance (DELETE /instance/logout, DELETE /instance/delete) whose
// socket is down. Baileys' logout first sends
// remove-companion-device, and sendRawMessage throws Boom('Connection Closed',
// 428) when the ws is not open (rc14 lib/Socket/socket.js, sendRawMessage),
// before logout ends the socket. 2.3.7's logoutInstance awaits it unguarded, so
// nothing after it runs: the credentials stay stored, the row still says open,
// the socket stays up, and delete answers 400 with the instance still in memory.
// Evolution then connects with the kept credentials (the socket in flight, or the
// boot auto-connect of a row that says open) and keeps receiving the person's
// messages after they unlinked.
//
// Wiping the credentials locally instead (what this file first required) is no
// better: without them the device can never tell WhatsApp to remove it, so it
// stays on the person's Linked devices. So the logout is kept pending until the
// connection returns (test/instance/logout-pending.test.ts has the delivery):
// the credentials stay, a marker says it is pending, and the answer says so.
//
// The instance here is mid-reconnect, the way it is after a dropped connection:
// Evolution's real connect builds a real Baileys socket, pointed at a local
// "WhatsApp" that accepts the TCP connection and never answers the WebSocket
// upgrade, so the socket stays CONNECTING. The session is a linked one (creds
// with `me` in the session table, signal keys in files under INSTANCE_DIR),
// written through Evolution's own Prisma auth store.
import { vi } from 'vitest';

const h = vi.hoisted(() => ({ wsUrl: '', sockets: [] as any[], services: [] as any[], waMonitor: undefined as any, instanceController: undefined as any }));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-unlink-'));
});

vi.mock('@api/server.module', async () => {
  const fake = await import('../helpers/fake-server-module');
  // The router, the guards and the controller reach the monitor and the controller through the server module.
  return {
    ...fake,
    get waMonitor() {
      return h.waMonitor;
    },
    get instanceController() {
      return h.instanceController;
    },
  };
});
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));
// The real socket, sent to the local "WhatsApp" instead of web.whatsapp.com. Every socket built is kept, so a reconnect shows.
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  const make = (config: any) => {
    const socket = orig.makeWASocket({ ...config, waWebSocketUrl: h.wsUrl });
    h.sockets.push(socket);
    return socket;
  };
  return { ...orig, default: make, makeWASocket: make };
});

import { existsSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import EventEmitter2 from 'eventemitter2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeService, settle, WUID } from '../helpers/baileys-service';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startInstanceApp } from '../helpers/http-app';
import { loopbackOnly } from '../helpers/local-net';

const TOKEN = 'instance-token';

/** Accepts connections and never answers, so a WebSocket to it stays CONNECTING. */
function silentWhatsapp() {
  const open = new Set<net.Socket>();
  const server = net.createServer((s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => undefined);
  });
  return {
    drop: () => open.forEach((s) => s.destroy()),
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    close: () => new Promise<void>((r) => (open.forEach((s) => s.destroy()), server.close(() => r()))),
  };
}

let guard: ReturnType<typeof loopbackOnly>;
let whatsapp: ReturnType<typeof silentWhatsapp>;
let app: Awaited<ReturnType<typeof startInstanceApp>>;

beforeAll(async () => {
  guard = loopbackOnly();
  whatsapp = silentWhatsapp();
  h.wsUrl = `ws://127.0.0.1:${await whatsapp.listen()}/ws/chat`;
  app = await startInstanceApp();
});
afterEach(async () => {
  // Tear down without the service answering the close with a reconnect.
  for (const service of h.services) {
    service.connectToWhatsapp = async () => undefined;
    service.connect = async () => undefined;
  }
  for (const s of h.sockets) await s.end(undefined).catch(() => undefined);
  for (const service of h.services) await settle(service);
  for (const service of h.services) service.stopReconnecting();
  whatsapp.drop();
  h.sockets.length = 0;
  h.services.length = 0;
  for (const t of Object.values(prisma) as any[]) if (Array.isArray(t?.rows)) t.rows.length = 0;
  rmSync(join(tmp, 'inst-1'), { recursive: true, force: true });
});
afterAll(async () => {
  await app.close();
  await whatsapp.close();
  rmSync(tmp, { recursive: true, force: true });
  expect(guard.refused).toEqual([]);
  guard.restore();
});

/** A linked instance whose connection dropped: its row says open, and it is reconnecting on a socket that has not opened. */
async function reconnectingInstance() {
  await prisma.instance.create({
    data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' },
  });
  const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
  const auth = await useMultiFileAuthStatePrisma('inst-1', null as any);
  auth.state.creds.me = { id: WUID, name: 'Dana' };
  await auth.saveCreds();
  await auth.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });

  const { ConfigService } = await import('@config/env.config');
  const { CacheService } = await import('@api/services/cache.service');
  const { LocalCache } = await import('@cache/localcache');
  const { WAMonitoringService } = await import('@api/services/monitor.service');
  const { InstanceController } = await import('@api/controllers/instance.controller');
  const configService = new ConfigService();
  const cache = new CacheService(new LocalCache(configService, 'instance'));
  const emitter = new EventEmitter2();
  const waMonitor = new WAMonitoringService(emitter, configService, prisma, null as any, cache, cache, cache);
  const n = null as any;
  h.waMonitor = waMonitor;
  h.instanceController = new InstanceController(waMonitor, configService, prisma, emitter, n, n, n, cache, cache, cache, n);

  const { service } = await makeService({ prisma, eventEmitter: emitter });
  h.services.push(service);
  waMonitor.waInstances.test = service;
  await service.connectToWhatsapp();
  await vi.waitFor(() => expect(service.connectionStatus.state).toBe('connecting'));
  // The premise: a linked session is stored, and its one socket is dialling WhatsApp, not open.
  expect(JSON.parse(JSON.parse(prisma.session.rows[0].creds)).me.id).toBe(WUID);
  expect(readdirSync(join(tmp, 'inst-1'))).toEqual(['pre-key-1.json']);
  expect(h.sockets.map((s) => s.ws.isConnecting)).toEqual([true]);
  return { service, waMonitor };
}

async function call(route: 'logout' | 'delete') {
  const res = await fetch(`${app.base}/instance/${route}/test`, { method: 'DELETE', headers: { apikey: TOKEN } });
  return { status: res.status, body: await res.json() };
}

/** Nothing of the session is left, and nothing is connected or connecting to WhatsApp with it: its one socket is closed, and no other was built. */
async function expectUnlinked(service: any) {
  await settle(service);
  expect(prisma.session.rows).toEqual([]);
  expect(existsSync(join(tmp, 'inst-1'))).toBe(false);
  expect(h.sockets.map((s) => s.ws.isClosed)).toEqual([true]);
}

/** The logout is pending: the session is kept, marked pending, and its socket is still dialling to deliver it. */
async function expectPending() {
  expect(JSON.parse(JSON.parse(prisma.session.rows[0].creds)).me.id).toBe(WUID);
  expect(readdirSync(join(tmp, 'inst-1')).sort()).toEqual(['logout-pending.json', 'pre-key-1.json']);
  expect(h.sockets.map((s) => s.ws.isConnecting)).toEqual([true]);
}

describe('unlinking an instance whose connection is down', () => {
  it('logout keeps the session and answers that the logout is pending', async () => {
    const { service } = await reconnectingInstance();

    expect(await call('logout')).toEqual({
      status: 202,
      body: {
        status: 'PENDING',
        error: false,
        response: { message: 'Logout pending: WhatsApp will be told when the connection returns' },
      },
    });

    await settle(service);
    await expectPending();
  });

  it('delete removes the instance from the API and keeps the session for the logout', async () => {
    const { service, waMonitor } = await reconnectingInstance();

    expect(await call('delete')).toEqual({
      status: 202,
      body: {
        status: 'PENDING',
        error: false,
        response: { message: 'Instance deleted; its logout will reach WhatsApp when the connection returns' },
      },
    });

    await settle(service);
    await expectPending();
    expect(waMonitor.waInstances.test).toBeUndefined();
    // Its row stays until the logout is delivered: deleting it would cascade to the session.
    expect(prisma.instance.rows.map((r: any) => r.name)).toEqual(['test']);
  });

  it('delete removes the instance even when its logout fails for another reason', async () => {
    const { service, waMonitor } = await reconnectingInstance();
    const findFirst = prisma.session.findFirst;
    prisma.session.findFirst = async () => {
      prisma.session.findFirst = findFirst;
      throw new Error("Can't reach database server");
    };

    expect(await call('delete')).toEqual({
      status: 200,
      body: { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } },
    });

    await expectUnlinked(service);
    expect(waMonitor.waInstances.test).toBeUndefined();
    expect(prisma.instance.rows).toEqual([]);
  });
});
