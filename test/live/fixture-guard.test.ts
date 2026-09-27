// Nothing personal may reach the repository through a live-check fixture. The
// scrubber's leak gate checks its own output against the originals it saw; this
// guard is the second, independent check, run on every commit: it scans every
// file under test/fixtures/live/ for what personal data looks like, knowing only
// the scrubber's fake ranges. A finding names the file, the line, the path and
// the kind of value, never the value.
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

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeSocket } from '../helpers/connect';
import { recordSession } from '../helpers/live-session';
import { formatFindings, scanFixtures } from '../tools/fixture-guard';
import { scrubSession } from '../tools/live-scrub';

socketSpy.mockImplementation(fakeSocket);

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), 'live-guard-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PLANTED = {
  phone: '972541112233',
  pnJid: '972541112233:3@s.whatsapp.net',
  lidJid: '123456789012345@lid',
  url: 'https://mmg.whatsapp.net/v/t62.7118-24/19_A.enc?ccb=11-4&oh=01_Q5AaIBq&oe=68D1A2B3',
  email: 'dana.levi@gmail.com',
  bytes: 'q83vEjRWeJq8Dd7wESIzRFVmd4iZqrvM3e7/ABEiM0Q=',
};

describe('live fixture guard', () => {
  it('finds every kind of leak in a planted fixture, and never prints the value', () => {
    const dir = join(root, 'live', '2026-09-27-planted');
    mkdirSync(dir, { recursive: true });
    const clean = { seq: 1, event: 'contacts.upsert', data: [{ id: '972500000001@s.whatsapp.net', name: 'Name 2' }] };
    const lines = [
      clean,
      { seq: 2, event: 'messages.upsert', data: { text: `call me on ${PLANTED.phone}` } },
      { seq: 3, event: 'contacts.upsert', data: [{ id: PLANTED.pnJid, lid: PLANTED.lidJid }] },
      { seq: 4, event: 'messages.upsert', data: { imageMessage: { url: PLANTED.url } } },
      { seq: 5, event: 'contacts.update', data: [{ about: `write to ${PLANTED.email}` }] },
      { seq: 6, event: 'messages.upsert', data: { mediaKey: { $bytes: PLANTED.bytes, as: 'Uint8Array' } } },
      { seq: 7, event: 'messages.upsert', data: { jpegThumbnail: PLANTED.bytes } },
      {
        seq: 8,
        event: 'presence.update',
        data: { presences: { [PLANTED.pnJid]: { lastKnownPresence: 'available' } } },
      },
    ];
    writeFileSync(join(dir, 'events.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ note: `owner ${PLANTED.phone}` }));

    const findings = scanFixtures(join(root, 'live'));
    const kinds = findings.map((f) => `${f.file}:${f.line} ${f.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/events\.ndjson:2 phone-like digit run/),
        expect.stringMatching(/events\.ndjson:3 address not in the fake ranges/),
        expect.stringMatching(/events\.ndjson:4 signed media URL/),
        expect.stringMatching(/events\.ndjson:5 email address/),
        expect.stringMatching(/events\.ndjson:6 bytes not tagged fake/),
        expect.stringMatching(/events\.ndjson:7 base64 blob/),
        expect.stringMatching(/events\.ndjson:8 address not in the fake ranges/),
        expect.stringMatching(/manifest\.json:1 phone-like digit run/),
      ]),
    );
    // The clean line is clean.
    expect(findings.some((f) => f.file.endsWith('events.ndjson') && f.line === 1)).toBe(false);

    const report = formatFindings(findings);
    for (const value of [...Object.values(PLANTED), '972541112233', '123456789012345', 'dana.levi']) {
      expect(report.includes(value), `the report printed a planted value of ${value.length} chars`).toBe(false);
    }
  });

  it('reads a long camelCase identifier as a name, not a base64 blob', () => {
    const dir = join(root, 'live', '2026-09-27-identifiers');
    mkdirSync(dir, { recursive: true });
    const lines = [
      // Baileys' own key names: creds keys, proto fields.
      { seq: 1, event: 'connection.update', data: { receivedPendingNotifications: true } },
      {
        seq: 2,
        event: 'creds.update',
        data: { $redacted: 'creds', keys: ['processedHistoryMessages', 'lastAccountSyncTimestamp'] },
      },
      { seq: 3, event: 'messages.upsert', data: { message: { axolotlSenderKeyDistributionMessage: {} } } },
      // A blob of letters only, not identifier-shaped, is still a blob.
      {
        seq: 4,
        event: 'messages.upsert',
        data: { thumb: 'QmFzZVNpeHRyRmxvYkxldHRlcnNPbmxWWFpBQkNE' },
      },
    ];
    writeFileSync(join(dir, 'events.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const findings = scanFixtures(join(root, 'live'));
    expect(findings.filter((f) => f.line <= 3)).toEqual([]);
    expect(findings).toContainEqual(expect.objectContaining({ line: 4, kind: 'base64 blob' }));
  });

  it("accepts the scrubber's fake numeric message id, and nothing else numeric under an id", () => {
    const dir = join(root, 'live', '2026-09-27-numeric-ids');
    mkdirSync(dir, { recursive: true });
    const stub = (seq: number, id: string) => ({
      seq,
      event: 'messages.upsert',
      data: { messages: [{ key: { remoteJid: '120363000000000001@g.us', id }, messageStubType: 20 }] },
    });
    const lines = [stub(1, '740000002'), stub(2, '4100000013'), stub(3, PLANTED.phone), stub(4, '834726190')];
    writeFileSync(join(dir, 'events.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const flagged = scanFixtures(join(root, 'live')).map((f) => `${f.line} ${f.kind}`);
    expect(flagged).toEqual(['3 phone-like digit run', '4 phone-like digit run']);
  });

  it('passes the scrubber output of a recorded session', async () => {
    const raw = await recordSession(join(root, 'raw'));
    // Group notifications carry numeric message ids; the creds keys are long identifiers.
    const extra = [
      {
        seq: 998,
        t: 1,
        socket: 1,
        event: 'creds.update',
        buffered: false,
        data: { $redacted: 'creds', keys: ['processedHistoryMessages'] },
      },
      {
        seq: 999,
        t: 1,
        socket: 1,
        event: 'messages.upsert',
        buffered: false,
        data: {
          type: 'append',
          messages: [
            { key: { remoteJid: '120363401234567890@g.us', fromMe: false, id: '834726190' }, messageStubType: 20 },
          ],
        },
      },
    ];
    appendFileSync(join(raw, 'events.ndjson'), extra.map((l) => JSON.stringify(l)).join('\n') + '\n');
    scrubSession(raw, { checkId: 'synthetic-session', date: '2026-09-27', outRoot: join(root, 'live') });
    expect(formatFindings(scanFixtures(join(root, 'live')))).toBe('');
  });

  it('passes every fixture committed under test/fixtures/live/', () => {
    const findings = scanFixtures(join(process.cwd(), 'test', 'fixtures', 'live'));
    expect(formatFindings(findings)).toBe('');
  });
});
