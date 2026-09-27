// A short synthetic live session, played on the socket Evolution's real connect
// built (the test file mocks makeWASocket with fakeSocket). The identities look
// real on purpose: the recorder must keep them, and the scrubber must replace them.
import { proto } from 'baileys';
import Long from 'long';

import { settle } from './baileys-service';

export const OWNER = { id: '972529998877:14@s.whatsapp.net', lid: '987654321098765:14@lid', name: 'Noa Barak' };
export const PERSON = { pn: '972541112233@s.whatsapp.net', lid: '123456789012345@lid', saved: 'Dana Levi', push: 'Dana' };
export const TEXT = 'see you at the cafe on Herzl street at 8';
export const MESSAGE_ID = '3EB0C431C26A1D6C5A5D';
export const MESSAGE_SECRET = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff', 'hex');
export const CALL_ID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

/** Every identifying string in the session, for tests that look for leaks. */
export const ORIGINALS = [
  '972529998877',
  '987654321098765',
  OWNER.name,
  '972541112233',
  '123456789012345',
  PERSON.saved,
  PERSON.push,
  TEXT,
  MESSAGE_ID.slice(2),
  CALL_ID.slice(2),
  MESSAGE_SECRET.toString('base64'),
];

export const incoming = () =>
  proto.WebMessageInfo.fromObject({
    key: { remoteJid: PERSON.lid, remoteJidAlt: PERSON.pn, fromMe: false, id: MESSAGE_ID, addressingMode: 'lid' },
    messageTimestamp: Long.fromNumber(1758873600, true),
    pushName: PERSON.push,
    message: { conversation: TEXT, messageContextInfo: { messageSecret: new Uint8Array(MESSAGE_SECRET) } },
  });

/** What the owner's phone answers a call with, when the instance has a call message set. */
export const callReply = (jid: string, text: string) =>
  proto.WebMessageInfo.fromObject({
    key: { remoteJid: jid, fromMe: true, id: 'BAE5F00D12345678' },
    messageTimestamp: Long.fromNumber(1758873801, true),
    message: { conversation: text },
  });

/** The socket as a linked session has it: the account, a LID mapping, a phone that sends. */
export function linkedSocket(service: any) {
  Object.assign(service.client, {
    user: { ...OWNER },
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid: string) => (lid === PERSON.lid ? PERSON.pn : undefined),
        getLIDForPN: async (pn: string) => (pn === PERSON.pn ? PERSON.lid : undefined),
      },
    },
    sendMessage: async (jid: string, content: { text: string }) => callReply(jid, content.text),
  });
  // WhatsApp reports the phone's platform at pairing; smba is WhatsApp Business on Android.
  if (service.instance.authState?.state?.creds) service.instance.authState.state.creds.platform = 'smba';
}

/** Open, then a contact and a message in one buffered batch, then a call offer. */
export async function playSession(service: any) {
  linkedSocket(service);
  const ev = service.client.ev;
  ev.emit('connection.update', { connection: 'open' });
  ev.emit('creds.update', { me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
  ev.buffer();
  ev.emit('contacts.upsert', [{ id: PERSON.pn, lid: PERSON.lid, name: PERSON.saved, notify: PERSON.push }]);
  ev.emit('messages.upsert', { type: 'notify', messages: [incoming()] });
  ev.flush();
  ev.emit('call', [
    {
      chatId: PERSON.lid,
      from: PERSON.lid,
      id: CALL_ID,
      date: new Date(1758873800000),
      offline: false,
      status: 'offer',
      isVideo: false,
      isGroup: false,
    },
  ]);
  await settle(service);
}
