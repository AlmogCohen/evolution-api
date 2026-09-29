// Live check group-rename-participants, recorded 2026-09-27 (docs/LIVE-CHECKS.md):
// the owner created a group, renamed it, removed a member and added them back.
// Baileys 7 emits each participant as an object ({ id: @lid, phoneNumber }), and
// Evolution's participantsData must read it: a jid string and a phone JID, never
// "[object Object]".
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';

const FIXTURE = 'test/fixtures/live/2026-09-27-rig-session';
const GROUP = '120363000000000001@g.us';
const OWNER = { id: '100000000000000@lid', phoneNumber: '972500000000@s.whatsapp.net', admin: 'superadmin' };
const MEMBER = { id: '100000000000002@lid', phoneNumber: '972500000002@s.whatsapp.net', admin: null };

// Group metadata was a socket query, not recorded: answer with the group as groups.upsert described it.
const client = { groupMetadata: async (id: string) => ({ id, subject: 'Name 4', participants: [OWNER, MEMBER] }) };
// participantsData's name and picture come from the live database and picture queries.
const FROM_QUERIES = ['name', 'imgUrl'];

describe('live: a group renamed, a member removed and added back', () => {
  it('reaches groups.upsert, then groups.update with the new subject', async () => {
    const { webhooks } = await replayFixture(FIXTURE, { client });
    const upserts = webhooks.filter((w) => w.event === 'groups.upsert').flatMap((w) => w.data);
    const updates = webhooks.filter((w) => w.event === 'groups.update').flatMap((w) => w.data);

    expect(upserts).toEqual([expect.objectContaining({ id: GROUP, subject: 'Name 3', size: 2 })]);
    expect(updates).toEqual([expect.objectContaining({ id: GROUP, subject: 'Name 4' })]);
    const events = ['groups.upsert', 'groups.update'];
    expect(compareGolden(webhooks, loadFixture(FIXTURE).webhooks, { events })).toEqual([]);
  });

  it('reaches group-participants.update with participantsData holding the @lid and the phone JID', async () => {
    const { webhooks } = await replayFixture(FIXTURE, { client });
    const updates = webhooks.filter((w) => w.event === 'group-participants.update').map((w) => w.data);

    expect(updates.map((u) => u.action)).toEqual(['remove', 'add']);
    for (const update of updates) {
      expect(update.id).toBe(GROUP);
      expect(update.participants).toEqual([{ id: MEMBER.id, phoneNumber: MEMBER.phoneNumber, admin: null }]);
      expect(update.participantsData).toHaveLength(1);
      const [data] = update.participantsData;
      expect(typeof data.jid).toBe('string');
      expect(data.jid).toBe(MEMBER.id);
      expect(data.phoneNumber).toBe(MEMBER.phoneNumber);
      expect(JSON.stringify(update)).not.toContain('[object Object]');
    }
    const events = ['group-participants.update'];
    const golden = loadFixture(FIXTURE).webhooks;
    expect(compareGolden(webhooks, golden, { events, volatile: FROM_QUERIES })).toEqual([]);
  });
});
