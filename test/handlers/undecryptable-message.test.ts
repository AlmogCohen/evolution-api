// A message Baileys cannot decrypt (no Signal session with the sender, a Bad MAC,
// a group sender key never received) arrives in messages.upsert as a CIPHERTEXT
// stub: the key, the sender's push name and time, and the error in
// messageStubParameters, no content. Evolution 2.3.7 skips it with a WARN log
// and sends nothing, so a consumer has no trace that a message was there at all,
// and cannot tell a message that never came from one it was never able to read
// (Circles, 2026-10-29..31: four group messages, three never recovered).
//
// The stub now reaches the consumer as messages.undecryptable: who, where, when
// and why, never a body, and it is still not a messages.upsert. When the sender
// answers Baileys' retry receipt, the readable copy is a messages.upsert with the
// same key id, as before.
//
// The keys are built by Baileys' own decodeMessageNode from a message stanza, and
// the stub fields are set the way its decrypt() sets them on a failure.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { decodeMessageNode, proto } from 'baileys';
import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, WUID } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import type { Profile } from '../helpers/profiles';

const ME_LID = '100000000000001@lid';
const LID = '123456789012345@lid';
const PHONE = '972509876543@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

/** What Baileys emits in messages.upsert when decrypt() failed with `error` for this stanza. */
function undecryptable(attrs: Record<string, string>, error: string) {
  const { fullMessage } = decodeMessageNode({ tag: 'message', attrs, content: [] } as any, WUID, ME_LID);
  return {
    ...fullMessage,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: [error],
  };
}

const groupStub = () =>
  undecryptable(
    {
      id: 'AC2695000000000000000000000000AA',
      from: GROUP,
      participant: LID,
      participant_pn: PHONE,
      addressing_mode: 'lid',
      type: 'text',
      t: '1761934500',
      notify: 'Sender',
    },
    'No session found to decrypt message',
  );

const lidDmStub = () =>
  undecryptable(
    { id: '3EB0EEEEEEEEEEEEEEE1', from: LID, sender_pn: PHONE, addressing_mode: 'lid', type: 'text', t: '1761934600', notify: 'Sender' },
    'Bad MAC',
  );

async function deliveredEvents(profile: Profile, message: any, settings?: Record<string, any>) {
  const { service, ev, prisma } = await makeService({ profile });
  if (settings) await prisma.setting.create({ data: { instanceId: 'inst-1', ...settings } });
  await deliver(service, ev, { 'messages.upsert': { messages: [message], type: 'notify' } });
  return emitted.filter((e) => e.event.startsWith('messages.'));
}

describe.each<Profile>(['minimal', 'stored'])('a message Evolution cannot decrypt (%s)', (profile) => {
  beforeEach(async () => {
    emitted.splice(0);
    // Which failures were already posted lives in the process-wide cache, as across reconnects.
    const { LocalCache } = await import('@cache/localcache');
    LocalCache.localCache.flushAll();
  });

  it('a group message reaches the webhook as messages.undecryptable: key, sender, time, chat kind and reason', async () => {
    const events = await deliveredEvents(profile, groupStub());
    expect(events.map((e) => e.event)).toEqual(['messages.undecryptable']);
    expect(events[0].data).toEqual({
      key: {
        remoteJid: GROUP,
        fromMe: false,
        id: 'AC2695000000000000000000000000AA',
        participant: LID,
        participantAlt: PHONE,
        addressingMode: 'lid',
      },
      pushName: 'Sender',
      messageTimestamp: 1761934500,
      chatKind: 'group',
      reason: 'No session found to decrypt message',
    });
  });

  it('a DM WhatsApp addresses by @lid shows the phone as remoteJid and the @lid in remoteJidAlt, as messages.upsert does', async () => {
    const events = await deliveredEvents(profile, lidDmStub());
    expect(events.map((e) => e.event)).toEqual(['messages.undecryptable']);
    expect(events[0].data).toEqual({
      key: { remoteJid: PHONE, remoteJidAlt: LID, fromMe: false, id: '3EB0EEEEEEEEEEEEEEE1', addressingMode: 'pn' },
      pushName: 'Sender',
      messageTimestamp: 1761934600,
      chatKind: 'user',
      reason: 'Bad MAC',
    });
  });

  it('carries no body and no error text: only the reason Evolution recognised', async () => {
    const stub = groupStub();
    stub.messageStubParameters = ['No session found to decrypt message for 972509876543@s.whatsapp.net "quoted"'];
    const [event] = await deliveredEvents(profile, stub);
    expect(Object.keys(event.data).sort()).toEqual(['chatKind', 'key', 'messageTimestamp', 'pushName', 'reason']);
    expect(event.data.reason).toBe('No session found to decrypt message');
    expect(JSON.stringify(event.data)).not.toContain('quoted');
  });

  it('the readable copy that a retry brings later is a messages.upsert with the same id', async () => {
    const { service, ev } = await makeService({ profile });
    const stub = groupStub();
    await deliver(service, ev, { 'messages.upsert': { messages: [stub], type: 'notify' } });
    const { messageStubType, messageStubParameters, ...rest } = stub;
    void messageStubType;
    void messageStubParameters;
    await deliver(service, ev, { 'messages.upsert': { messages: [{ ...rest, message: { conversation: 'hello' } }], type: 'notify' } });
    const events = emitted.filter((e) => e.event.startsWith('messages.'));
    expect(events.map((e) => [e.event, e.data.key.id])).toEqual([
      ['messages.undecryptable', 'AC2695000000000000000000000000AA'],
      ['messages.upsert', 'AC2695000000000000000000000000AA'],
    ]);
    // The same key, so a consumer finds the placeholder in the same chat.
    expect(events[1].data.key).toEqual(events[0].data.key);
  });

  it('a DM by @lid: the readable copy comes with the same key as the trace', async () => {
    const { service, ev } = await makeService({ profile });
    const stub = lidDmStub();
    await deliver(service, ev, { 'messages.upsert': { messages: [stub], type: 'notify' } });
    const { messageStubType, messageStubParameters, ...rest } = stub;
    void messageStubType;
    void messageStubParameters;
    await deliver(service, ev, { 'messages.upsert': { messages: [{ ...rest, message: { conversation: 'hello' } }], type: 'notify' } });
    const [trace, upsert] = emitted.filter((e) => e.event.startsWith('messages.'));
    expect([trace.event, upsert.event]).toEqual(['messages.undecryptable', 'messages.upsert']);
    expect(upsert.data.key).toEqual(trace.data.key);
  });

  it('a failure Baileys retries is posted once, not once per failed retry', async () => {
    const { service, ev } = await makeService({ profile });
    for (let i = 0; i < 3; i++) await deliver(service, ev, { 'messages.upsert': { messages: [groupStub()], type: 'notify' } });
    expect(emitted.filter((e) => e.event.startsWith('messages.')).map((e) => e.event)).toEqual(['messages.undecryptable']);
  });

  it('a decrypt error Evolution does not list is still posted, with reason other', async () => {
    const stub = groupStub();
    stub.messageStubParameters = ['Missing SignedPreKey'];
    const events = await deliveredEvents(profile, stub);
    expect(events.map((e) => [e.event, e.data.reason])).toEqual([['messages.undecryptable', 'other']]);
  });

  it("a peer message (the owner's own devices talking, never a chat message) is not posted", async () => {
    const stub = { ...groupStub(), category: 'peer' };
    expect(await deliveredEvents(profile, stub)).toEqual([]);
  });

  it('a group message is not posted on an instance that ignores groups, as its readable copy would not be', async () => {
    expect(await deliveredEvents(profile, groupStub(), { groupsIgnore: true })).toEqual([]);
  });
});
