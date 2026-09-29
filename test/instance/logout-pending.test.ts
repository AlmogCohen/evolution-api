// A logout must reach WhatsApp. Baileys' logout sends remove-companion-device,
// which is what takes the device off the person's Linked devices; it can only
// be sent on an open socket, with the session's credentials. When the socket is
// down or a reconnect is waiting, wiping the credentials locally (as the fork
// did) means the device can never be removed and stays on the phone.
//
// So a logout that cannot reach WhatsApp is kept pending: the credentials stay,
// a marker in the instance's directory says so (it survives a restart), the
// instance forwards and stores nothing, and it reconnects only to deliver the
// logout. When the connection opens it sends the logout at once; the session
// is wiped once the socket ends with loggedOut. If WhatsApp answers loggedOut
// on the reconnect (the device was already removed), that also finishes it.
//
// Everything runs through the real /instance router and guards, the real
// InstanceController, WAMonitoringService and ChannelController, and
// Evolution's own Prisma auth store (creds in the session table, keys in files
// under INSTANCE_DIR). The socket is the fake one (test/helpers/connect.ts),
// whose logout behaves as Baileys' does.
import { vi } from 'vitest';

const { socketSpy, h } = vi.hoisted(() => ({
  socketSpy: vi.fn(),
  h: { waMonitor: undefined as any, instanceController: undefined as any, channelController: undefined as any },
}));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-logout-'));
});

vi.mock('@api/server.module', async () => {
  const fake = await import('../helpers/fake-server-module');
  return {
    ...fake,
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

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Boom } from '@hapi/boom';
import { proto } from 'baileys';
import EventEmitter2 from 'eventemitter2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { settle, WUID } from '../helpers/baileys-service';
import { fakeSocket } from '../helpers/connect';
import { emitted, prismaRepository as prisma } from '../helpers/fake-server-module';
import { startInstanceApp } from '../helpers/http-app';
import { loopbackOnly } from '../helpers/local-net';

socketSpy.mockImplementation(fakeSocket);

const TOKEN = 'instance-token';
const DIR = join(tmp, 'inst-1');
const MARKER = join(DIR, 'logout-pending.json');
const PENDING = {
  status: 202,
  body: {
    status: 'PENDING',
    error: false,
    response: { message: 'Logout pending: WhatsApp will be told when the connection returns' },
  },
};

type Sock = ReturnType<typeof fakeSocket>;
const built = (): Sock[] => socketSpy.mock.results.map((r) => r.value);
const current = () => built()[built().length - 1];

let guard: ReturnType<typeof loopbackOnly>;
let app: Awaited<ReturnType<typeof startInstanceApp>>;
let globalKey: string;
const processes: any[] = [];

beforeAll(async () => {
  guard = loopbackOnly();
  app = await startInstanceApp();
  const { configService } = await import('@config/env.config');
  globalKey = configService.get<any>('AUTHENTICATION').API_KEY.KEY;
});
beforeEach(() => {
  socketSpy.mockClear();
  emitted.length = 0;
});
afterEach(async () => {
  // Stop every process's instances without them answering with a reconnect.
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
  for (const t of Object.values(prisma) as any[]) if (Array.isArray(t?.rows)) t.rows.length = 0;
  rmSync(DIR, { recursive: true, force: true });
});
afterAll(async () => {
  await app.close();
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
  await prisma.instance.create({
    data: {
      id: 'inst-1',
      name: 'test',
      connectionStatus: 'open',
      token: TOKEN,
      integration: 'WHATSAPP-BAILEYS',
      clientName: configService.get<any>('DATABASE').CONNECTION.CLIENT_NAME,
    },
  });
  await prisma.proxy.create({
    data: {
      instanceId: 'inst-1',
      enabled: false,
      host: '127.0.0.1',
      port: '1',
      protocol: 'http',
      username: '',
      password: '',
    },
  });
  await prisma.setting.create({ data: { instanceId: 'inst-1', rejectCall: false, msgCall: '', readMessages: false } });
  const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
  const auth = await useMultiFileAuthStatePrisma('inst-1', null as any);
  auth.state.creds.me = { id: WUID, name: 'Dana' };
  await auth.saveCreds();
  await auth.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });
}

const storedMe = () => prisma.session.rows.map((r: any) => JSON.parse(JSON.parse(r.creds)).me?.id);

/** Booted, connected, then dropped (a dead exit): the socket closed and the first reconnect (1s) is waiting. */
async function waitingToReconnect() {
  await linkedInstance();
  const monitor = await startProcess();
  await vi.waitFor(() => expect(built()).toHaveLength(1));
  const service = monitor.waInstances.test;
  await opened(current());
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

/** Wait for the reconnect the pending logout makes, and return its socket. */
async function reconnected(count: number) {
  await vi.waitFor(() => expect(built()).toHaveLength(count), { timeout: 3_000 });
  return current();
}

/** A live message and a history batch arriving on a pending instance, the way Baileys emits them (buffered). */
async function deliverWhilePending(sock: Sock, service: any) {
  const message = {
    key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: 'M1' },
    messageTimestamp: 1_790_000_000,
    pushName: 'Noa',
    message: { conversation: 'hello' },
  };
  sock.ev.buffer();
  sock.ev.emit('messages.upsert', { messages: [message], type: 'notify' });
  sock.ev.emit('messaging-history.set', {
    chats: [{ id: '972500000002@s.whatsapp.net', name: 'Tal' }],
    contacts: [{ id: '972500000002@s.whatsapp.net', name: 'Tal' }],
    messages: [{ ...message, key: { ...message.key, id: 'H1' } }],
    lidPnMappings: [{ lid: '111@lid', pn: '972500000002@s.whatsapp.net' }],
    syncType: proto.HistorySync.HistorySyncType.RECENT,
    isLatest: true,
  });
  await sock.ev.flush();
  await settle(service);
}

const stored = () => ({
  messages: prisma.message.rows.length,
  chats: prisma.chat.rows.length,
  contacts: prisma.contact.rows.length,
});

describe('a logout that cannot reach WhatsApp', () => {
  it('is kept pending, forwards nothing, and is delivered once when the connection returns', async () => {
    const { service } = await waitingToReconnect();

    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    // The credentials the logout needs are kept, and the marker says it is pending.
    expect(storedMe()).toEqual([WUID]);
    expect(readdirSync(DIR).sort()).toEqual(['logout-pending.json', 'pre-key-1.json']);
    expect(JSON.parse(readFileSync(MARKER, 'utf8'))).toMatchObject({ instanceName: 'test', deleted: false });
    expect(await call('GET', 'connectionState')).toEqual({
      status: 200,
      body: { instance: { instanceName: 'test', state: 'close', logoutPending: true } },
    });

    // /instance/connect (polled by a consumer) answers the same and starts nothing.
    expect(await call('GET', 'connect')).toEqual({
      status: 200,
      body: { instance: { instanceName: 'test', state: 'close', logoutPending: true } },
    });

    // It reconnects only to deliver the logout, and forwards and stores nothing meanwhile.
    const sock = await reconnected(2);
    await deliverWhilePending(sock, service);
    expect({ emitted: emitted.map((e) => e.event), stored: stored() }).toEqual({
      emitted: [],
      stored: { messages: 0, chats: 0, contacts: 0 },
    });

    // The connection returns: the logout goes out at once, exactly once, and then the session is wiped.
    await opened(sock);
    await settle(service);
    expect(sock.logouts).toBe(1);
    expect({
      me: storedMe(),
      dir: existsSync(DIR),
      row: prisma.instance.rows.map((r: any) => r.connectionStatus),
    }).toEqual({ me: [], dir: false, row: ['close'] });
    expect(await call('GET', 'connectionState')).toEqual({
      status: 200,
      body: { instance: { instanceName: 'test', state: 'close' } },
    });
    // Nothing reconnects afterwards.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(built()).toHaveLength(2);
  });

  it('is resumed after a restart', async () => {
    const { service } = await waitingToReconnect();
    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    // The process dies before the connection returns.
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();

    const monitor = await startProcess();
    const sock = await reconnected(1);
    const resumed = monitor.waInstances.test;
    await deliverWhilePending(sock, resumed);
    expect({ emitted: emitted.map((e) => e.event), stored: stored() }).toEqual({
      emitted: [],
      stored: { messages: 0, chats: 0, contacts: 0 },
    });

    await opened(sock);
    await settle(resumed);
    expect({ logouts: sock.logouts, me: storedMe(), dir: existsSync(DIR) }).toEqual({ logouts: 1, me: [], dir: false });
  });

  // The marker lives with the key files (INSTANCE_DIR); the row and the creds are in the database.
  // A 202 promised the logout will be delivered: losing the instances volume must not undo that. The
  // boot used to load the instance as a normal one (not connected), and /instance/connect then
  // opened a normal session on the linked creds.
  it('survives the loss of the instances volume: after a restart it is still pending, and delivered', async () => {
    const { service } = await waitingToReconnect();
    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();
    rmSync(DIR, { recursive: true, force: true });

    const monitor = await startProcess();
    await vi.waitFor(() => expect(monitor.waInstances.test).toBeDefined());
    const pending = { status: 200, body: { instance: { instanceName: 'test', state: 'close', logoutPending: true } } };
    expect({ state: await call('GET', 'connectionState'), connect: await call('GET', 'connect') }).toEqual({
      state: pending,
      connect: pending,
    });

    const sock = await reconnected(1);
    await deliverWhilePending(sock, monitor.waInstances.test);
    expect(emitted.map((e) => e.event)).toEqual([]);
    await opened(sock);
    await settle(monitor.waInstances.test);
    expect({
      logouts: sock.logouts,
      me: storedMe(),
      loggedOut: emitted.some((e) => e.event === 'logout.instance'),
    }).toEqual({
      logouts: 1,
      me: [],
      loggedOut: true,
    });
  });

  // What the row records must go when the logout is delivered, or a later boot would log out a
  // device linked again since.
  it('once delivered, is not resumed by the next boot', async () => {
    const { service } = await waitingToReconnect();
    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    const sock = await reconnected(2);
    await opened(sock);
    await settle(service);
    expect(sock.logouts).toBe(1);
    socketSpy.mockClear();

    const monitor = await startProcess();
    await vi.waitFor(() => expect(monitor.waInstances.test).toBeDefined());
    await new Promise((r) => setTimeout(r, 1_200));
    expect({ sockets: built().length, pending: monitor.waInstances.test.logoutPending }).toEqual({
      sockets: 0,
      pending: false,
    });
  });

  it('a deleted instance survives the loss of the instances volume: still out of the API, its name taken', async () => {
    const { service } = await waitingToReconnect();
    expect((await call('DELETE', 'delete')).status).toBe(202);
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();
    rmSync(DIR, { recursive: true, force: true });

    const monitor = await startProcess();
    const sock = await reconnected(1);
    const create = await fetch(`${app.base}/instance/create`, {
      method: 'POST',
      headers: { apikey: globalKey, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceName: 'test', integration: 'WHATSAPP-BAILEYS' }),
    });
    expect({ listed: !!monitor.waInstances.test, create: create.status }).toEqual({ listed: false, create: 403 });
    const finishing = monitor.finishingLogouts.test;
    await opened(sock);
    await settle(finishing);
    expect({ logouts: sock.logouts, me: storedMe(), instances: prisma.instance.rows.length }).toEqual({
      logouts: 1,
      me: [],
      instances: 0,
    });
  });

  // A 202 is a promise the logout survives a restart. When it cannot be recorded, the caller is told.
  it('answers an error, not 202, when the pending logout cannot be recorded, and 202 once it can', async () => {
    const { service } = await waitingToReconnect();
    const update = prisma.instance.update;
    prisma.instance.update = async () => {
      throw new Error("Can't reach database server");
    };
    const failed = await call('DELETE', 'logout');
    prisma.instance.update = update;
    expect(failed.status).toBe(500);
    // Still pending in this process meanwhile: the creds stay.
    expect({ me: storedMe(), pending: service.logoutPending }).toEqual({ me: [WUID], pending: true });

    expect(await call('DELETE', 'logout')).toEqual(PENDING);
  });

  it('a delete whose pending logout cannot be recorded fails, and leaves the instance in the API', async () => {
    const { monitor } = await waitingToReconnect();
    const update = prisma.instance.update;
    prisma.instance.update = async () => {
      throw new Error("Can't reach database server");
    };
    const failed = await call('DELETE', 'delete');
    prisma.instance.update = update;
    expect({
      status: failed.status,
      listed: !!monitor.waInstances.test,
      me: storedMe(),
      instances: prisma.instance.rows.length,
    }).toEqual({ status: 500, listed: true, me: [WUID], instances: 1 });
  });

  it('finishes when WhatsApp answers loggedOut on the reconnect (the device was already removed)', async () => {
    const { service } = await waitingToReconnect();
    expect(await call('DELETE', 'logout')).toEqual(PENDING);

    const sock = await reconnected(2);
    sock.end(new Boom('Stream Errored (conflict)', { statusCode: 401 }));
    await settle(service);
    expect({ logouts: sock.logouts, me: storedMe(), dir: existsSync(DIR) }).toEqual({ logouts: 0, me: [], dir: false });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(built()).toHaveLength(2);
  });

  it('on delete, leaves the API at once and keeps only what the logout needs until it is delivered', async () => {
    const { monitor, service } = await waitingToReconnect();

    expect(await call('DELETE', 'delete')).toEqual({
      status: 202,
      body: {
        status: 'PENDING',
        error: false,
        response: { message: 'Instance deleted; its logout will reach WhatsApp when the connection returns' },
      },
    });
    // Gone from the API: no instance, no settings. Kept: the row (deleting it would cascade to the
    // session and the proxy), the creds, the key files and marker, the proxy.
    expect(monitor.waInstances.test).toBeUndefined();
    expect({
      instances: prisma.instance.rows.length,
      settings: prisma.setting.rows.length,
      proxies: prisma.proxy.rows.length,
      me: storedMe(),
      marker: JSON.parse(readFileSync(MARKER, 'utf8')),
    }).toMatchObject({
      instances: 1,
      settings: 0,
      proxies: 1,
      me: [WUID],
      marker: { instanceName: 'test', deleted: true },
    });
    // Until it finishes, connectionState (global key) says so; nothing else answers for the name.
    expect(await call('GET', 'connectionState', globalKey)).toEqual({
      status: 200,
      body: { instance: { instanceName: 'test', state: 'close', logoutPending: true } },
    });

    // The name stays taken until then, so connectionState cannot mean a new instance.
    const create = await fetch(`${app.base}/instance/create`, {
      method: 'POST',
      headers: { apikey: globalKey, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceName: 'test', integration: 'WHATSAPP-BAILEYS' }),
    });
    expect(create.status).toBe(403);

    const sock = await reconnected(2);
    await deliverWhilePending(sock, service);
    await opened(sock);
    await settle(service);
    expect({
      logouts: sock.logouts,
      emitted: emitted.map((e) => e.event),
      me: storedMe(),
      dir: existsSync(DIR),
      proxies: prisma.proxy.rows.length,
      instances: prisma.instance.rows.length,
    }).toEqual({ logouts: 1, emitted: [], me: [], dir: false, proxies: 0, instances: 0 });
    // Finished: the name is gone from the API.
    expect((await call('GET', 'connectionState', globalKey)).status).toBe(404);
  });

  it('on logout then delete (a purge), resumes after a restart', async () => {
    const { service } = await waitingToReconnect();
    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    expect((await call('DELETE', 'delete')).status).toBe(202);
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();

    const monitor = await startProcess();
    const sock = await reconnected(1);
    expect(monitor.waInstances.test).toBeUndefined();
    const finishing = monitor.finishingLogouts.test;
    await opened(sock);
    await settle(finishing);
    expect({ logouts: sock.logouts, me: storedMe(), dir: existsSync(DIR), proxies: prisma.proxy.rows.length }).toEqual({
      logouts: 1,
      me: [],
      dir: false,
      proxies: 0,
    });
  });

  // A delete made before the row was kept for the logout left a marker and no row. The boot still
  // finishes it (resumeDeletedLogouts): out of the API, then the marker and key files go.
  it('a deleted marker with no row (a delete from before the row was kept) is still finished on boot', async () => {
    const { service } = await waitingToReconnect();
    expect((await call('DELETE', 'delete')).status).toBe(202);
    service.stopReconnecting();
    service.connect = async () => undefined;
    socketSpy.mockClear();
    prisma.instance.rows.length = 0;

    const monitor = await startProcess();
    const sock = await reconnected(1);
    expect(monitor.waInstances.test).toBeUndefined();
    const finishing = monitor.finishingLogouts.test;
    expect(finishing).toBeDefined();
    await opened(sock);
    await settle(finishing);
    expect({ dir: existsSync(DIR), finishing: monitor.finishingLogouts.test }).toEqual({
      dir: false,
      finishing: undefined,
    });
  });

  it('a logout on an open connection still completes at once', async () => {
    await linkedInstance();
    const monitor = await startProcess();
    await vi.waitFor(() => expect(built()).toHaveLength(1));
    const service = monitor.waInstances.test;
    await opened(current());

    expect(await call('DELETE', 'logout')).toEqual({
      status: 200,
      body: { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } },
    });
    await settle(service);
    expect({ logouts: current().logouts, me: storedMe(), marker: existsSync(MARKER) }).toEqual({
      logouts: 1,
      me: [],
      marker: false,
    });
  });

  // Two logouts at once (two clients, or a logout and a delete): the second answered 'done' as
  // soon as it saw the first under way, while the first's remove-companion-device was still in
  // flight and could still fail and leave the logout pending.
  it('a second logout while the first is under way answers with the first, not before it', async () => {
    await linkedInstance();
    const monitor = await startProcess();
    await vi.waitFor(() => expect(built()).toHaveLength(1));
    const service = monitor.waInstances.test;
    const sock = current();
    await opened(sock);
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Hold the request to remove the device, however it is sent.
    const { logout, query } = sock;
    sock.logout = async (msg?: string) => {
      await gate;
      return logout(msg);
    };
    sock.query = async (node: any) => {
      await gate;
      return query(node);
    };

    const answered: string[] = [];
    const first = call('DELETE', 'logout').then((r) => (answered.push('first'), r));
    await new Promise((r) => setTimeout(r, 50));
    const second = call('DELETE', 'logout').then((r) => (answered.push('second'), r));
    await new Promise((r) => setTimeout(r, 200));
    expect(answered).toEqual([]);

    release();
    const ok = { status: 200, body: { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } } };
    expect({ first: await first, second: await second }).toEqual({ first: ok, second: ok });
    await settle(service);
    expect({ logouts: sock.logouts, me: storedMe() }).toEqual({ logouts: 1, me: [] });
  });

  // Baileys' logout() writes remove-companion-device and then ends the socket itself with loggedOut;
  // it never waits for WhatsApp. So that close is not WhatsApp's word: if the connection fails before
  // WhatsApp processed the request, the device stays linked, and wiping the creds leaves it on the
  // phone for good.
  it('is not finished by the socket closing itself: without WhatsApp confirming, it stays pending', async () => {
    await linkedInstance();
    const monitor = await startProcess();
    await vi.waitFor(() => expect(built()).toHaveLength(1));
    const service = monitor.waInstances.test;
    const sock = current();
    await opened(sock);
    // The request is written, then the connection fails before WhatsApp answers.
    sock.confirmRemove = false;
    sock.afterRemove = () => setTimeout(() => sock.end(new Boom('Connection Terminated', { statusCode: 428 })), 20);

    expect(await call('DELETE', 'logout')).toEqual(PENDING);
    expect({ me: storedMe(), pending: service.logoutPending }).toEqual({ me: [WUID], pending: true });

    // The reconnect: WhatsApp refuses the device, which is its word that it is gone.
    const next = await reconnected(2);
    next.end(new Boom('Connection Failure', { statusCode: 401 }));
    await settle(service);
    expect({ me: storedMe(), pending: service.logoutPending }).toEqual({ me: [], pending: false });
  });
});

// On boot the monitor lists the instances and connects each one that was open, then registers it.
// A connect that failed there (the database answering the listing but failing the next read)
// left the instance unregistered, with no socket and no reconnect: out of the API until the
// process restarted, although the database came back a second later.
describe('a boot whose first connect fails on a database read', () => {
  it('keeps the instance in the API and connects it once the database answers', async () => {
    await linkedInstance();
    const read = prisma.setting.findUnique;
    let failures = 1;
    prisma.setting.findUnique = async (args: any) => {
      if (failures-- > 0) throw new Error("Can't reach database server");
      return read(args);
    };

    const monitor = await startProcess();
    await vi.waitFor(() => expect(monitor.waInstances.test).toBeDefined(), { timeout: 1_000 });
    await vi.waitFor(() => expect(built()).toHaveLength(1), { timeout: 3_000 });
    prisma.setting.findUnique = read;
  });
});
