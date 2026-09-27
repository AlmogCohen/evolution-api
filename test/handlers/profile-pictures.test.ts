// Evolution asks WhatsApp for a contact's profile picture (one IQ each) on
// every contacts.upsert, every contacts.update and every inbound message, and
// for every group on every fetchAllGroups. Baileys 7.0.0-rc14 emits a
// contacts.update for every inbound message that carries a pushName
// (chats.js upsertMessage), so a live message costs two picture IQs, and a
// history batch of N contacts fires N of them at once (Promise.all). At link
// time that is thousands of IQs in a burst from a device that has just linked.
//
// A lookup is kept per jid for a while, a jid already being looked up is not
// looked up again, and only a few lookups run at once. The webhook payloads
// keep their profilePicUrl, served from what was looked up. WhatsApp says when
// a picture changes (a `picture` notification, which Baileys emits as
// contacts.update with imgUrl 'changed' or 'removed'), and that refreshes it.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { historyEvent, msg } from '../helpers/baileys-fixtures';
import { deliver, makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const INITIAL_BOOTSTRAP = 0;
const PUSH_NAME = 4;
const HOUR = 60 * 60 * 1000;
/** The most picture lookups the service may have in flight at once. */
const MAX_IN_FLIGHT = 4;

const jid = (i: number) => `9725${String(i).padStart(8, '0')}@s.whatsapp.net`;
const url = (j: string, v = 1) => `https://pps.whatsapp.test/${j.split('@')[0]}/v${v}.jpg`;

/** A fake profilePictureUrl IQ that takes a moment, and records how many ran at once. */
function pictureServer(service: any) {
  const state = { inFlight: 0, maxInFlight: 0, version: 1 };
  const fn = vi.fn(async (j: string) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    state.inFlight--;
    return url(j, state.version);
  });
  service.client.profilePictureUrl = fn;
  const perJid = () => {
    const counts: Record<string, number> = {};
    for (const [j] of fn.mock.calls) counts[j] = (counts[j] ?? 0) + 1;
    return counts;
  };
  return { fn, state, perJid };
}

/** Wait until the handlers have stopped asking for pictures. */
async function quiet(service: any, fn: { mock: { calls: unknown[] } }) {
  let last = -1;
  while (fn.mock.calls.length !== last) {
    last = fn.mock.calls.length;
    await settle(service);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const itemsFor = (event: string, j: string) =>
  emitted
    .filter((e) => e.event === event)
    .flatMap((e) => [].concat(e.data))
    .filter((c: any) => c?.remoteJid === j);

/** What the socket emits for an incoming text: the message, and the sender's profile name (chats.js upsertMessage). */
const incoming = (j: string, id: string, pushName: string) => ({
  'messages.upsert': { messages: [{ ...msg(j, id, 'hi').message, pushName }], type: 'notify' },
  'contacts.update': [{ id: j, notify: pushName, verifiedName: undefined }],
});

describe('profile pictures are looked up once per contact, not once per event', () => {
  beforeEach(() => void emitted.splice(0));
  afterEach(() => void vi.useRealTimers());

  it('a history batch of many contacts asks for each picture once, a few at a time, and the payload keeps the picture', async () => {
    const N = 40;
    const { service, ev } = await makeService();
    const server = pictureServer(service);
    const contacts = Array.from({ length: N }, (_, i) => jid(i));

    await deliver(service, ev, {
      'messaging-history.set': historyEvent({
        syncType: INITIAL_BOOTSTRAP,
        progress: 100,
        conversations: contacts.map((j, i) => ({ id: j, name: `Contact ${i}`, messages: [msg(j, `H${i}`, 'hi')] })),
      }),
    });
    await quiet(service, server.fn);
    // The same people again, as the push-name sync that follows the bootstrap.
    await deliver(service, ev, {
      'messaging-history.set': historyEvent({
        syncType: PUSH_NAME,
        pushnames: contacts.map((j, i) => ({ id: j, pushname: `Profile ${i}` })),
      }),
    });
    await quiet(service, server.fn);

    expect(server.fn).toHaveBeenCalledTimes(N);
    expect(Object.values(server.perJid()).every((n) => n === 1)).toBe(true);
    expect(server.state.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);

    for (const j of contacts) {
      const updates = itemsFor('contacts.update', j);
      expect(updates).toHaveLength(2);
      expect(updates.map((u: any) => u.profilePicUrl)).toEqual([url(j), url(j)]);
    }
  });

  it('a burst of inbound messages from a few senders asks once per sender, not per message', async () => {
    const SENDERS = [jid(101), jid(102), jid(103)];
    const M = 30;
    const { service, ev } = await makeService();
    const server = pictureServer(service);

    for (let i = 0; i < M; i++) {
      const sender = SENDERS[i % SENDERS.length];
      await deliver(service, ev, incoming(sender, `M${i}`, `Sender ${sender.slice(4, 7)}`));
    }
    await quiet(service, server.fn);

    expect(server.perJid()).toEqual(Object.fromEntries(SENDERS.map((j) => [j, 1])));
    for (const j of SENDERS) {
      const payloads = [...itemsFor('contacts.upsert', j), ...itemsFor('contacts.update', j)];
      // Each message yields one contact payload from messages.upsert and one from contacts.update.
      expect(payloads).toHaveLength((2 * M) / SENDERS.length);
      expect(new Set(payloads.map((p: any) => p.profilePicUrl))).toEqual(new Set([url(j)]));
    }
  });

  it('a lookup is kept for an hour, then asked again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const A = jid(201);
    const { service, ev } = await makeService();
    const server = pictureServer(service);

    await deliver(service, ev, incoming(A, 'T1', 'Alpha'));
    await quiet(service, server.fn);
    vi.setSystemTime(Date.now() + HOUR - 60_000);
    await deliver(service, ev, incoming(A, 'T2', 'Alpha'));
    await quiet(service, server.fn);
    expect(server.fn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    server.state.version = 2;
    await deliver(service, ev, incoming(A, 'T3', 'Alpha'));
    await quiet(service, server.fn);
    expect(server.fn).toHaveBeenCalledTimes(2);
    expect(itemsFor('contacts.update', A).at(-1).profilePicUrl).toBe(url(A, 2));
  });

  it('a picture notification refreshes the picture, and a removal clears it without asking', async () => {
    const A = jid(301);
    const B = jid(302);
    const { service, ev } = await makeService();
    const server = pictureServer(service);

    await deliver(service, ev, { ...incoming(A, 'P1', 'Alpha') });
    await deliver(service, ev, { ...incoming(B, 'P2', 'Bravo') });
    await quiet(service, server.fn);
    expect(server.fn).toHaveBeenCalledTimes(2);

    // Baileys (messages-recv.js, notification type `picture`) emits no builder-made event: hand-written.
    server.state.version = 2;
    await deliver(service, ev, { 'contacts.update': [{ id: A, imgUrl: 'changed' }] });
    await deliver(service, ev, { 'contacts.update': [{ id: B, imgUrl: 'removed' }] });
    await quiet(service, server.fn);

    expect(server.perJid()).toEqual({ [A]: 2, [B]: 1 });
    expect(itemsFor('contacts.update', A).at(-1).profilePicUrl).toBe(url(A, 2));
    expect(itemsFor('contacts.update', B).at(-1).profilePicUrl).toBeNull();

    // And the refreshed picture is what the next message carries, without another lookup.
    await deliver(service, ev, incoming(A, 'P3', 'Alpha'));
    await quiet(service, server.fn);
    expect(server.fn).toHaveBeenCalledTimes(3);
    expect(itemsFor('contacts.update', A).at(-1).profilePicUrl).toBe(url(A, 2));
  });

  it('listing all groups twice asks for each group picture once', async () => {
    const GROUPS = Array.from({ length: 12 }, (_, i) => `1203630000000${String(i).padStart(5, '0')}@g.us`);
    const { service } = await makeService();
    const server = pictureServer(service);
    const meta = (id: string) => ({ id, subject: `Group ${id.slice(-8, -5)}`, participants: [], creation: 1_700_000_000 });
    service.client.groupFetchAllParticipating = async () => Object.fromEntries(GROUPS.map((id) => [id, meta(id)]));

    const first = await service.fetchAllGroups({ getParticipants: 'false' });
    const second = await service.fetchAllGroups({ getParticipants: 'false' });

    expect(server.fn).toHaveBeenCalledTimes(GROUPS.length);
    expect(first.map((g: any) => g.pictureUrl)).toEqual(GROUPS.map((id) => url(id)));
    expect(second.map((g: any) => g.pictureUrl)).toEqual(GROUPS.map((id) => url(id)));
  });

  it('an explicit picture request still asks WhatsApp, and later events carry what it found', async () => {
    const A = jid(401);
    const { service, ev } = await makeService();
    const server = pictureServer(service);

    await deliver(service, ev, incoming(A, 'E1', 'Alpha'));
    await quiet(service, server.fn);
    server.state.version = 2;
    expect((await service.profilePicture(A)).profilePictureUrl).toBe(url(A, 2));
    expect(server.fn).toHaveBeenCalledTimes(2);

    await deliver(service, ev, incoming(A, 'E2', 'Alpha'));
    await quiet(service, server.fn);
    expect(server.fn).toHaveBeenCalledTimes(2);
    expect(itemsFor('contacts.update', A).at(-1).profilePicUrl).toBe(url(A, 2));
  });
});
