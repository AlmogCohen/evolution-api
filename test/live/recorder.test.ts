// A live check records the session it runs (LIVE_RECORD_DIR), so what the phone
// did can be replayed in a test later. The recorder sits on the real socket's
// events and on sendDataWebhook, and must be invisible otherwise: without the
// variable it writes nothing, and with it Evolution sends exactly the same.
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

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { proto } from 'baileys';
import Long from 'long';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decode, encode } from '@utils/live-record/codec';

import { makeService } from '../helpers/baileys-service';
import { connectBehind, fakeSocket, stubAuthState } from '../helpers/connect';
import { emitted } from '../helpers/fake-server-module';
import { CALL_ID, MESSAGE_ID, OWNER, PERSON, playSession, TEXT } from '../helpers/live-session';

socketSpy.mockImplementation(fakeSocket);

let root: string;
beforeEach(() => {
  emitted.splice(0);
  root = mkdtempSync(join(tmpdir(), 'live-record-'));
});
afterEach(() => {
  delete process.env.LIVE_RECORD_DIR;
  rmSync(root, { recursive: true, force: true });
});

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** The one session directory the recorder made: <root>/<instance>/<start>/. */
function sessionDir() {
  const instances = readdirSync(root);
  expect(instances).toEqual(['test']);
  const sessions = readdirSync(join(root, 'test'));
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  return join(root, 'test', sessions[0]);
}

/** The webhooks sent so far, each as its encoded JSON, in a stable order (background lookups interleave). */
const sent = () =>
  emitted
    .splice(0)
    .map((e) => JSON.stringify({ event: e.event, data: encode(e.data) }))
    .sort();

async function connected(opts: { msgCall?: string } = {}) {
  const { service, prisma } = await makeService();
  if (opts.msgCall) prisma.setting.rows.push({ instanceId: 'inst-1', msgCall: opts.msgCall });
  stubAuthState(service);
  await service.connectToWhatsapp();
  return service;
}

describe('live-check recorder', () => {
  it('is inert without LIVE_RECORD_DIR: nothing written, the same webhooks sent', async () => {
    delete process.env.LIVE_RECORD_DIR;
    await playSession(await connected());
    const without = sent();
    expect(readdirSync(root)).toEqual([]);

    process.env.LIVE_RECORD_DIR = root;
    await playSession(await connected());
    const withRecorder = sent();

    for (const event of ['connection.update', 'contacts.upsert', 'messages.upsert', 'call']) {
      expect(without.map((w) => JSON.parse(w).event)).toContain(event);
    }
    expect(withRecorder).toEqual(without);
  });

  it('writes the events, each with its sequence and whether the buffer held it, in the codec', async () => {
    process.env.LIVE_RECORD_DIR = root;
    await playSession(await connected());
    const dir = sessionDir();
    expect(readdirSync(dir).sort()).toEqual(['events.ndjson', 'manifest.json', 'owner.json', 'webhooks.ndjson']);

    const events = lines(join(dir, 'events.ndjson'));
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const emits = events.filter((e) => e.event);
    expect(emits.map((e) => [e.event, e.buffered])).toEqual([
      ['connection.update', false],
      ['creds.update', false],
      ['contacts.upsert', true],
      ['messages.upsert', true],
      ['call', false],
    ]);
    expect(emits.every((e) => e.socket === 1 && e.origin === undefined)).toBe(true);
    // The batches the buffer handed Evolution: the two buffered events arrived as one, in the buffer's key order.
    expect(events.filter((e) => e.batch).map((e) => e.batch)).toEqual([
      ['connection.update'],
      ['creds.update'],
      ['messages.upsert', 'contacts.upsert'],
      ['call'],
    ]);

    // The payload decodes to the values the socket emitted: classes, Longs and bytes included.
    const upsert = decode(emits[3].data);
    const message = upsert.messages[0];
    expect(message).toBeInstanceOf(proto.WebMessageInfo);
    expect(message.key.id).toBe(MESSAGE_ID);
    expect(Long.isLong(message.messageTimestamp)).toBe(true);
    expect(message.message.conversation).toBe(TEXT);
    expect(message.message.messageContextInfo.messageSecret).toBeInstanceOf(Uint8Array);
    expect(decode(emits[2].data)).toEqual([
      { id: PERSON.pn, lid: PERSON.lid, name: PERSON.saved, notify: PERSON.push },
    ]);

    // The auth creds never reach the tape.
    expect(emits[1].data).toEqual({ $redacted: 'creds', keys: ['me'] });
  });

  it('writes every webhook Evolution sent, as it sent it (the golden output)', async () => {
    process.env.LIVE_RECORD_DIR = root;
    await playSession(await connected());
    const webhooks = lines(join(sessionDir(), 'webhooks.ndjson'));
    expect(webhooks.map((w) => ({ event: w.event, data: w.data }))).toEqual(
      emitted.map((e) => ({ event: e.event, data: encode(e.data) })),
    );
    const call = webhooks.find((w) => w.event === 'call');
    expect(call.data.id).toBe(CALL_ID);
  });

  it('marks an event Evolution emits itself (the call message), so a replay does not emit it twice', async () => {
    process.env.LIVE_RECORD_DIR = root;
    await playSession(await connected({ msgCall: 'In a meeting' }));
    const emits = lines(join(sessionDir(), 'events.ndjson')).filter((e) => e.event);
    const fromApp = emits.filter((e) => e.origin === 'app');
    expect(fromApp.map((e) => e.event)).toEqual(['messages.upsert']);
    expect(decode(fromApp[0].data).messages[0].message.conversation).toBe('In a meeting');
  });

  it('writes a manifest of versions and conditions, with no number, JID or name in it', async () => {
    process.env.LIVE_RECORD_DIR = root;
    const service = await connected();
    const dir = sessionDir();
    const atStart = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(atStart.openedAt).toBeNull();
    expect(atStart.phonePlatform).toBeNull();

    await playSession(service);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const baileys = JSON.parse(readFileSync(join(process.env.BAILEYS_RESOLVED_DIR, 'package.json'), 'utf8')).version;
    expect(manifest).toEqual({
      format: 'live-record/1',
      forkCommit: expect.stringMatching(/^[0-9a-f]{8}(-dirty)?$/),
      baileysVersion: baileys,
      nodeVersion: process.version,
      waWebVersion: '2.3000.1',
      phonePlatform: 'smba',
      accountType: 'business',
      linkMethod: 'qr',
      proxy: { used: false, protocol: null },
      sockets: 1,
      startedAt: atStart.startedAt,
      openedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      endedAt: null,
    });
    const text = JSON.stringify(manifest);
    for (const secret of [
      '972529998877',
      '987654321098765',
      '972541112233',
      '123456789012345',
      OWNER.name,
      PERSON.saved,
      '@',
    ]) {
      expect(text).not.toContain(secret);
    }
    // The account is kept apart, for the scrubber only.
    expect(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'))).toEqual(OWNER);
  });

  it('records the link method a pairing code asked for, without the number', async () => {
    process.env.LIVE_RECORD_DIR = root;
    const { service } = await makeService();
    stubAuthState(service);
    await service.connectToWhatsapp('972541112233');
    const manifest = readFileSync(join(sessionDir(), 'manifest.json'), 'utf8');
    expect(JSON.parse(manifest).linkMethod).toBe('code');
    expect(manifest).not.toContain('972541112233');
  });

  it('records that a proxy was used and its protocol, never its address', async () => {
    process.env.LIVE_RECORD_DIR = root;
    await connectBehind(socketSpy, { protocol: 'socks5', port: 18461 });
    const manifest = readFileSync(join(sessionDir(), 'manifest.json'), 'utf8');
    expect(JSON.parse(manifest).proxy).toEqual({ used: true, protocol: 'socks5' });
    expect(manifest).not.toContain('127.0.0.1');
    expect(manifest).not.toContain('18461');
  });

  // The QR payload and the pairing code link a device to the account: whoever has one can pair it.
  // The events tape redacted the QR; the webhook tape wrote qrcode.updated as Evolution sent it,
  // code, image and pairing code included.
  describe('a link in progress', () => {
    const QR = '2@Q1R2S3T4U5V6W7X8Y9Z0qrsecret,keypart,otherpart,lastpart';
    const PAIRING = 'WXYZ4321';

    async function showQr(number?: string) {
      process.env.LIVE_RECORD_DIR = root;
      socketSpy.mockImplementationOnce((config: any) => ({
        ...fakeSocket(config),
        requestPairingCode: async () => PAIRING,
      }));
      const { service } = await makeService();
      stubAuthState(service);
      await service.connectToWhatsapp(number);
      service.client.ev.emit('connection.update', { qr: QR });
      await vi.waitFor(() => expect(emitted.some((e) => e.event === 'qrcode.updated')).toBe(true), { timeout: 5_000 });
      const sentQr = emitted.find((e) => e.event === 'qrcode.updated').data.qrcode;
      const dir = sessionDir();
      const tapes = ['events.ndjson', 'webhooks.ndjson'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
      return { sentQr, tapes };
    }

    it('never writes the QR payload or its image, in either tape', async () => {
      const { sentQr, tapes } = await showQr();
      // Evolution still sends them: only the recording leaves them out.
      expect(sentQr.code).toBe(QR);
      expect({ code: tapes.includes('qrsecret'), image: tapes.includes(sentQr.base64.slice(22, 80)) }).toEqual({
        code: false,
        image: false,
      });
    });

    it('never writes the pairing code, in either tape', async () => {
      const { sentQr, tapes } = await showQr('972541112233');
      expect(sentQr.pairingCode).toBe(PAIRING);
      expect({ pairingCode: tapes.includes(PAIRING), code: tapes.includes('qrsecret') }).toEqual({
        pairingCode: false,
        code: false,
      });
    });
  });

  // The recorder is prepared right after the socket is built and before Evolution listens to it.
  // Creating its directory and first manifest was outside its guard, so a LIVE_RECORD_DIR that
  // cannot be written (no permission, a full volume, a file in the way) failed the connect with a
  // socket already built and nobody listening to it.
  it('a recording directory that cannot be created costs the recording only, never the connection', async () => {
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'a file where the directory should go');
    process.env.LIVE_RECORD_DIR = join(blocked, 'records');
    socketSpy.mockClear();
    const { service } = await makeService();
    stubAuthState(service);
    const outcome = await service.connectToWhatsapp().then(
      () => 'connected',
      (e: any) => `failed: ${e?.message}`,
    );
    const sock = socketSpy.mock.results[0]?.value;
    expect({ outcome, listened: sock?.handlers?.() > 0 }).toEqual({ outcome: 'connected', listened: true });
  });

  it('a manifest that can no longer be written when a socket is attached stops the recording, not the socket', async () => {
    process.env.LIVE_RECORD_DIR = root;
    const { LiveRecorder } = await import('@utils/live-record/recorder');
    const recorder = LiveRecorder.start('test');
    const manifest = join(recorder.dir, 'manifest.json');
    chmodSync(manifest, 0o400);
    try {
      expect(() =>
        recorder.attach(fakeSocket(), {
          waWebVersion: '2.3000.1',
          linkMethod: 'qr',
          proxyProtocol: null,
          creds: () => ({}),
        }),
      ).not.toThrow();
    } finally {
      chmodSync(manifest, 0o600);
    }
  });
});
