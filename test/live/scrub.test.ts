// A raw recording holds real numbers, names, texts and keys. The scrubber turns
// it into a fixture that can be committed: every identity replaced by a stable
// fake (one person keeps one index across phone JID, @lid and device suffix),
// the shapes Evolution reads kept (lengths, id prefixes, byte types), and then a
// leak gate that searches the output for every original and writes nothing when
// one survives.
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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decode } from '@utils/live-record/codec';

import { fakeSocket } from '../helpers/connect';
import { emitted } from '../helpers/fake-server-module';
import { MESSAGE_ID, MESSAGE_SECRET, ORIGINALS, PERSON, recordSession, TEXT } from '../helpers/live-session';
import { leakGate, scrubSession, UnknownFieldError } from '../tools/live-scrub';

socketSpy.mockImplementation(fakeSocket);

let root: string;
let raw: string;
let out: string;
beforeEach(async () => {
  emitted.splice(0);
  root = mkdtempSync(join(tmpdir(), 'live-scrub-'));
  raw = await recordSession(join(root, 'raw'));
  out = join(root, 'fixtures');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const scrub = (extra: Partial<Parameters<typeof scrubSession>[1]> = {}) =>
  scrubSession(raw, { checkId: 'synthetic-session', date: '2026-09-27', outRoot: out, ...extra });

describe('live-check scrubber', () => {
  it('writes the fixture files under <date>-<check-id>, and never the raw owner file', () => {
    const { dir } = scrub();
    expect(dir).toBe(join(out, '2026-09-27-synthetic-session'));
    expect(readdirSync(dir).sort()).toEqual(['events.ndjson', 'manifest.json', 'scrub-report.json', 'webhooks.ndjson']);
  });

  it('leaves no original anywhere in the fixture', () => {
    const { dir } = scrub();
    const text = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    for (const original of ORIGINALS)
      expect(text.includes(original), `an original of ${original.length} chars`).toBe(false);
  });

  it('gives one person one fake across phone JID, @lid and device suffix, in both tapes', () => {
    const { dir } = scrub();
    const emits = lines(join(dir, 'events.ndjson')).filter((e) => e.event);
    const [contact] = decode(emits.find((e) => e.event === 'contacts.upsert').data);
    expect(contact.id).toMatch(/^972500\d{6}@s\.whatsapp\.net$/);
    const index = contact.id.slice(6, 12);
    expect(contact.lid).toBe(`100000000${index}@lid`);
    expect(index).not.toBe('000000'); // index 0 is the owner

    const upsert = decode(emits.find((e) => e.event === 'messages.upsert').data).messages[0];
    expect(upsert.key.remoteJid).toBe(contact.lid);
    expect(upsert.key.remoteJidAlt).toBe(contact.id);

    // The owner is index 0, device suffix kept.
    const webhooks = lines(join(dir, 'webhooks.ndjson'));
    const open = webhooks.find((w) => w.event === 'connection.update' && w.data.state === 'open');
    expect(open.data.wuid).toBe('972500000000@s.whatsapp.net');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.replay.owner.id).toBe('972500000000:14@s.whatsapp.net');
    expect(manifest.replay.owner.lid).toBe('100000000000000:14@lid');

    // Evolution showed the phone JID as remoteJid and kept the @lid: the same fakes.
    const sent = decode(webhooks.find((w) => w.event === 'messages.upsert').data);
    expect(sent.key.remoteJid).toBe(contact.id);
    expect(sent.key.remoteJidAlt).toBe(contact.lid);
  });

  it('keeps name equality, id shape, byte length and type, and text length', () => {
    const { dir } = scrub();
    const emits = lines(join(dir, 'events.ndjson')).filter((e) => e.event);
    const [contact] = decode(emits.find((e) => e.event === 'contacts.upsert').data);
    const message = decode(emits.find((e) => e.event === 'messages.upsert').data).messages[0];

    // Saved name and profile name stay different; the same profile name stays the same.
    expect(contact.name).not.toBe(contact.notify);
    expect(contact.name).not.toBe(PERSON.saved);
    expect(message.pushName).toBe(contact.notify);

    expect(message.key.id).toHaveLength(MESSAGE_ID.length);
    expect(message.key.id.slice(0, 2)).toBe(MESSAGE_ID.slice(0, 2));
    expect(message.key.id).not.toBe(MESSAGE_ID);

    const secret = message.message.messageContextInfo.messageSecret;
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(secret)).toBe(false);
    expect(secret.length).toBe(MESSAGE_SECRET.length);
    expect(Buffer.from(secret).equals(MESSAGE_SECRET)).toBe(false);

    expect(message.message.conversation).toHaveLength(TEXT.length);
    expect(message.message.conversation).not.toBe(TEXT);

    // The webhook carries the same fakes as the event it came from.
    const sent = decode(lines(join(dir, 'webhooks.ndjson')).find((w) => w.event === 'messages.upsert').data);
    expect(sent.key.id).toBe(message.key.id);
    expect(sent.pushName).toBe(message.pushName);
    expect(sent.message.conversation).toBe(message.message.conversation);
    expect(Buffer.from(sent.message.messageContextInfo.messageSecret).equals(Buffer.from(secret))).toBe(true);
  });

  it('adds what the operator records, and a report of counts only', () => {
    const { dir } = scrub({
      operator: {
        phoneModel: 'Pixel 8',
        osVersion: 'Android 15',
        whatsappAppVersion: '2.25.27.78',
        countryCode: '972',
      },
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      checkId: 'synthetic-session',
      date: '2026-09-27',
      phoneModel: 'Pixel 8',
      osVersion: 'Android 15',
      whatsappAppVersion: '2.25.27.78',
      countryCode: '972',
      phonePlatform: 'smba',
      waWebVersion: '2.3000.1',
    });
    const report = JSON.parse(readFileSync(join(dir, 'scrub-report.json'), 'utf8'));
    expect(report.leakGate).toBe('pass');
    const numbers = Object.entries(report).filter(([k]) => k !== 'leakGate');
    expect(numbers.length).toBeGreaterThan(0);
    for (const [, value] of numbers) expect(typeof value).toBe('number');
    expect(report.people).toBe(2);
  });

  it('keeps a numeric message id a message id, never a person', () => {
    // WhatsApp gives group notifications (a create, a rename, an add) numeric ids.
    const id = '8347261905';
    const stub = {
      seq: 999,
      t: 1,
      socket: 1,
      event: 'messages.upsert',
      buffered: false,
      data: {
        type: 'append',
        messages: [{ key: { remoteJid: '120363401234567890@g.us', fromMe: false, id }, messageStubType: 20 }],
      },
    };
    appendFileSync(join(raw, 'events.ndjson'), JSON.stringify(stub) + '\n');
    const { dir, report } = scrub();

    const line = lines(join(dir, 'events.ndjson')).find((e) => e.seq === 999);
    const fake = line.data.messages[0].key.id;
    expect(fake).toMatch(/^\d+$/);
    expect(fake).toHaveLength(id.length);
    expect(fake.slice(0, 2)).toBe(id.slice(0, 2));
    expect(fake).not.toBe(id);
    expect(report.people).toBe(2);
    expect(report.messageIds).toBeGreaterThan(0);
  });

  it('takes a country code only, never a number', () => {
    expect(() => scrub({ operator: { countryCode: '972541112233' } })).toThrow(/country code/);
    expect(existsSync(join(out, '2026-09-27-synthetic-session'))).toBe(false);
  });

  it('aborts and writes nothing when an original survives the rewrite', () => {
    // An object key is kept as written unless it is an address: plant a saved name there.
    const planted = { seq: 999, t: 1, socket: 1, event: 'labels.edit', buffered: false, data: { [PERSON.saved]: 1 } };
    appendFileSync(join(raw, 'events.ndjson'), JSON.stringify(planted) + '\n');
    let message = '';
    try {
      scrub();
    } catch (error) {
      message = String(error?.message);
    }
    expect(message).toMatch(/leak gate/i);
    expect(message).toContain('events.ndjson');
    for (const original of ORIGINALS) expect(message.includes(original)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  // A string was kept as written whenever it looked like an identifier, whatever its field, and a
  // decimal number always was: a username, a group name in a stub parameter, a value in a field the
  // scrubber had never seen, a location. The leak gate searched only for what the scrubber replaced.
  describe('what it cannot tell from structure', () => {
    const plant = (data: any) =>
      appendFileSync(
        join(raw, 'events.ndjson'),
        JSON.stringify({ seq: 999, t: 1, socket: 1, event: 'messages.upsert', buffered: false, data }) + '\n',
      );
    const fixtureText = (dir: string) =>
      readdirSync(dir)
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('\n');

    it('replaces a username, wherever the same value appears', () => {
      const username = 'dana.levi88';
      plant({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: PERSON.lid, remoteJidUsername: username, fromMe: false, id: MESSAGE_ID },
            message: { conversation: `my handle is ${username}` },
          },
        ],
      });
      const { dir } = scrub();
      expect(fixtureText(dir).includes(username)).toBe(false);
    });

    it('replaces the text of a stub parameter', () => {
      const groupName = 'dana_and_friends';
      plant({
        type: 'append',
        messages: [
          {
            key: { remoteJid: '120363401234567890@g.us', fromMe: false, id: '8347261905' },
            messageStubType: 21,
            messageStubParameters: [groupName],
          },
        ],
      });
      const { dir } = scrub();
      expect(fixtureText(dir).includes(groupName)).toBe(false);
    });

    it('replaces a location', () => {
      plant({
        type: 'notify',
        messages: [
          {
            key: { remoteJid: PERSON.lid, fromMe: false, id: MESSAGE_ID },
            message: { locationMessage: { degreesLatitude: 32.0853, degreesLongitude: 34.7818 } },
          },
        ],
      });
      const { dir } = scrub();
      const text = fixtureText(dir);
      expect({ latitude: text.includes('32.0853'), longitude: text.includes('34.7818') }).toEqual({
        latitude: false,
        longitude: false,
      });
    });

    it('stops on a field it does not know, names its path, and writes nothing', () => {
      plant({ type: 'notify', messages: [], someFutureField: 'dana.levi' });
      let message = '';
      try {
        scrub();
      } catch (error) {
        message = String(error?.message);
      }
      expect(message).toMatch(/unknown field .*someFutureField/);
      expect(message.includes('dana.levi')).toBe(false);
      expect(existsSync(out)).toBe(false);
    });
  });

  it('its leak gate reads the raw tapes itself: a value the scrubber had kept still fails it', () => {
    const line = {
      seq: 1,
      t: 1,
      socket: 1,
      event: 'messages.upsert',
      data: { messages: [{ key: { remoteJidUsername: 'dana.levi88' } }] },
    };
    const raw = { events: [line], webhooks: [], instanceName: 'rig' };
    // As if a rewrite had kept every value.
    expect(leakGate(raw, { 'events.ndjson': JSON.stringify(line) + '\n' })).toEqual(['events.ndjson line 1']);
    // Structure it keeps is not a leak.
    const structure = { seq: 1, t: 1.5, socket: 1, event: 'connection.update', data: { connection: 'open' } };
    const clean = { events: [structure], webhooks: [], instanceName: 'rig' };
    expect(leakGate(clean, { 'events.ndjson': JSON.stringify(structure) + '\n' })).toEqual([]);
  });

  it('knows every field of every committed fixture', () => {
    // A committed fixture has the raw tapes' shape: scrubbing it again must not meet an unknown field.
    const root = join(process.cwd(), 'test', 'fixtures', 'live');
    for (const fixture of readdirSync(root)) {
      const again = join(tmpdir(), `live-rescrub-${process.pid}`, 'test', fixture);
      mkdirSync(again, { recursive: true });
      for (const file of ['events.ndjson', 'webhooks.ndjson', 'manifest.json']) {
        writeFileSync(join(again, file), readFileSync(join(root, fixture, file)));
      }
      let error: unknown;
      try {
        scrubSession(again, { checkId: 'rescrub', date: '2026-09-27', outRoot: join(again, 'out') });
      } catch (e) {
        error = e; // Its fakes are originals now, so the leak gate may object; an unknown field may not.
      }
      rmSync(join(tmpdir(), `live-rescrub-${process.pid}`), { recursive: true, force: true });
      expect(
        error instanceof UnknownFieldError ? `${fixture}: ${(error as Error).message}` : undefined,
      ).toBeUndefined();
    }
  });
});
