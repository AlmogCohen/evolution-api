// A private chat can be keyed by an @lid (WhatsApp's linked identity) instead
// of a phone number. Baileys' onWhatsApp answers exists:false for an @lid, so
// a send that trusts that answer refuses a chat the person is actually in.
// Upstream fixed it in evolution-api #2544. A phone number that is genuinely
// not on WhatsApp must still be refused.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import type { Profile } from '../helpers/profiles';

const LID = '123456789012345@lid';
const ABSENT = '972501112233';

function fakeSocket(service: any) {
  const sent: { jid: string; content: any }[] = [];
  const presence: { type: string; jid: string }[] = [];
  const asked: string[] = [];
  Object.assign(service.client, {
    // Baileys' own answer: nothing but a phone number it can resolve exists.
    onWhatsApp: async (...jids: string[]) => {
      asked.push(...jids);
      return jids.map((jid) => ({ exists: false, jid }));
    },
    sendMessage: async (jid: string, content: any) => {
      sent.push({ jid, content });
      return { key: { remoteJid: jid, fromMe: true, id: 'OUT1' }, message: { conversation: content.text }, messageTimestamp: 1_700_000_000, status: 1 };
    },
    presenceSubscribe: async () => undefined,
    sendPresenceUpdate: async (type: string, jid: string) => void presence.push({ type, jid }),
  });
  return { sent, presence, asked };
}

describe.each<Profile>(['minimal', 'stored'])('sending to an @lid chat (%s)', (profile) => {
  it('sendText to an @lid chat reaches the socket, addressed to that @lid', async () => {
    const { service } = await makeService({ profile });
    const { sent } = fakeSocket(service);

    const res = await service.textMessage({ number: LID, text: 'hello' });

    expect(sent.map(({ jid, content }) => ({ jid, text: content.text }))).toEqual([{ jid: LID, text: 'hello' }]);
    expect(res.key).toEqual({ remoteJid: LID, fromMe: true, id: 'OUT1' });
  });

  it('a typing presence to an @lid chat reaches the socket, addressed to that @lid', async () => {
    const { service } = await makeService({ profile });
    const { presence } = fakeSocket(service);

    await service.sendPresence({ number: LID, presence: 'composing', delay: 1 });

    expect(presence).toEqual([
      { type: 'composing', jid: LID },
      { type: 'paused', jid: LID },
    ]);
  });

  it('control: a phone number not on WhatsApp is still refused, and nothing is sent', async () => {
    const { service } = await makeService({ profile });
    const { sent, asked } = fakeSocket(service);

    await expect(service.textMessage({ number: ABSENT, text: 'hello' })).rejects.toMatchObject({ status: 400 });

    expect(asked).toEqual([`${ABSENT}@s.whatsapp.net`]);
    expect(sent).toEqual([]);
  });
});
