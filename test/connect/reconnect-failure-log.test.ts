// When a reconnect attempt fails before a socket exists (the network is down,
// the credentials cannot be read), Evolution logs it and schedules the next
// one. Seen live during an outage: the line said
// `{ message: 'Reconnect attempt failed', error: '[object Object]' }`, every
// time, so the operator could not tell why. The line must say what failed:
// the error's name, its message (scrubbed: no URL, JID or phone number) and
// its status code when it has one. Two shapes are thrown in practice: a Boom
// (an Error with output.statusCode) and a plain object that is not an Error.
// reloadConnection (after a privacy or profile picture change) rebuilds the
// socket the same way and printed the raw error, message and all.
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

import { Boom } from '@hapi/boom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { fakeSocket, stubAuthState } from '../helpers/connect';

socketSpy.mockImplementation(fakeSocket);

const PHONE = '972509876543';
const URL_SECRET = 'https://web.whatsapp.com/check?token=Zq7secret';

beforeEach(() => {
  socketSpy.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Connect, close with a reconnectable code, and let the first reconnect attempt throw `thrown`. */
async function failedReconnect(thrown: unknown) {
  const { service } = await makeService();
  stubAuthState(service);
  await service.connectToWhatsapp();
  const read = service.defineAuthState;
  let failures = 1;
  service.defineAuthState = async () => {
    if (failures-- > 0) throw thrown;
    return read();
  };
  const out = await captureOutput(async () => {
    const socket = socketSpy.mock.results[socketSpy.mock.results.length - 1].value;
    socket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('closed', { statusCode: 503 }), date: new Date() },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain.split('\n').filter((l) => l.includes('Reconnect attempt failed'));
  return { plain, logged: lines.map((l) => JSON.parse(l.slice(l.indexOf('{')))) };
}

describe('a failed reconnect says why', () => {
  it('a Boom: its name, scrubbed message and status code', async () => {
    const { plain, logged } = await failedReconnect(
      new Boom(`request to ${URL_SECRET} for ${PHONE}@s.whatsapp.net failed, reason: getaddrinfo ENOTFOUND`, { statusCode: 503 }),
    );

    expect(logged).toEqual([
      {
        message: 'Reconnect attempt failed',
        error: { name: 'Error', message: 'request to [url] for [jid] failed, reason: getaddrinfo ENOTFOUND', statusCode: 503 },
      },
    ]);
    expect(plain).not.toContain(PHONE);
    expect(plain).not.toContain('Zq7secret');
  });

  it('a plain object that is not an Error: its message, scrubbed, and no status code when it has none', async () => {
    const { plain, logged } = await failedReconnect({ code: 'ECONNREFUSED', message: `connect ECONNREFUSED to ${URL_SECRET} as ${PHONE}` });

    expect(logged).toEqual([
      {
        message: 'Reconnect attempt failed',
        error: { name: 'Object', message: 'connect ECONNREFUSED to [url] as [number]' },
      },
    ]);
    expect(plain).not.toContain(PHONE);
    expect(plain).not.toContain('Zq7secret');
  });
});

describe('a failed reload says why, scrubbed', () => {
  it('a Boom: its name, scrubbed message and status code, and nothing unscrubbed anywhere', async () => {
    const { service } = await makeService();
    service.defineAuthState = async () => {
      throw new Boom(`request to ${URL_SECRET} for ${PHONE}@s.whatsapp.net failed, reason: getaddrinfo ENOTFOUND`, {
        statusCode: 503,
      });
    };

    let thrown: any;
    const out = await captureOutput(async () => {
      await service.reloadConnection().catch((e: any) => (thrown = e));
    });

    expect(thrown?.status).toBe(500);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain(PHONE);
    expect(plain).not.toContain('Zq7secret');
    const logged = plain
      .split('\n')
      .filter((l) => l.includes('Reload connection failed'))
      .map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    expect(logged).toEqual([
      {
        message: 'Reload connection failed',
        error: { name: 'Error', message: 'request to [url] for [jid] failed, reason: getaddrinfo ENOTFOUND', statusCode: 503 },
      },
    ]);
  });
});
