// When a socket closes with a code that is not a logout, Evolution connects
// again. Every attempt builds a socket, fetches the WhatsApp Web version and
// opens a connection through the instance's proxy. If the exit is dead, every
// attempt closes again at once, so the attempts must be spaced out: 1s, 2s, 4s
// and so on, doubling up to one a minute, and back to 1s once a connection has
// opened. They never stop: an instance that gave up would sit disconnected with
// valid credentials until someone noticed. A reconnect still waiting when the
// instance is logged out or deleted must not happen.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
// This file is about when a reconnect happens; the version fetch has its own tests.
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { Boom } from '@hapi/boom';
import { WAMonitoringService } from '@api/services/monitor.service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';

socketSpy.mockImplementation(fakeSocket);

const LADDER = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
// Longer than any delay the ladder may use: past this, no reconnect is coming.
const NEVER = 5 * 60_000;

beforeEach(() => {
  socketSpy.mockClear();
  // setImmediate stays real: flush() uses it to let the event queue and the connect path run.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const sockets = () => socketSpy.mock.results.length;
const current = () => socketSpy.mock.results[socketSpy.mock.results.length - 1].value;

async function connected() {
  const { service, prisma } = await makeService();
  stubAuthState(service);
  await service.connectToWhatsapp();
  expect(sockets()).toBe(1);
  return { service, prisma };
}

function closeWith(statusCode: number) {
  current().ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: new Boom('closed', { statusCode }), date: new Date() },
  });
}

/** Close the live socket and return how long Evolution waited before the next socket (null: none came). */
async function reconnectDelay(statusCode: number): Promise<number | null> {
  const before = sockets();
  const start = Date.now();
  closeWith(statusCode);
  await flush();
  while (sockets() === before) {
    if (Date.now() - start > NEVER) return null;
    await vi.advanceTimersByTimeAsync(250);
    await flush();
  }
  return Date.now() - start;
}

async function open() {
  current().ev.emit('connection.update', { connection: 'open' });
  await flush();
}

describe('reconnecting after a close', () => {
  it('waits 1s, 2s, 4s... up to a minute between attempts, and never stops', async () => {
    await connected();
    const delays: (number | null)[] = [];
    for (let i = 0; i < 25; i++) delays.push(await reconnectDelay(500));
    expect(delays).toEqual([...LADDER, ...Array(25 - LADDER.length).fill(60_000)]);
  });

  it('backs off the same way whichever reconnectable code closed it', async () => {
    await connected();
    const delays: (number | null)[] = [];
    for (const code of [408, 428, 500, 503, 411, 408]) delays.push(await reconnectDelay(code));
    expect(delays).toEqual(LADDER.slice(0, 6));
  });

  it('starts again from 1s once a connection has opened', async () => {
    await connected();
    const before = [await reconnectDelay(408), await reconnectDelay(408), await reconnectDelay(408)];
    await open();
    const after = [await reconnectDelay(408), await reconnectDelay(408)];
    expect({ before, after }).toEqual({ before: [1_000, 2_000, 4_000], after: [1_000, 2_000] });
  });

  it('tries again when a reconnect attempt itself fails', async () => {
    const { service } = await connected();
    // The next reconnect cannot read the session's credentials (a database blip); the one after can.
    const read = service.defineAuthState;
    let failures = 1;
    service.defineAuthState = async () => {
      if (failures-- > 0) throw new Error('database unavailable');
      return read();
    };
    expect(await reconnectDelay(500)).toBe(1_000 + 2_000);
  });

  it('does not reconnect after a logout code', async () => {
    for (const code of [401, 402, 403, 406]) {
      socketSpy.mockClear();
      await connected();
      expect(await reconnectDelay(code)).toBeNull();
    }
  });

  it('drops a waiting reconnect when the instance is logged out', async () => {
    const { service } = await connected();
    closeWith(500);
    await flush();
    await service.logoutInstance();
    await vi.advanceTimersByTimeAsync(NEVER);
    await flush();
    expect(sockets()).toBe(1);
  });

  it('drops a waiting reconnect when the instance is deleted', async () => {
    const { service, prisma } = await connected();
    const { ConfigService } = await import('@config/env.config');
    const monitor = new WAMonitoringService(service.eventEmitter, new ConfigService(), prisma, null, null, null, null);
    monitor.waInstances.test = service;
    closeWith(500);
    await flush();
    // What DELETE /instance/delete emits when the instance is not connected (instance.controller.ts deleteInstance).
    service.eventEmitter.emit('remove.instance', 'test', 'inner');
    await flush();
    await vi.advanceTimersByTimeAsync(NEVER);
    await flush();
    expect(sockets()).toBe(1);
  });
});
