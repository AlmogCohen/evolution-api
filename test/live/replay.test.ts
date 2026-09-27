// A scrubbed live-check fixture replays through the real event buffer into the
// real BaileysStartupService, and what Evolution sends must match the golden
// webhooks the live session recorded (scrubbed with the same identity table).
// This is the end-to-end proof of the chain: record, scrub, replay.
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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeSocket } from '../helpers/connect';
import { emitted } from '../helpers/fake-server-module';
import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';
import { recordSession } from '../helpers/live-session';
import { scrubSession } from '../tools/live-scrub';

socketSpy.mockImplementation(fakeSocket);

let root: string;
let fixture: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'live-replay-'));
  const raw = await recordSession(join(root, 'raw'));
  fixture = scrubSession(raw, {
    checkId: 'synthetic-session',
    date: '2026-09-27',
    outRoot: join(root, 'fixtures'),
  }).dir;
  emitted.splice(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('live-check replay', () => {
  it('replays a scrubbed session through the real buffer and service, and reproduces its webhooks', async () => {
    const { webhooks } = await replayFixture(fixture);
    expect(webhooks.map((w) => w.event)).toContain('messages.upsert');
    expect(compareGolden(webhooks, loadFixture(fixture).webhooks)).toEqual([]);
  });

  it('delivers the batches the live buffer delivered', async () => {
    const { batches } = await replayFixture(fixture);
    const recorded = loadFixture(fixture)
      .events.filter((e) => e.batch)
      .map((e) => e.batch);
    expect(batches).toEqual(recorded);
  });

  it('fails the golden comparison when what Evolution sends differs', async () => {
    const file = join(fixture, 'webhooks.ndjson');
    const golden = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const upsert = golden.find((w) => w.event === 'messages.upsert');
    upsert.data.key.remoteJidAlt = upsert.data.key.remoteJid; // what 2.3.7 sent: the phone twice
    writeFileSync(file, golden.map((w) => JSON.stringify(w)).join('\n') + '\n');

    const { webhooks } = await replayFixture(fixture);
    const diff = compareGolden(webhooks, loadFixture(fixture).webhooks);
    expect(diff).toHaveLength(2);
    expect(diff.join('\n')).toMatch(/missing messages\.upsert/);
    expect(diff.join('\n')).toMatch(/unexpected messages\.upsert/);
  });

  // A batch line on the tape is what the buffer delivered live. A non-bufferable event (a
  // connection.update) emitted while the buffer holds others is delivered at once, as its own
  // batch, and the buffer keeps holding the rest. The replay flushed the buffer on every batch line,
  // so it split what the live buffer delivered as one batch.
  it('delivers the batches the tape recorded, a non-bufferable event inside a buffer included', async () => {
    const dir = join(root, 'interleaved');
    mkdirSync(dir);
    const contact = (name: string) => [{ id: '972500000001@s.whatsapp.net', notify: name }];
    const lines = [
      { seq: 1, t: 1, socket: 1, event: 'contacts.upsert', buffered: true, data: contact('Name 1') },
      { seq: 2, t: 2, socket: 1, event: 'connection.update', buffered: true, data: { isOnline: true } },
      { seq: 3, t: 3, socket: 1, batch: ['connection.update'] },
      { seq: 4, t: 4, socket: 1, event: 'contacts.update', buffered: true, data: contact('Name 2') },
      { seq: 5, t: 5, socket: 1, batch: ['contacts.upsert', 'contacts.update'] },
    ];
    writeFileSync(join(dir, 'events.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(dir, 'webhooks.ndjson'), '');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'live-record/1' }));

    const { batches } = await replayFixture(dir);
    expect(batches).toEqual(lines.filter((l) => l.batch).map((l) => l.batch));
  });
});
