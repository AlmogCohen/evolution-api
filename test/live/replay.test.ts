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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  fixture = scrubSession(raw, { checkId: 'synthetic-session', date: '2026-09-27', outRoot: join(root, 'fixtures') }).dir;
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
    const golden = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const upsert = golden.find((w) => w.event === 'messages.upsert');
    upsert.data.key.remoteJidAlt = upsert.data.key.remoteJid; // what 2.3.7 sent: the phone twice
    writeFileSync(file, golden.map((w) => JSON.stringify(w)).join('\n') + '\n');

    const { webhooks } = await replayFixture(fixture);
    const diff = compareGolden(webhooks, loadFixture(fixture).webhooks);
    expect(diff).toHaveLength(2);
    expect(diff.join('\n')).toMatch(/missing messages\.upsert/);
    expect(diff.join('\n')).toMatch(/unexpected messages\.upsert/);
  });
});
