// Linking with a phone number: while the socket waits to be paired, Baileys
// rotates the QR every qrTimeout (45s, createClient), emitting connection.update
// { qr } each time, and after the last ref it closes the socket (408) and
// Evolution opens a new one. Evolution asked for a NEW pairing code on every QR
// (connectionUpdate), and Baileys' requestPairingCode (rc14 socket.js) makes a
// fresh code and sends link_code_companion_reg with
// should_show_push_notification 'true': the code the person is typing dies and
// their phone gets another "link a device" push, every 45s.
//
// The QR count (QRCODE_LIMIT) was reset only when the instance is built and
// after the limit is hit, so a later connect attempt on the same instance
// started with the budget earlier attempts had used, and was refused early.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  // connectionUpdate waits a second before asking for the code; the wait is not what is tested.
  return { ...orig, default: socketSpy, makeWASocket: socketSpy, delay: (ms: number) => orig.delay(Math.min(ms, 5)) };
});
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';
import { emitted } from '../helpers/fake-server-module';
import { loopbackOnly } from '../helpers/local-net';

const PHONE = '972500000009';

let codes = 0;
const sockets: any[] = [];
socketSpy.mockImplementation(() => {
  const socket: any = {
    ...fakeSocket(),
    requestPairingCode: vi.fn(async () => `CODE${String(++codes).padStart(4, '0')}`),
    logout: vi.fn(async () => undefined),
  };
  socket.ws.close = vi.fn();
  sockets.push(socket);
  return socket;
});

let guard: ReturnType<typeof loopbackOnly>;
beforeAll(() => void (guard = loopbackOnly()));
afterAll(() => {
  expect(guard.refused).toEqual([]);
  guard.restore();
});

const qrUpdates = () => emitted.filter((e) => e.event === 'qrcode.updated' && e.data?.qrcode);
const refusals = () => emitted.filter((e) => e.event === 'connection.update' && e.data?.state === 'refused');
const requests = () => sockets.reduce((n, s) => n + s.requestPairingCode.mock.calls.length, 0);

async function until(done: () => boolean) {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!done()) throw new Error('timed out waiting');
}

/** Baileys shows the next QR ref; wait until Evolution has handled it (its webhook, or the refusal). */
async function nextQr(n: number) {
  const socket = sockets.at(-1);
  const before = qrUpdates().length + refusals().length;
  socket.ev.emit('connection.update', { qr: `2@ref-${n},noise,identity,adv` });
  await until(() => qrUpdates().length + refusals().length > before);
  await new Promise((r) => setTimeout(r, 10));
}

/** The QR refs ran out: Baileys ends the socket with 408, and Evolution reconnects on its own. */
async function refsEnded() {
  const count = sockets.length;
  sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await until(() => sockets.length > count);
}

async function service() {
  const { service } = await makeService();
  stubAuthState(service);
  return service;
}

describe('one pairing code per socket, and a fresh QR budget per connect attempt', () => {
  const limit = process.env.QRCODE_LIMIT;
  beforeEach(() => {
    emitted.splice(0);
    sockets.splice(0);
  });
  afterEach(() => {
    if (limit === undefined) delete process.env.QRCODE_LIMIT;
    else process.env.QRCODE_LIMIT = limit;
  });

  it('QR refreshes on one socket keep the pairing code the person is typing', async () => {
    const s = await service();
    await s.connectToWhatsapp(PHONE);

    await nextQr(1);
    await nextQr(2);
    await nextQr(3);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].requestPairingCode.mock.calls).toEqual([[PHONE]]);
    const code = qrUpdates()[0].data.qrcode.pairingCode;
    expect(code).toMatch(/^CODE\d{4}$/);
    expect(qrUpdates().map((e) => e.data.qrcode.pairingCode)).toEqual([code, code, code]);
    expect(s.qrCode.pairingCode).toBe(code);
  });

  it('a new socket, after the refs run out, asks for a new code once', async () => {
    const s = await service();
    await s.connectToWhatsapp(PHONE);
    await nextQr(1);
    await nextQr(2);
    await refsEnded();
    await nextQr(3);
    await nextQr(4);

    expect(sockets).toHaveLength(2);
    expect(sockets.map((x) => x.requestPairingCode.mock.calls.length)).toEqual([1, 1]);
    const [first, second] = [qrUpdates()[0], qrUpdates()[2]].map((e) => e.data.qrcode.pairingCode);
    expect(second).not.toBe(first);
    expect(qrUpdates().map((e) => e.data.qrcode.pairingCode)).toEqual([first, first, second, second]);
  });

  it('within one connect attempt the QR budget spans reconnects, and is refused at the limit', async () => {
    process.env.QRCODE_LIMIT = '3';
    const s = await service();
    await s.connectToWhatsapp(PHONE);
    await nextQr(1);
    await nextQr(2);
    await refsEnded();
    await nextQr(3);
    expect(refusals()).toHaveLength(0);
    await nextQr(4);

    expect(refusals()).toHaveLength(1);
    expect(requests()).toBe(2);
  });

  it('a new connect attempt (logout, then connect) starts with a fresh QR budget', async () => {
    process.env.QRCODE_LIMIT = '3';
    const s = await service();
    await s.connectToWhatsapp(PHONE);
    await nextQr(1);
    await nextQr(2);

    // What a client does for each new code request: log out, then connect again.
    await s.logoutInstance();
    await s.connectToWhatsapp(PHONE);
    expect(s.qrCode).toEqual({ pairingCode: undefined, code: undefined, base64: undefined, count: 0 });
    await nextQr(3);
    await nextQr(4);

    expect(refusals()).toHaveLength(0);
    expect(s.qrCode.count).toBe(2);
    expect(sockets.map((x) => x.requestPairingCode.mock.calls.length)).toEqual([1, 1]);
  });
});
