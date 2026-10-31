// Evolution keeps a group metadata cache (updateGroupMetadataCache) that
// Baileys reads before every group send (cachedGroupMetadata). Its
// groups.update handler refreshed that cache with a groupMetadata query per
// group, all at once. Baileys' groupFetchAllParticipating (rc14 groups.js)
// emits groups.update with the FULL metadata of every group, so each
// fetchAllGroups cost one groupMetadata query per group on top of the listing
// itself, although the event already carried the answer: 259 queries every
// listing for one measured account.
//
// An item that carries participants is complete metadata and fills the cache
// as it is. A partial item (a subject or setting change, Baileys'
// process-message) still refetches that group, once, a few at a time.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

/** The most metadata queries the service may have in flight at once. */
const MAX_IN_FLIGHT = 4;
const MEMBER = (i: number) => `9725${String(i).padStart(8, '0')}@s.whatsapp.net`;

let extractGroupMetadata: (node: any) => any;

/** What WhatsApp answers for one group, turned into metadata by the Baileys under test. */
function groupMeta(id: string, subject: string) {
  const node = {
    tag: 'group',
    attrs: { id: id.split('@')[0], subject, s_t: '1700000000', creation: '1690000000', creator: MEMBER(1) },
    content: [
      { tag: 'participant', attrs: { jid: MEMBER(1), type: 'superadmin' } },
      { tag: 'participant', attrs: { jid: MEMBER(2) } },
    ],
  };
  return extractGroupMetadata({ tag: 'result', attrs: {}, content: [node] });
}

const groupIds = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `120363${prefix}${String(i).padStart(6, '0')}@g.us`);

/** A fake socket side for groups: the listing emits groups.update as rc14 does; groupMetadata is counted. */
function groupServer(service: any, listed: string[]) {
  const state = { inFlight: 0, maxInFlight: 0 };
  const groupMetadata = vi.fn(async (id: string) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    state.inFlight--;
    return groupMeta(id, `Fetched ${id.slice(-8, -5)}`);
  });
  service.client.groupMetadata = groupMetadata;
  service.client.groupFetchAllParticipating = async () => {
    const data = Object.fromEntries(listed.map((id) => [id, groupMeta(id, `Listed ${id.slice(-8, -5)}`)]));
    service.client.ev.emit('groups.update', Object.values(data));
    return data;
  };
  const perGroup = () => {
    const counts: Record<string, number> = {};
    for (const [id] of groupMetadata.mock.calls) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  };
  return { groupMetadata, state, perGroup };
}

async function quiet(service: any, fn: { mock: { calls: unknown[] } }) {
  let last = -1;
  while (fn.mock.calls.length !== last) {
    last = fn.mock.calls.length;
    await settle(service);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('the group metadata cache is filled from groups.update', () => {
  beforeEach(async () => {
    emitted.splice(0);
    ({ extractGroupMetadata } = await import('baileys/lib/Socket/groups.js' as any));
  });

  it('listing all groups twice queries no group metadata, and the cache holds what the listing carried', async () => {
    const GROUPS = groupIds('1000', 12);
    const { service, ev } = await makeService();
    const server = groupServer(service, GROUPS);
    await deliver(service, ev, {}); // wire the handlers

    await service.fetchAllGroups({ getParticipants: 'false' });
    await quiet(service, server.groupMetadata);
    await service.fetchAllGroups({ getParticipants: 'false' });
    await quiet(service, server.groupMetadata);

    expect(server.groupMetadata).not.toHaveBeenCalled();
    for (const id of GROUPS) {
      expect(await service.getGroupMetadataCache(id)).toEqual(groupMeta(id, `Listed ${id.slice(-8, -5)}`));
    }
    expect(server.groupMetadata).not.toHaveBeenCalled();
    // The webhook is what it was: every listed group, as Baileys emitted it.
    const updates = emitted.filter((e) => e.event === 'groups.update');
    expect(updates).toHaveLength(2);
    expect(updates[0].data.map((g: any) => g.id)).toEqual(GROUPS);
  });

  it('partial updates refetch each group once, a few at a time', async () => {
    const PARTIAL = groupIds('2000', 12);
    const { service, ev } = await makeService();
    const server = groupServer(service, []);

    await deliver(service, ev, {}); // wire the handlers
    // Hand-written: Baileys emits these from process-message.js (group stubs), which has no builder here.
    // Two changes to one group arrive as two batches (in one batch the event buffer merges them).
    ev.emit('groups.update', [{ id: PARTIAL[0], subject: 'Renamed' }]);
    ev.emit('groups.update', [{ id: PARTIAL[0], announce: true }]);
    ev.emit('groups.update', PARTIAL.slice(1).map((id) => ({ id, restrict: true })));
    await quiet(service, server.groupMetadata);

    expect(server.perGroup()).toEqual(Object.fromEntries(PARTIAL.map((id) => [id, 1])));
    expect(server.state.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect((await service.getGroupMetadataCache(PARTIAL[0])).subject).toBe(`Fetched ${PARTIAL[0].slice(-8, -5)}`);
    expect(server.groupMetadata).toHaveBeenCalledTimes(PARTIAL.length);
  });
});
