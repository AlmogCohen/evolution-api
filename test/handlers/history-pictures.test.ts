// Evolution handles events one batch at a time (eventProcessingQueue), and
// its messaging-history.set handler awaited contacts.upsert, which awaited a
// profile picture lookup for every contact in the batch before returning. A
// first link brings hundreds of new contacts, so the next history batch and
// every live message waited behind hundreds of picture IQs.
//
// The history batch goes out as soon as it is read; the pictures follow on
// contacts.update when their lookups finish, and those lookups never take the
// last query slot, so a live sender's lookup does not queue behind them.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { historyEvent, msg } from '../helpers/baileys-fixtures';
import { deliver, makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const INITIAL_BOOTSTRAP = 0;
const RECENT = 3;
const MAX_IN_FLIGHT = 4;

const jid = (i: number) => `9725${String(i).padStart(8, '0')}@s.whatsapp.net`;
const url = (j: string) => `https://pps.whatsapp.test/${j.split('@')[0]}.jpg`;
const LIVE = jid(900);

const of = (event: string) => emitted.filter((e) => e.event === event);
const itemsFor = (event: string, j: string) =>
  of(event)
    .flatMap((e) => [].concat(e.data))
    .filter((c: any) => c?.remoteJid === j);

async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

const incoming = (j: string, id: string, pushName: string) => ({
  'messages.upsert': { messages: [{ ...msg(j, id, 'hi').message, pushName }], type: 'notify' },
  'contacts.update': [{ id: j, notify: pushName, verifiedName: undefined }],
});

/** Emit a batch the way the socket does, without waiting for Evolution to handle it. */
async function emit(ev: any, events: Record<string, any>) {
  ev.buffer();
  for (const [name, payload] of Object.entries(events)) ev.emit(name, payload);
  await ev.flush();
}

const history = (syncType: number, jids: string[]) => ({
  'messaging-history.set': historyEvent({
    syncType,
    progress: 50,
    conversations: jids.map((j, i) => ({ id: j, name: `Contact ${j.slice(8, 12)}`, messages: [msg(j, `H${j.slice(8, 12)}${i}`, 'hi')] })),
  }),
});

describe('history and live messages never wait on profile picture lookups', () => {
  let open = () => undefined as void;
  beforeEach(() => void emitted.splice(0));
  // A failing run must not leave lookups hanging on a closed gate.
  afterEach(() => open());

  it('a history batch with slow picture lookups holds up neither the next batch nor a live message', async () => {
    const FIRST = Array.from({ length: 30 }, (_, i) => jid(i));
    const SECOND = Array.from({ length: 30 }, (_, i) => jid(100 + i));
    const HISTORY = new Set([...FIRST, ...SECOND]);
    const { service, ev } = await makeService();
    await deliver(service, ev, {}); // wire the handlers

    // History contacts' lookups hang until the gate opens; any other lookup answers at once.
    const gate = new Promise<void>((r) => (open = r));
    const state = { inFlight: 0, maxInFlight: 0 };
    const lookup = vi.fn(async (j: string) => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (HISTORY.has(j)) await gate;
      else await new Promise((r) => setTimeout(r, 1));
      state.inFlight--;
      return url(j);
    });
    service.client.profilePictureUrl = lookup;

    await emit(ev, history(INITIAL_BOOTSTRAP, FIRST));
    await emit(ev, history(RECENT, SECOND));
    await emit(ev, incoming(LIVE, 'L1', 'Live'));
    await emit(ev, incoming(LIVE, 'L2', 'Live'));

    // Everything arrives while not one history picture has been answered.
    await until(() => of('messages.set').length === 2, 'both history batches');
    await until(() => of('messages.upsert').length === 2, 'both live messages');
    await until(() => itemsFor('contacts.update', LIVE).length === 2, "the live sender's contact payloads");
    expect(of('messages.upsert').map((e) => e.data.key.id)).toEqual(['L1', 'L2']);
    for (const j of HISTORY) expect(itemsFor('contacts.upsert', j)).toHaveLength(1);
    // The live sender's picture was looked up beside the stalled history lookups, not behind them.
    expect(itemsFor('contacts.update', LIVE).map((c: any) => c.profilePicUrl)).toEqual([url(LIVE), url(LIVE)]);
    for (const j of HISTORY) expect(itemsFor('contacts.update', j)).toEqual([]);
    expect(state.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);

    // The pictures follow on contacts.update once WhatsApp answers, one lookup per contact.
    open();
    await until(() => [...HISTORY].every((j) => itemsFor('contacts.update', j).length === 1), 'the history pictures');
    await settle(service);
    for (const j of HISTORY) expect(itemsFor('contacts.update', j).map((c: any) => c.profilePicUrl)).toEqual([url(j)]);
    expect(lookup.mock.calls.filter(([j]) => HISTORY.has(j))).toHaveLength(HISTORY.size);
    expect(state.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  });
});
