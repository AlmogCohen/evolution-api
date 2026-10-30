// A socket must not wait in 'connecting' for good. On 2026-10-29 a number's reconnect built its
// WebSocket through a proxy exit that accepted the TCP connection and never answered CONNECT; it
// stayed down for 9 hours. Nothing in the stack had a clock running yet: ws's handshakeTimeout
// arms only once https-proxy-agent hands over a socket (after the proxy answers), and Baileys'
// own timers (connectTimeoutMs, the keepalive) start only once the WebSocket is open. So no close
// ever came, and the reconnect that a close starts never ran.
//
// What must hold: a socket whose WebSocket has not opened within the deadline is ended, its close
// is handled as any other (the reconnect backoff), and the next attempt goes out. One whose
// WebSocket opened (a QR waiting to be scanned, a pairing code being typed) is left to Baileys'
// own timers. A socket replaced, or an instance removed, before the deadline ends nothing.
import { vi } from 'vitest';

const { socketSpy, realSocket, versionFetch } = vi.hoisted(() => ({
  socketSpy: vi.fn(),
  realSocket: { make: null as any },
  versionFetch: { real: false },
}));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-connect-deadline-'));
});

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  realSocket.make = orig.default;
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
// The version fetch goes through the proxy first on every attempt; the fake-socket cases skip it.
vi.mock('@utils/fetchLatestWaWebVersion', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    fetchLatestWaWebVersion: (...args: any[]) =>
      versionFetch.real
        ? orig.fetchLatestWaWebVersion(...args)
        : Promise.resolve({ version: [2, 3000, 1], isLatest: true }),
  };
});

import { rmSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { WAMonitoringService } from '@api/services/monitor.service';
import { WA_VERSION_FETCH_TIMEOUT_MS } from '@utils/fetchLatestWaWebVersion';
import { writeLogoutMarker } from '@utils/logout-marker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';
import { loopbackOnly } from '../helpers/local-net';

// connectTimeoutMs (30s) and a margin: past it, nothing in the stack is going to close the socket.
const DEADLINE = 45_000;

/** An HTTP proxy that accepts every TCP connection and never answers a byte: the exit of 2026-10-29. */
let silent: { port: number; accepted: number; open: Set<net.Socket>; close: () => Promise<void> };
let guard: ReturnType<typeof loopbackOnly>;

beforeAll(async () => {
  guard = loopbackOnly();
  const open = new Set<net.Socket>();
  const server = net.createServer((s) => {
    silent.accepted++;
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => undefined);
    // It reads the CONNECT (and sees the client go), and answers nothing.
    s.resume();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  silent = {
    port: (server.address() as net.AddressInfo).port,
    accepted: 0,
    open,
    close: () =>
      new Promise<void>((r) => {
        open.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
});

afterAll(async () => {
  await silent.close();
  guard.restore();
  rmSync(tmp, { recursive: true, force: true });
  expect(guard.refused).toEqual([]);
});

beforeEach(() => {
  socketSpy.mockReset();
  socketSpy.mockImplementation((config: any) => realSocket.make(config));
  silent.accepted = 0;
  versionFetch.real = false;
  // setImmediate and the network stay real; the deadline and the backoff run on fake time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Wait, in real time, until `done` holds (the network is real), or fail after 5s. */
async function until(done: () => boolean, what: string) {
  const start = performance.now();
  while (!done()) {
    if (performance.now() - start > 5_000) throw new Error(`timed out waiting for ${what}`);
    // Real time (node:timers is not faked), so a wait does not spin.
    await sleep(2);
  }
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function behindSilentProxy() {
  const made = await makeService();
  await made.service.setProxy({
    enabled: true,
    host: '127.0.0.1',
    port: String(silent.port),
    protocol: 'http',
    username: '',
    password: '',
  });
  stubAuthState(made.service);
  return made;
}

const sockets = () => socketSpy.mock.results.length;
const latest = () => socketSpy.mock.results[socketSpy.mock.results.length - 1].value;

/**
 * Attempt `n` through the silent proxy, as production makes it: the version fetch reaches the proxy,
 * gives up after its 10s and lets go of that connection; then the WebSocket's CONNECT waits.
 */
async function attemptThrough(n: number) {
  await until(() => silent.accepted === 2 * n - 1, `attempt ${n}'s version fetch to reach the proxy`);
  await advance(WA_VERSION_FETCH_TIMEOUT_MS);
  await until(() => sockets() === n && silent.accepted === 2 * n, `attempt ${n}'s WebSocket to reach the proxy`);
  await until(() => silent.open.size === 1, `attempt ${n}'s version fetch to let go of the proxy`);
}

describe('a connect behind a proxy that never answers', () => {
  it('is ended at the deadline, and the reconnect goes out', async () => {
    versionFetch.real = true;
    const { service } = await behindSilentProxy();
    const connecting = service.connectToWhatsapp();
    await attemptThrough(1);
    await connecting;
    await flush();
    expect(service.connectionStatus.state).toBe('connecting');

    // Nothing before the deadline: Baileys' connectTimeoutMs alone ends nothing here.
    await advance(DEADLINE - 1_000);
    expect({ state: service.connectionStatus.state, sockets: sockets() }).toEqual({ state: 'connecting', sockets: 1 });

    // At the deadline the socket is ended as timed out, which closes it and lets go of the proxy.
    await advance(1_000);
    await until(() => service.connectionStatus.state === 'close', 'the close');
    expect(service.connectionStatus.statusReason).toBe(408);
    await until(() => silent.open.size === 0, 'the proxy connection to be released');

    // The close reconnects on the backoff (1s for the first attempt): a new socket, a new CONNECT.
    await advance(1_000);
    await attemptThrough(2);

    // And that one is held to the same deadline: the outage lasts a minute or two, not hours.
    await advance(DEADLINE);
    await until(() => service.connectionStatus.state === 'close', 'the second close');
    await until(() => silent.open.size === 0, 'the second WebSocket to let go of the proxy');
    await advance(2_000);
    await until(() => silent.accepted === 5, 'the second reconnect');

    service.shutdown();
  });

  it('a pending logout keeps trying through it the same way', async () => {
    await writeLogoutMarker('inst-1', { instanceName: 'test', deleted: false, since: new Date(0).toISOString() });
    const { service } = await behindSilentProxy();
    expect(await service.resumePendingLogout()).toBe(true);
    await until(() => silent.accepted === 1, 'the WebSocket to reach the proxy');

    await advance(DEADLINE);
    await until(() => service.connectionStatus.state === 'close', 'the close');
    await advance(1_000);
    await until(() => silent.accepted === 2, 'the reconnect to reach the proxy');
    expect(service.logoutPending).toBe(true);

    service.shutdown();
  });
});

describe('the deadline ends only a socket still waiting for its WebSocket', () => {
  beforeEach(() => socketSpy.mockImplementation((config: any) => fakeSocket(config, { wsOpens: false })));

  it('leaves a socket whose WebSocket opened (a QR waiting to be scanned)', async () => {
    const { service } = await behindSilentProxy();
    await service.connectToWhatsapp();
    latest().ws.emit('open');
    await advance(DEADLINE * 3);
    expect({ ended: latest().ended, sockets: sockets() }).toEqual({ ended: false, sockets: 1 });
    service.shutdown();
  });

  it('ends nothing once the socket was replaced by a new connect', async () => {
    const { service } = await behindSilentProxy();
    await service.connectToWhatsapp();
    await advance(DEADLINE / 2);
    // /instance/restart, or a profile change's reload: a new socket, whose WebSocket opens.
    await service.connectToWhatsapp();
    latest().ws.emit('open');
    await advance(DEADLINE * 3);
    const [first, second] = socketSpy.mock.results.map((r) => r.value);
    expect({ firstEnded: first.ended, secondEnded: second.ended, sockets: sockets() }).toEqual({
      firstEnded: true,
      secondEnded: false,
      sockets: 2,
    });
    service.shutdown();
  });

  it('ends nothing and reconnects nothing for an instance deleted before the deadline', async () => {
    const { service, prisma } = await behindSilentProxy();
    const { ConfigService } = await import('@config/env.config');
    const monitor = new WAMonitoringService(service.eventEmitter, new ConfigService(), prisma, null, null, null, null);
    monitor.waInstances.test = service;
    await service.connectToWhatsapp();
    const socket = latest();
    socket.end = vi.fn(socket.end);
    service.eventEmitter.emit('remove.instance', 'test', 'inner');
    await flush();
    await advance(DEADLINE * 3);
    // The removal itself lets go of the socket (with its own reason); the deadline adds no second end.
    expect(socket.end.mock.calls.map(([e]: any[]) => e?.output?.statusCode ?? null)).not.toContain(408);
    expect(sockets()).toBe(1);
  });

  it('a socket that closed on its own before the deadline is not ended again', async () => {
    const { service } = await behindSilentProxy();
    await service.connectToWhatsapp();
    const socket = latest();
    socket.end = vi.fn(socket.end);
    // The proxy refused: Baileys ends the socket itself. The reconnect waits 1s; its socket opens.
    socket.end(new Error('connect ECONNREFUSED'));
    await advance(1_000);
    latest().ws.emit('open');
    await advance(DEADLINE * 3);
    // Its only other end is the one that let go of it when the reconnect replaced it.
    const codes = socket.end.mock.calls.map(([e]: any[]) => e?.output?.statusCode ?? null);
    expect({ codes, secondEnded: latest().ended, sockets: sockets() }).toEqual({
      codes: [null, null],
      secondEnded: false,
      sockets: 2,
    });
    service.shutdown();
  });
});
