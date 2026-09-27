// The pending logout of a deleted instance, against a real Postgres with
// Evolution's own migrations (test/helpers/real-postgres.ts).
//
// Every table that belongs to an instance references Instance ON DELETE
// CASCADE, Session and Proxy included. So deleting the Instance row deletes the
// credentials and the proxy a pending logout still needs to reach WhatsApp:
// after that, the reconnect cannot authenticate as the old device, and the
// device stays on the phone's Linked devices. The in-memory Prisma
// (fake-prisma.ts) has no foreign keys and cannot show this.
//
// A deleted instance whose logout is pending keeps its Instance row until the
// logout has reached WhatsApp, and stays out of the API meanwhile.
import { vi } from 'vitest';

const { socketSpy, h } = vi.hoisted(() => ({
  socketSpy: vi.fn(),
  h: {
    waMonitor: undefined as any,
    instanceController: undefined as any,
    channelController: undefined as any,
    prisma: undefined as any,
  },
}));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-logout-pg-'));
});

vi.mock('@api/server.module', async () => {
  const fake = await import('../helpers/fake-server-module');
  return {
    ...fake,
    get prismaRepository() {
      return h.prisma;
    },
    get waMonitor() {
      return h.waMonitor;
    },
    get instanceController() {
      return h.instanceController;
    },
    get channelController() {
      return h.channelController;
    },
  };
});
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Boom } from '@hapi/boom';
import EventEmitter2 from 'eventemitter2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { settle, WUID } from '../helpers/baileys-service';
import { fakeSocket } from '../helpers/connect';
import { emitted } from '../helpers/fake-server-module';
import { startInstanceApp } from '../helpers/http-app';
import { loopbackOnly } from '../helpers/local-net';
import { throwawayDatabase } from '../helpers/real-postgres';

socketSpy.mockImplementation(fakeSocket);

const TOKEN = 'instance-token';
const ID = 'inst-pg-1';
const DIR = join(tmp, ID);

type Sock = ReturnType<typeof fakeSocket>;
const built = (): Sock[] => socketSpy.mock.results.map((r) => r.value);
const current = () => built()[built().length - 1];

let guard: ReturnType<typeof loopbackOnly>;
let app: Awaited<ReturnType<typeof startInstanceApp>>;
let db: Awaited<ReturnType<typeof throwawayDatabase>>;
let globalKey: string;
const processes: any[] = [];

beforeAll(async () => {
  guard = loopbackOnly();
  db = await throwawayDatabase();
  h.prisma = db.prisma;
  app = await startInstanceApp();
  const { configService } = await import('@config/env.config');
  globalKey = configService.get<any>('AUTHENTICATION').API_KEY.KEY;
}, 60_000);
beforeEach(() => {
  socketSpy.mockClear();
  emitted.length = 0;
});
afterEach(async () => {
  for (const monitor of processes) {
    for (const s of [
      ...Object.values(monitor.waInstances),
      ...Object.values(monitor.finishingLogouts ?? {}),
    ] as any[]) {
      s.stopReconnecting?.();
      s.connectToWhatsapp = async () => undefined;
      s.connect = async () => undefined;
    }
  }
  processes.length = 0;
  await h.prisma.instance.deleteMany({});
  rmSync(DIR, { recursive: true, force: true });
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
  rmSync(tmp, { recursive: true, force: true });
  expect(guard.refused).toEqual([]);
  guard.restore();
});

/** What a process start builds (main.ts, server.module): the monitor, the controllers, then the boot load. */
async function startProcess() {
  const { ConfigService } = await import('@config/env.config');
  const { CacheService } = await import('@api/services/cache.service');
  const { LocalCache } = await import('@cache/localcache');
  const { WAMonitoringService } = await import('@api/services/monitor.service');
  const { InstanceController } = await import('@api/controllers/instance.controller');
  const { ChannelController } = await import('@api/integrations/channel/channel.controller');
  const configService = new ConfigService();
  const cache = new CacheService(new LocalCache(configService, 'instance'));
  const emitter = new EventEmitter2();
  const prisma = h.prisma;
  const waMonitor = new WAMonitoringService(emitter, configService, prisma, null as any, cache, cache, cache);
  const n = null as any;
  h.waMonitor = waMonitor;
  h.channelController = new ChannelController(prisma, waMonitor);
  h.instanceController = new InstanceController(
    waMonitor,
    configService,
    prisma,
    emitter,
    n,
    n,
    n,
    cache,
    cache,
    cache,
    n,
  );
  processes.push(waMonitor);
  await waMonitor.loadInstance();
  return waMonitor;
}

/** A linked instance, stored the way Evolution stores one: its row, its creds, a signal key file, a proxy. */
async function linkedInstance() {
  const { configService } = await import('@config/env.config');
  await h.prisma.instance.create({
    data: {
      id: ID,
      name: 'test',
      connectionStatus: 'open',
      token: TOKEN,
      integration: 'WHATSAPP-BAILEYS',
      clientName: configService.get<any>('DATABASE').CONNECTION.CLIENT_NAME,
    },
  });
  await h.prisma.proxy.create({
    data: {
      instanceId: ID,
      enabled: false,
      host: '127.0.0.1',
      port: '1',
      protocol: 'http',
      username: '',
      password: '',
    },
  });
  await h.prisma.setting.create({
    data: {
      instanceId: ID,
      rejectCall: false,
      msgCall: '',
      readMessages: false,
      groupsIgnore: false,
      alwaysOnline: false,
      readStatus: false,
      syncFullHistory: false,
    },
  });
  const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
  const auth = await useMultiFileAuthStatePrisma(ID, null as any);
  auth.state.creds.me = { id: WUID, name: 'Dana' };
  await auth.saveCreds();
  await auth.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });
}

const storedMe = async () =>
  (await h.prisma.session.findMany({ where: { sessionId: ID } })).map((r: any) => {
    let creds: any = r.creds;
    while (typeof creds === 'string') creds = JSON.parse(creds);
    return creds?.me?.id;
  });

const rows = async () => ({
  instances: await h.prisma.instance.count(),
  sessions: await h.prisma.session.count(),
  proxies: await h.prisma.proxy.count(),
  settings: await h.prisma.setting.count(),
});

/** Booted, connected, then dropped (a dead exit): the socket closed and the first reconnect (1s) is waiting. */
async function waitingToReconnect() {
  await linkedInstance();
  const monitor = await startProcess();
  await vi.waitFor(() => expect(built()).toHaveLength(1));
  const service = monitor.waInstances.test;
  await opened(current());
  // The open's webhook goes out after its database writes, which a real database can make later
  // than the close below: wait for it, so it is not read as sent while the logout is pending.
  await vi.waitFor(() =>
    expect(emitted.some((e) => e.event === 'connection.update' && e.data?.state === 'open')).toBe(true),
  );
  current().end(new Boom('Connection Terminated', { statusCode: 428 }));
  await vi.waitFor(() => expect(service.connectionStatus.state).toBe('close'), { interval: 5 });
  emitted.length = 0;
  return { monitor, service };
}

async function opened(sock: Sock) {
  sock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 20));
}

async function call(method: 'GET' | 'DELETE', route: string, key = TOKEN) {
  const res = await fetch(`${app.base}/instance/${route}/test`, { method, headers: { apikey: key } });
  return { status: res.status, body: await res.json() };
}

async function fetchInstances(key = globalKey) {
  const res = await fetch(`${app.base}/instance/fetchInstances`, { headers: { apikey: key } });
  const body = await res.json();
  return { status: res.status, names: Array.isArray(body) ? body.map((i: any) => i.name) : body };
}

async function createNamed(name: string) {
  const res = await fetch(`${app.base}/instance/create`, {
    method: 'POST',
    headers: { apikey: globalKey, 'content-type': 'application/json' },
    body: JSON.stringify({ instanceName: name, integration: 'WHATSAPP-BAILEYS' }),
  });
  return res.status;
}

async function reconnected(count: number) {
  await vi.waitFor(() => expect(built()).toHaveLength(count), { timeout: 3_000 });
  return current();
}

/** The API's view of a deleted instance whose logout is pending: only connectionState, and a taken name. */
async function hiddenFromTheApi() {
  expect({
    state: await call('GET', 'connectionState', globalKey),
    other: (await call('GET', 'connect', globalKey)).status,
    ownKey: (await call('GET', 'connectionState')).status,
    listed: await fetchInstances(),
    byOwnKey: (await fetchInstances(TOKEN)).status,
    create: await createNamed('test'),
  }).toEqual({
    state: { status: 200, body: { instance: { instanceName: 'test', state: 'close', logoutPending: true } } },
    other: 404,
    ownKey: 401,
    listed: { status: 200, names: [] },
    byOwnKey: 401,
    create: 403,
  });
}

describe('deleting an instance whose logout cannot reach WhatsApp (real Postgres)', () => {
  it('keeps the credentials and the proxy the logout needs, hidden from the API, until it is delivered', async () => {
    const { service } = await waitingToReconnect();

    expect((await call('DELETE', 'delete')).status).toBe(202);
    expect({ me: await storedMe(), proxies: (await rows()).proxies, settings: (await rows()).settings }).toEqual({
      me: [WUID],
      proxies: 1,
      settings: 0,
    });
    await hiddenFromTheApi();

    // The connection returns: the logout goes out as the linked device, then everything goes.
    const sock = await reconnected(2);
    await opened(sock);
    await settle(service);
    expect({ logouts: sock.logouts, rows: await rows(), dir: existsSync(DIR) }).toEqual({
      logouts: 1,
      rows: { instances: 0, sessions: 0, proxies: 0, settings: 0 },
      dir: false,
    });
    expect((await call('GET', 'connectionState', globalKey)).status).toBe(404);
    expect(emitted.map((e) => e.event)).toEqual([]);
  });

  it('survives a restart mid-pending: the next process logs out the linked device, then removes it', async () => {
    const { service } = await waitingToReconnect();
    expect((await call('DELETE', 'delete')).status).toBe(202);
    // The process dies before the connection returns.
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();

    const monitor = await startProcess();
    const sock = await reconnected(1);
    expect(monitor.waInstances.test).toBeUndefined();
    await hiddenFromTheApi();

    // The reconnect authenticates as the linked device, so the logout it sends is the real one.
    expect(sock.logouts).toBe(0);
    await opened(sock);
    await settle(monitor.finishingLogouts.test ?? service);
    expect({ logouts: sock.logouts, rows: await rows(), dir: existsSync(DIR) }).toEqual({
      logouts: 1,
      rows: { instances: 0, sessions: 0, proxies: 0, settings: 0 },
      dir: false,
    });
    expect(monitor.finishingLogouts.test).toBeUndefined();
    expect((await call('GET', 'connectionState', globalKey)).status).toBe(404);
  });

  it('survives a restart that lost the instances volume: the row alone keeps it pending and hidden', async () => {
    const { service } = await waitingToReconnect();
    expect((await call('DELETE', 'delete')).status).toBe(202);
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();
    rmSync(DIR, { recursive: true, force: true });

    const monitor = await startProcess();
    const sock = await reconnected(1);
    expect(monitor.waInstances.test).toBeUndefined();
    await hiddenFromTheApi();
    await opened(sock);
    await settle(monitor.finishingLogouts.test);
    expect({ logouts: sock.logouts, rows: await rows() }).toEqual({
      logouts: 1,
      rows: { instances: 0, sessions: 0, proxies: 0, settings: 0 },
    });
  });
});
