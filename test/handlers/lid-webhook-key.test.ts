// WhatsApp can address a private chat by an @lid (a linked identity) instead of
// the person's phone number. Baileys then hands Evolution a key with the @lid in
// remoteJid and the phone JID in remoteJidAlt. Evolution shows the phone JID as
// remoteJid in the messages.upsert webhook (consumers have always keyed chats by
// phone), but the phone keeps the message under the @lid: a consumer that later
// asks for something about that message (a media re-upload) must be able to name
// it the way WhatsApp does. So the webhook key keeps the original @lid in
// remoteJidAlt, the swap upstream develop makes. A group message's participant
// is not rewritten, so it keeps its @lid and phone as Baileys gave them.
//
// The keys are built by Baileys' own decodeMessageNode from a message stanza,
// so they carry exactly the fields this Baileys version produces.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { decodeMessageNode } from 'baileys';
import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, WUID } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import type { Profile } from '../helpers/profiles';

const ME_LID = '100000000000001@lid';
const LID = '123456789012345@lid';
const PHONE = '972509876543@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

/** What Baileys emits in messages.upsert for this stanza, with a text body. */
function received(attrs: Record<string, string>) {
  const { fullMessage } = decodeMessageNode({ tag: 'message', attrs, content: [] } as any, WUID, ME_LID);
  return { ...fullMessage, message: { conversation: 'hello' } };
}

const lidDm = () =>
  received({ id: '3EB0DDDDDDDDDDDDDDD1', from: LID, sender_pn: PHONE, addressing_mode: 'lid', type: 'text', t: '1700000000', notify: 'Sender' });

const lidGroup = () =>
  received({
    id: '3EB0DDDDDDDDDDDDDDD2',
    from: GROUP,
    participant: LID,
    participant_pn: PHONE,
    addressing_mode: 'lid',
    type: 'text',
    t: '1700000000',
    notify: 'Sender',
  });

async function webhookKey(profile: Profile, message: any) {
  const { service, ev } = await makeService({ profile });
  await deliver(service, ev, { 'messages.upsert': { messages: [message], type: 'notify' } });
  const upserts = emitted.filter((e) => e.event === 'messages.upsert');
  expect(upserts).toHaveLength(1);
  return upserts[0].data.key;
}

describe.each<Profile>(['minimal', 'stored'])("a message's webhook key keeps its original @lid address (%s)", (profile) => {
  beforeEach(() => void emitted.splice(0));

  it('a DM WhatsApp addresses by @lid: remoteJid is the phone, remoteJidAlt the original @lid', async () => {
    const message = lidDm();
    // What Baileys hands Evolution.
    expect(message.key).toEqual({ remoteJid: LID, remoteJidAlt: PHONE, fromMe: false, id: '3EB0DDDDDDDDDDDDDDD1', addressingMode: 'lid' });

    expect(await webhookKey(profile, message)).toEqual({
      remoteJid: PHONE,
      remoteJidAlt: LID,
      fromMe: false,
      id: '3EB0DDDDDDDDDDDDDDD1',
      addressingMode: 'pn',
    });
  });

  it('a group message from an @lid participant keeps the @lid participant and its phone', async () => {
    const message = lidGroup();
    expect(message.key).toEqual({
      remoteJid: GROUP,
      fromMe: false,
      id: '3EB0DDDDDDDDDDDDDDD2',
      participant: LID,
      participantAlt: PHONE,
      addressingMode: 'lid',
    });

    expect(await webhookKey(profile, message)).toEqual({
      remoteJid: GROUP,
      fromMe: false,
      id: '3EB0DDDDDDDDDDDDDDD2',
      participant: LID,
      participantAlt: PHONE,
      addressingMode: 'lid',
    });
  });

  it('control: a DM addressed by phone is unchanged, its @lid in remoteJidAlt', async () => {
    const message = received({ id: '3EB0DDDDDDDDDDDDDDD3', from: PHONE, sender_lid: LID, addressing_mode: 'pn', type: 'text', t: '1700000000', notify: 'Sender' });

    expect(await webhookKey(profile, message)).toEqual({
      remoteJid: PHONE,
      remoteJidAlt: LID,
      fromMe: false,
      id: '3EB0DDDDDDDDDDDDDDD3',
      addressingMode: 'pn',
    });
  });
});
