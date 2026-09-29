// An instance owns one WhatsApp socket at a time. Building a new one (a
// reconnect, /instance/connect, a restart) must first let go of the old one:
// stop listening to it, then end it. Otherwise the old socket keeps talking:
// its close starts a reconnect that ends the new one, its QR codes replace the
// new one's, and two logged-in sockets on one session get 440 (replaced) from
// WhatsApp in turn, forever. Two connects that overlap, which is what
// /instance/connect polled every 2s does while Evolution is reconnecting,
// must build one socket between them.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
// This file is about which socket is live; the version fetch has its own tests.
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { Boom } from '@hapi/boom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';

socketSpy.mockImplementation(fakeSocket);

// Longer than any reconnect backoff: past this, no reconnect is coming.
const NEVER = 5 * 60_000;

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

type Sock = ReturnType<typeof fakeSocket>;
const built = (): Sock[] => socketSpy.mock.results.map((r) => r.value);
const live = () => built().filter((s) => !s.ended);
/** Nothing of Evolution's is still listening to this socket. */
const detached = (s: Sock) =>
  s.handlers() + s.ws.listenerCount('CB:call') + s.ws.listenerCount('CB:ack,class:call') === 0;

async function service() {
  const { service } = await makeService();
  stubAuthState(service);
  return service;
}

/** WhatsApp closes the socket: Baileys ends it with the reason, which it announces as a close. */
function dropped(sock: Sock, statusCode: number) {
  sock.end(new Boom('closed', { statusCode }));
}

async function opened(sock: Sock) {
  sock.ev.emit('connection.update', { connection: 'open' });
  await flush();
}

async function waitOutAnyReconnect() {
  await vi.advanceTimersByTimeAsync(NEVER);
  await flush();
}

describe('one instance, one socket', () => {
  it('two overlapping connects build one socket', async () => {
    const s = await service();
    const [a, b] = await Promise.all([s.connectToWhatsapp(), s.connectToWhatsapp()]);
    await waitOutAnyReconnect();
    expect({ built: built().length, same: a === b, live: live().length }).toEqual({ built: 1, same: true, live: 1 });
  });

  it('a connect while a reconnect is waiting replaces the old socket once, and the reconnect does not follow', async () => {
    const s = await service();
    await s.connectToWhatsapp();
    const [first] = built();
    dropped(first, 408);
    await flush();
    // /instance/connect sees state "close" during the backoff and connects.
    await s.connectToWhatsapp();
    await waitOutAnyReconnect();
    const [, second] = built();
    expect({
      built: built().length,
      live: live().length,
      current: s.client === second,
      firstEnded: first.ended,
      firstDetached: detached(first),
    }).toEqual({ built: 2, live: 1, current: true, firstEnded: true, firstDetached: true });
  });

  it('a connect ends the socket it replaces, after it has stopped listening to it', async () => {
    const s = await service();
    await s.connectToWhatsapp();
    const [first] = built();
    await opened(first);
    // /instance/restart on Baileys, or any second connect while the first socket is still up.
    await s.connectToWhatsapp();
    await waitOutAnyReconnect();
    // Ending the first socket announces its close; had Evolution still been listening, it would reconnect.
    expect({
      built: built().length,
      live: live().length,
      firstEnded: first.ended,
      firstDetached: detached(first),
    }).toEqual({ built: 2, live: 1, firstEnded: true, firstDetached: true });
  });

  it('what a replaced socket still emits does not drive the instance', async () => {
    const s = await service();
    await s.connectToWhatsapp();
    const [first] = built();
    await s.connectToWhatsapp();
    const [, second] = built();
    await opened(second);
    // The replaced socket's buffered close arrives late (a 440 from WhatsApp, say).
    first.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('replaced', { statusCode: 440 }), date: new Date() },
    });
    await flush();
    await waitOutAnyReconnect();
    expect({ built: built().length, state: s.connectionStatus.state, current: s.client === second }).toEqual({
      built: 2,
      state: 'open',
      current: true,
    });
  });

  // Guards the fix rather than the bug: letting a connect replace a waiting reconnect must not
  // lose that reconnect when the connect fails before it has built a socket.
  it('a connect that fails leaves the waiting reconnect in place', async () => {
    const s = await service();
    await s.connectToWhatsapp();
    const [first] = built();
    dropped(first, 408);
    await flush();
    const read = s.defineAuthState;
    s.defineAuthState = async () => {
      s.defineAuthState = read;
      throw new Error('database unavailable');
    };
    await expect(s.connectToWhatsapp()).rejects.toBeDefined();
    await waitOutAnyReconnect();
    expect({ built: built().length, live: live().length }).toEqual({ built: 2, live: 1 });
  });

  it('a 440 on the live socket is still reconnected', async () => {
    const s = await service();
    await s.connectToWhatsapp();
    const [first] = built();
    await opened(first);
    dropped(first, 440);
    await flush();
    await waitOutAnyReconnect();
    expect({ built: built().length, live: live().length }).toEqual({ built: 2, live: 1 });
  });

  // Two more ways a socket was built outside that guard: reloadConnection (after a profile or privacy
  // update) called createClient directly, and shutdown (the instance is removed) did not stop a
  // socket already being built, which then went live for an instance that no longer exists.
  describe('every socket goes through the same guard', () => {
    /** Hold the next socket build at its first wait (reading the auth state) until released. */
    function holdNextBuild(s: any) {
      let release: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const read = s.defineAuthState;
      s.defineAuthState = async () => {
        await gate;
        return read();
      };
      return () => release();
    }

    it('a reload while a connect is being built joins it: one socket', async () => {
      const s = await service();
      const release = holdNextBuild(s);
      const connect = s.connectToWhatsapp();
      await flush();
      const reload = s.reloadConnection();
      await flush();
      release();
      await Promise.all([connect, reload]);
      await waitOutAnyReconnect();
      expect({ built: built().length, live: live().length }).toEqual({ built: 1, live: 1 });
    });

    it('a socket being built when the instance is shut down never goes live', async () => {
      const s = await service();
      const release = holdNextBuild(s);
      const connect = s.connectToWhatsapp().catch(() => undefined);
      await flush();
      s.shutdown();
      release();
      await connect;
      await waitOutAnyReconnect();
      expect({ built: built().length, live: live().length }).toEqual({ built: 0, live: 0 });
    });

    it('a reload after the instance is shut down builds nothing', async () => {
      const s = await service();
      await s.connectToWhatsapp();
      s.shutdown();
      await s.reloadConnection().catch(() => undefined);
      await waitOutAnyReconnect();
      expect({ built: built().length, live: live().length }).toEqual({ built: 1, live: 0 });
    });
  });
});
