// Replays a scrubbed live-check fixture (test/fixtures/live/<date>-<check-id>/)
// through Baileys' real event buffer into the real BaileysStartupService, and
// compares what Evolution sends with the webhooks the live session recorded.
//
// The replay follows the tape: an event the buffer held is emitted inside a
// buffer, a batch line flushes it, an event Evolution emitted itself
// (origin: app) is left for the replayed Evolution to emit again, and events
// from a socket Evolution had already replaced are skipped (it ignored them
// live). Socket queries (profile pictures, group metadata, LID lookups) were
// not recorded: they answer as the harness does unless a test passes `client`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decode, encode } from '@utils/live-record/codec';

import { makeService, settle } from './baileys-service';
import { emitted } from './fake-server-module';
import type { Profile } from './profiles';

type Line = Record<string, any>;

const readLines = (file: string): Line[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

export function loadFixture(dir: string) {
  return {
    events: readLines(join(dir, 'events.ndjson')),
    webhooks: readLines(join(dir, 'webhooks.ndjson')),
    manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
  };
}

export async function replayFixture(dir: string, opts: { profile?: Profile; client?: Record<string, any> } = {}) {
  const { events, manifest } = loadFixture(dir);
  const { service, ev, prisma } = await makeService({ profile: opts.profile });
  if (manifest.replay?.owner?.id) service.client.user = manifest.replay.owner;
  Object.assign(service.client, opts.client);
  // A close must not build a real socket.
  service.connectToWhatsapp = async () => service.client;
  service.scheduleReconnect = () => undefined;

  const batches: string[][] = [];
  ev.process((batch: Record<string, any>) => void batches.push(Object.keys(batch)));
  service.eventHandler();
  service.__wired = true;
  const start = emitted.length;

  // Live, each batch was handled before the next one arrived.
  const flush = async () => {
    if (ev.isBuffering()) ev.flush();
    await service.eventProcessingQueue;
  };
  let socket = 0;
  for (const line of events) {
    if (line.socket < socket) continue;
    socket = line.socket;
    if (line.batch) {
      await flush();
      continue;
    }
    if (line.origin === 'app') continue;
    if (!line.buffered) await flush();
    if (line.buffered && !ev.isBuffering()) ev.buffer();
    ev.emit(line.event, decode(line.data));
  }
  await flush();
  await settle(service);
  return { service, prisma, batches, webhooks: emitted.slice(start) };
}

/** Fields Evolution fills from the clock, the database or a socket query: not part of the comparison. */
export const VOLATILE = ['dateTime', 'date_time', 'createdAt', 'updatedAt', 'instanceId', 'profilePicUrl', 'profilePictureUrl'];

function normalize(value: any, volatile: Set<string>): any {
  if (Array.isArray(value)) return value.map((v) => normalize(v, volatile));
  if (!value || typeof value !== 'object') return value;
  if ('$bytes' in value) return { $bytes: value.$bytes, as: value.as }; // the scrubber tags fakes
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = volatile.has(k) ? '<volatile>' : normalize(v, volatile);
  return out;
}

/**
 * The differences between what the replay sent and the golden webhooks, as
 * "missing <event>" / "unexpected <event>" lines; empty when they match. The
 * comparison is of the two multisets, since background lookups interleave.
 * `events` limits it to those event names (webhooks a live API call caused have
 * no event on the tape).
 */
export function compareGolden(
  actual: { event: string; data: any }[],
  golden: Line[],
  opts: { events?: string[]; volatile?: string[] } = {},
) {
  const volatile = new Set([...VOLATILE, ...(opts.volatile ?? [])]);
  const keep = (event: string) => !opts.events || opts.events.includes(event);
  const canon = (event: string, encoded: any) => JSON.stringify({ event, data: normalize(encoded, volatile) });
  const want = golden.filter((w) => keep(w.event)).map((w) => canon(w.event, w.data));
  const got = actual.filter((w) => keep(w.event)).map((w) => canon(w.event, encode(w.data)));

  const diff: string[] = [];
  const left = [...got];
  for (const w of want) {
    const i = left.indexOf(w);
    if (i >= 0) left.splice(i, 1);
    else diff.push(`missing ${JSON.parse(w).event}: ${w}`);
  }
  for (const g of left) diff.push(`unexpected ${JSON.parse(g).event}: ${g}`);
  return diff;
}
