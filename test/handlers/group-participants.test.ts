// GROUP_PARTICIPANTS_UPDATE carries `participantsData` (CHANGELOG 2.3.5), one
// item per participant of the event, so a consumer can read the phone number of
// a participant WhatsApp addresses by a private @lid:
//   { jid, phoneNumber?, name?, imgUrl? }
//
// Baileys 7 (rc9+) emits group-participants.update with `participants` as
// GroupParticipant objects ({ id, phoneNumber?, lid?, admin?, ... }), built in
// Socket/messages-recv.js from the group notification and emitted by
// Utils/process-message.js from the GROUP_PARTICIPANT_* stub. The handler read
// them as strings, so every item came out as { jid: <the whole object>,
// phoneNumber: "[object Object]" } and never found its name or picture.
//
// Inputs run through Baileys' own processMessage from a stub message and reach
// Evolution through the real event buffer; group metadata is Baileys' own
// extractGroupMetadata over a synthetic <group> node. `participants` stays
// exactly what Baileys emitted, for consumers that already read it.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { WAMessageStubType } from 'baileys';
import P from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, settle, WUID } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { emitted } from '../helpers/fake-server-module';
import { realSignalRepository } from '../helpers/socket-history';

const GROUP = '120363000000000077@g.us';
const lid = (n: number) => `1000000000077${String(n).padStart(2, '0')}@lid`;
const pn = (n: number) => `97250007770${n}@s.whatsapp.net`;
const ADMIN = { lid: lid(1), pn: pn(1) };

/** A participant exactly as Baileys rc14 builds it from a group notification (messages-recv.js). */
const lidMember = (n: number, withPhone: boolean, admin: string | null = null) => ({
  id: lid(n),
  phoneNumber: withPhone ? pn(n) : undefined,
  lid: undefined,
  username: undefined,
  admin,
});
const pnMember = (n: number, admin: string | null = null) => ({
  id: pn(n),
  phoneNumber: undefined,
  lid: lid(n),
  username: undefined,
  admin,
});

let extractGroupMetadata: (node: any) => any;
let processMessage: (message: any, ctx: any) => Promise<void>;

/** The group as WhatsApp describes it after the change: members addressed by @lid, with their phone. */
function groupMeta(members: number[]) {
  const node = {
    tag: 'group',
    attrs: {
      id: GROUP.split('@')[0],
      subject: 'Synthetic group',
      s_t: '1700000000',
      creation: '1690000000',
      addressing_mode: 'lid',
    },
    content: members.map((n) => ({
      tag: 'participant',
      attrs: { jid: lid(n), phone_number: pn(n), ...(n === 1 ? { type: 'superadmin' } : {}) },
    })),
  };
  return extractGroupMetadata({ tag: 'result', attrs: {}, content: [node] });
}

async function groupService(members: number[]) {
  const { service, prisma, ev } = await makeService();
  const { repo } = await realSignalRepository();
  service.client.signalRepository = repo;
  service.client.groupMetadata = async () => groupMeta(members);
  await deliver(service, ev, {}); // wire the handlers
  return { service, prisma, ev, repo };
}

/** What the socket does with a GROUP_PARTICIPANT_* notification: processMessage over the stub, buffered. */
async function stub(service: any, ev: any, stubType: number, participants: Record<string, any>[]) {
  const message = {
    key: { remoteJid: GROUP, fromMe: false, id: `STUB${stubType}`, participant: ADMIN.lid, participantAlt: ADMIN.pn },
    messageStubType: stubType,
    messageStubParameters: participants.map((p) => JSON.stringify(p)),
    messageTimestamp: 1_700_000_000,
  };
  const ctx = {
    shouldProcessHistoryMsg: false,
    ev,
    logger: P({ level: 'silent' }),
    options: {},
    placeholderResendCache: undefined,
    getMessage: async () => undefined,
    creds: { me: { id: WUID, lid: '999999999999999@lid', name: 'Me' }, processedHistoryMessages: [] },
    keyStore: undefined,
    signalRepository: service.client.signalRepository,
  };
  ev.buffer();
  await processMessage(message, ctx);
  await ev.flush();
  await settle(service);
}

/** Every GROUP_PARTICIPANTS_UPDATE payload, as a webhook consumer receives it (JSON). */
const updates = () =>
  emitted.filter((e) => e.event === 'group-participants.update').map((e) => JSON.parse(JSON.stringify(e.data)));

/** A participant as the webhook carries it inside `participants`: Baileys' object, as JSON. */
const asJson = (p: any) => JSON.parse(JSON.stringify(p));

describe('group participant updates carry each participant jid and phone number', () => {
  beforeEach(async () => {
    emitted.splice(0);
    ({ extractGroupMetadata } = await import('baileys/lib/Socket/groups.js' as any));
    ({ default: processMessage } = await import('baileys/lib/Utils/process-message.js' as any));
  });

  it('add: the phone comes from the event, else from the group metadata; name and picture from the contact', async () => {
    const { service, prisma, ev } = await groupService([1, 2, 3]);
    prisma.contact.rows.push({
      remoteJid: lid(2),
      pushName: 'Member Two',
      profilePicUrl: 'https://pps.example/2',
      instanceId: 'inst-1',
    });
    const added = [lidMember(2, true), lidMember(3, false)];

    await stub(service, ev, WAMessageStubType.GROUP_PARTICIPANT_ADD, added);

    expect(updates()).toEqual([
      {
        id: GROUP,
        author: ADMIN.lid,
        authorPn: ADMIN.pn,
        action: 'add',
        participants: added.map(asJson),
        participantsData: [
          { jid: lid(2), phoneNumber: pn(2), name: 'Member Two', imgUrl: 'https://pps.example/2' },
          { jid: lid(3), phoneNumber: pn(3) },
        ],
      },
    ]);
  });

  it('remove: a participant no longer in the group gets its phone from the LID mapping store, or none', async () => {
    const { service, ev, repo } = await groupService([1]);
    await repo.lidMapping.storeLIDPNMappings([{ lid: lid(4), pn: pn(4) }]);
    const removed = [lidMember(4, false), lidMember(5, false)];

    await stub(service, ev, WAMessageStubType.GROUP_PARTICIPANT_REMOVE, removed);

    expect(updates()).toEqual([
      {
        id: GROUP,
        author: ADMIN.lid,
        authorPn: ADMIN.pn,
        action: 'remove',
        participants: removed.map(asJson),
        participantsData: [{ jid: lid(4), phoneNumber: pn(4) }, { jid: lid(5) }],
      },
    ]);
  });

  it('promote: a participant addressed by phone number is its own phone number', async () => {
    const { service, ev } = await groupService([1, 6]);
    const promoted = [pnMember(6, 'admin')];

    await stub(service, ev, WAMessageStubType.GROUP_PARTICIPANT_PROMOTE, promoted);

    expect(updates()).toEqual([
      {
        id: GROUP,
        author: ADMIN.lid,
        authorPn: ADMIN.pn,
        action: 'promote',
        participants: promoted.map(asJson),
        participantsData: [{ jid: pn(6), phoneNumber: pn(6) }],
      },
    ]);
  });

  it('legacy string participants (Baileys 6) still resolve, and stay strings', async () => {
    const { service, prisma, ev } = await groupService([1, 7]);
    prisma.contact.rows.push({
      remoteJid: lid(7),
      pushName: 'Member Seven',
      profilePicUrl: null,
      instanceId: 'inst-1',
    });
    // Hand-written: no Baileys version the fork runs emits string participants.
    const legacy = { id: GROUP, author: ADMIN.lid, participants: [lid(7), pn(8)], action: 'add' };

    await deliver(service, ev, { 'group-participants.update': legacy });

    expect(updates()).toEqual([
      {
        ...legacy,
        participantsData: [
          { jid: lid(7), phoneNumber: pn(7), name: 'Member Seven', imgUrl: null },
          { jid: pn(8), phoneNumber: pn(8) },
        ],
      },
    ]);
  });

  it('prints no participant number or name', async () => {
    const { service, prisma, ev, repo } = await groupService([1, 2]);
    prisma.contact.rows.push({ remoteJid: lid(2), pushName: 'Member Two', profilePicUrl: null, instanceId: 'inst-1' });
    await repo.lidMapping.storeLIDPNMappings([{ lid: lid(4), pn: pn(4) }]);

    const out = await captureOutput(async () => {
      await stub(service, ev, WAMessageStubType.GROUP_PARTICIPANT_ADD, [lidMember(2, true)]);
      await stub(service, ev, WAMessageStubType.GROUP_PARTICIPANT_REMOVE, [lidMember(4, false)]);
    });

    expect(updates().flatMap((u) => u.participantsData.map((d: any) => d.phoneNumber))).toEqual([pn(2), pn(4)]);
    for (const secret of ['0007770', '1000000000077', 'Member Two']) expect(out).not.toContain(secret);
  });
});
