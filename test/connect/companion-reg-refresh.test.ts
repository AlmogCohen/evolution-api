// Since about 2026-07-28 WhatsApp sends <notification type='companion_reg_refresh'>
// to a companion that is being linked (Baileys #2737; reproduced in whatsmeow).
// It retires the adv secret the companion advertises: WA Web answers it by
// minting a new adv secret and re-rendering the QR on screen with it
// (WAWebHandleCompanionReqRefreshNotification), and a phone that scans a QR
// still carrying the retired secret shows "Couldn't link device".
//
// Baileys 7.0.0-rc14 has no handler for it. The generic notification path
// tries to ack it and throws a TypeError before the ack is written (it reads
// creds.me.id, and an unlinked companion has no creds.me, Baileys #2738), and
// nothing else happens: the QR keeps the retired secret, no pair-success ever
// comes, and the refs run out ('QR refs attempts ended').
//
// Linking with a code never puts the adv secret in a QR: both sides derive it
// from the code exchange (primary_hello, companion_finish), and the
// pair-success that follows is authenticated with it. A refresh must not
// replace that secret, or a link that was about to succeed cannot. The same
// flow also carries a link_code_companion_reg notification with no pairing data
// (Baileys #2600), which rc14 reads as a primary_hello and fails on
// ('Invalid buffer').
//
// Evolution's real connect runs the real Baileys socket against a local
// "WhatsApp" (test/helpers/fake-whatsapp.ts), and the phone's side is played
// with the same primitives Baileys verifies with.
import { vi } from 'vitest';

const h = vi.hoisted(() => ({ wsUrl: '', sockets: [] as any[], services: [] as any[] }));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-pairing-'));
});

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));
// The real socket, sent to the local "WhatsApp" instead of web.whatsapp.com.
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  const make = (config: any) => {
    const socket = orig.makeWASocket({ ...config, waWebSocketUrl: h.wsUrl });
    h.sockets.push(socket);
    return socket;
  };
  // connectionUpdate waits a second before asking for a pairing code; the wait is not what is tested.
  return { ...orig, default: make, makeWASocket: make, delay: (ms: number) => orig.delay(Math.min(ms, 5)) };
});

import { rmSync } from 'node:fs';

import { getBinaryNodeChild, getBinaryNodeChildBuffer } from 'baileys';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService, settle } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { emitted, prismaRepository as prisma } from '../helpers/fake-server-module';
import {
  ackFor,
  bareLinkCodeNotification,
  companionRegRefresh,
  deliver,
  iqResult,
  pairDevice,
  qrFields,
  scanQr,
  startCodeLink,
  startFakeWhatsapp,
} from '../helpers/fake-whatsapp';
import { loopbackOnly } from '../helpers/local-net';

const PHONE = '972500000000';
const REFS = ['2@ref-1', '2@ref-2', '2@ref-3', '2@ref-4', '2@ref-5', '2@ref-6'];

let guard: ReturnType<typeof loopbackOnly>;
let whatsapp: Awaited<ReturnType<typeof startFakeWhatsapp>>;

beforeAll(() => void (guard = loopbackOnly()));
beforeEach(async () => {
  whatsapp = await startFakeWhatsapp();
  h.wsUrl = whatsapp.url;
  emitted.length = 0;
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
  await whatsapp.close();
  h.sockets.length = 0;
  h.services.length = 0;
  for (const t of Object.values(prisma) as any[]) if (Array.isArray(t?.rows)) t.rows.length = 0;
  rmSync(`${tmp}/inst-1`, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  expect(guard.refused).toEqual([]);
  guard.restore();
});

/** A new instance, connecting through Evolution's real connect, its socket open to the local WhatsApp. */
async function connecting(number?: string) {
  await prisma.instance.create({
    data: { id: 'inst-1', name: 'test', connectionStatus: 'close', token: 'token', integration: 'WHATSAPP-BAILEYS' },
  });
  const { service } = await makeService({ prisma });
  h.services.push(service);
  await service.connectToWhatsapp(number);
  const socket = h.sockets.at(-1);
  await vi.waitFor(() => expect(socket.ws.isOpen).toBe(true));
  return { service, socket };
}

/** The QR codes Evolution sent on qrcode.updated, in order. */
const qrs = () => emitted.filter((e) => e.event === 'qrcode.updated' && e.data?.qrcode).map((e) => e.data.qrcode);
/** The creds Evolution stored for the session (Prisma auth store: JSON inside a JSON string). */
const storedCreds = () => JSON.parse(JSON.parse(prisma.session.rows[0].creds));
/** Everything the companion wrote to WhatsApp, as tag and attributes. */
const wire = () => whatsapp.sent.map((n) => ({ tag: n.tag, attrs: n.attrs }));
const sentWith = (tag: string, child: string) =>
  whatsapp.sent.find((n) => n.tag === tag && Array.isArray(n.content) && n.content[0]?.tag === child);

/** Baileys' error lines (pino level 50 and above) in captured output. */
const errorLines = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((l) => l.level >= 50)
    .map((l) => ({ msg: l.msg, error: l.error }));

describe('companion_reg_refresh while linking by QR', () => {
  it('rotates the adv secret, re-renders the QR on screen with it, and the scan links the device', async () => {
    const { service, socket } = await connecting();

    deliver(socket, pairDevice(REFS));
    await vi.waitFor(() => expect(qrs()).toHaveLength(1));
    const first = qrFields(qrs()[0].code);
    expect(first.ref).toBe('2@ref-1');
    await settle(service);
    expect(storedCreds().advSecretKey).toBe(first.adv);

    // The phone scans; WhatsApp retires the secret that QR advertised.
    const refresh = companionRegRefresh();
    const retired = [first.adv];
    deliver(socket, refresh);
    await vi.waitFor(() => expect(qrs()).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(wire()).toContainEqual(ackFor(refresh)));
    await settle(service);

    // The same ref (a refresh spends none), with a new secret, which is the one stored.
    const second = qrFields(qrs()[1].code);
    expect(second).toEqual({ ...first, adv: second.adv });
    expect(second.adv).not.toBe(first.adv);
    expect(Buffer.from(second.adv, 'base64')).toHaveLength(32);
    expect(storedCreds().advSecretKey).toBe(second.adv);

    // The person scans the QR on screen, and WhatsApp confirms the link.
    const { node, device } = scanQr(qrs().at(-1).code, retired);
    deliver(socket, node);
    await vi.waitFor(() => expect(sentWith('iq', 'pair-device-sign')?.attrs).toEqual({ to: '@s.whatsapp.net', type: 'result', id: node.attrs.id }));
    await settle(service);
    expect(storedCreds().me).toEqual({ id: device.jid, lid: device.lid });
    expect(storedCreds().advSecretKey).toBe(second.adv);
  });
});

describe('companion_reg_refresh while linking with a code', () => {
  it('keeps the secret the code exchange derived, and the link completes', async () => {
    let service: any;
    let socket: any;
    const out = await captureOutput(async () => {
      ({ service, socket } = await connecting(PHONE));
      deliver(socket, pairDevice(REFS));
      await vi.waitFor(() => expect(qrs()).toHaveLength(1));
      const code = qrs()[0].pairingCode;
      expect(code).toMatch(/^[A-Z0-9]{8}$/);

      // Stage 1: the companion_hello, which WhatsApp answers with the ref of this code.
      const hello = sentWith('iq', 'link_code_companion_reg');
      expect(getBinaryNodeChild(hello, 'link_code_companion_reg').attrs).toEqual({
        jid: `${PHONE}@s.whatsapp.net`,
        stage: 'companion_hello',
        should_show_push_notification: 'true',
      });
      const ref = Buffer.from('link-code-ref-1');
      deliver(
        socket,
        iqResult(hello.attrs.id, [
          { tag: 'link_code_companion_reg', attrs: { stage: 'companion_hello' }, content: [{ tag: 'link_code_pairing_ref', attrs: {}, content: ref }] },
        ]),
      );

      // The person opens Linked devices: a link_code_companion_reg with no pairing data.
      const bare = bareLinkCodeNotification();
      deliver(socket, bare);
      await vi.waitFor(() => expect(wire()).toContainEqual(ackFor(bare)));

      // They type the code; WhatsApp refreshes the registration, and the phone says hello.
      const refreshAfterCode = companionRegRefresh();
      deliver(socket, refreshAfterCode);
      await vi.waitFor(() => expect(wire()).toContainEqual(ackFor(refreshAfterCode)));
      const link = await startCodeLink(hello, code, ref);
      deliver(socket, link.primaryHello);

      // Stage 2: the companion_finish, which derives the adv secret the pair-success is authenticated with.
      const linkCodeIqs = () => whatsapp.sent.filter((n) => n.tag === 'iq' && getBinaryNodeChild(n, 'link_code_companion_reg'));
      await vi.waitFor(() => expect(linkCodeIqs()).toHaveLength(2), { timeout: 5000 });
      const finish = linkCodeIqs()[1];
      expect(getBinaryNodeChild(finish, 'link_code_companion_reg').attrs).toEqual({ jid: `${PHONE}@s.whatsapp.net`, stage: 'companion_finish' });
      expect(getBinaryNodeChildBuffer(getBinaryNodeChild(finish, 'link_code_companion_reg'), 'link_code_pairing_ref')).toEqual(ref);
      const { advSecret, node, device } = link.finish(finish);
      deliver(socket, iqResult(finish.attrs.id));
      await settle(service);
      await vi.waitFor(() => expect(storedCreds().advSecretKey).toBe(advSecret));

      // A refresh while the pair-success is on its way must leave that secret alone.
      const refreshPending = companionRegRefresh();
      deliver(socket, refreshPending);
      await vi.waitFor(() => expect(wire()).toContainEqual(ackFor(refreshPending)));
      await settle(service);
      expect(storedCreds().advSecretKey).toBe(advSecret);

      deliver(socket, node);
      await vi.waitFor(() => expect(sentWith('iq', 'pair-device-sign')?.attrs).toEqual({ to: '@s.whatsapp.net', type: 'result', id: node.attrs.id }));
      await settle(service);
      expect(storedCreds().me).toEqual({ id: device.jid, lid: device.lid });
    });

    // Nothing in the flow failed on the way.
    expect(errorLines(out)).toEqual([]);
  });
});
