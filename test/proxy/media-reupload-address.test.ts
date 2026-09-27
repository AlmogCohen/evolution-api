// A media re-upload request names the message by its key: Baileys'
// encryptMediaRetryRequest puts key.remoteJid in the <rmr jid> attribute and
// key.participant in <rmr participant>. The phone looks the message up under
// the address WhatsApp stores it by. For a chat WhatsApp addresses by @lid
// that is the @lid, and a request naming the phone JID is refused within a
// second (seen live, 2026-09-27).
//
// A consumer holds the key the messages.upsert webhook gave it, which shows
// the phone JID as remoteJid: with the @lid in remoteJidAlt since the webhook
// keeps it, or (a key stored from Evolution 2.3.7) with the phone twice and
// addressingMode 'lid'. Evolution asks for the re-upload with the message's
// original key either way. A group key names its sender the same way, in
// participant / participantAlt.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { readFile, rm } from 'node:fs/promises';

import { encryptedStream, encryptMediaRetryRequest, getBinaryNodeChild } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService, WUID } from '../helpers/baileys-service';
import { type Listening, startCdn } from '../helpers/local-net';

const LID = '123456789012345@lid';
const PHONE = '972509876543@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const ID = '3EB0EEEEEEEEEEEEEEE1';
const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const LIVE = '/v/t62.7118-24/reuploaded.enc';
const GONE = '/v/t62.7118-24/expired.enc';

let cdn: Listening;
let mediaKey: Uint8Array;

const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(PLAIN, 'image', {});
  mediaKey = enc.mediaKey;
  const body = await readFile(enc.encFilePath);
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({ [LIVE]: body });
});

afterAll(async () => {
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => void cdn.log.splice(0));

/**
 * A service whose phone re-uploads the file, recording the key each request
 * named and the <rmr> attributes Baileys' real encryptMediaRetryRequest builds
 * from it. `lidForPhone` is what Baileys' LID mapping store knows.
 */
async function serviceWithPhone(lidForPhone: Record<string, string> = {}) {
  const made = await makeService();
  const keys: any[] = [];
  const rmr: any[] = [];
  made.service.client.signalRepository.lidMapping.getLIDForPN = async (pn: string) => lidForPhone[pn] ?? null;
  made.service.client.updateMediaMessage = async (message: any) => {
    keys.push({ ...message.key });
    const node: any = encryptMediaRetryRequest(message.key, mediaKey, WUID);
    rmr.push({ ...getBinaryNodeChild(node, 'rmr').attrs });
    message.message.imageMessage.url = `http://127.0.0.1:${cdn.port}${LIVE}`;
    return message;
  };
  return { ...made, keys, rmr };
}

async function downloadWithKey(service: any, key: Record<string, any>) {
  const result = await service.getBase64FromMediaMessage({
    message: {
      key,
      message: {
        imageMessage: { url: `http://127.0.0.1:${cdn.port}${GONE}`, mediaKey, mimetype: 'image/jpeg', fileLength: PLAIN.length },
      },
    },
  });
  expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
  expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${LIVE}`]);
}

describe('a media re-upload names the chat by the address WhatsApp stores it under', () => {
  it('a DM key from the webhook (phone, @lid in remoteJidAlt) asks under the @lid', async () => {
    const { service, keys, rmr } = await serviceWithPhone();

    await downloadWithKey(service, { remoteJid: PHONE, remoteJidAlt: LID, fromMe: false, id: ID, addressingMode: 'pn' });

    expect(keys).toEqual([{ remoteJid: LID, remoteJidAlt: PHONE, fromMe: false, id: ID, addressingMode: 'lid' }]);
    expect(rmr).toEqual([{ jid: LID, from_me: 'false', participant: undefined }]);
  });

  it("a DM key stored from Evolution 2.3.7 (the phone twice, addressingMode 'lid') asks under the @lid Baileys maps it to", async () => {
    const { service, keys, rmr } = await serviceWithPhone({ [PHONE]: LID });

    await downloadWithKey(service, { remoteJid: PHONE, remoteJidAlt: PHONE, fromMe: false, id: ID, addressingMode: 'lid' });

    expect(keys).toEqual([{ remoteJid: LID, remoteJidAlt: PHONE, fromMe: false, id: ID, addressingMode: 'lid' }]);
    expect(rmr).toEqual([{ jid: LID, from_me: 'false', participant: undefined }]);
  });

  it('a group key with the phone as participant and the @lid in participantAlt asks under the @lid participant', async () => {
    const { service, keys, rmr } = await serviceWithPhone();

    await downloadWithKey(service, { remoteJid: GROUP, fromMe: false, id: ID, participant: PHONE, participantAlt: LID, addressingMode: 'pn' });

    expect(keys).toEqual([{ remoteJid: GROUP, fromMe: false, id: ID, participant: LID, participantAlt: PHONE, addressingMode: 'lid' }]);
    expect(rmr).toEqual([{ jid: GROUP, from_me: 'false', participant: LID }]);
  });

  it('control: a key already in its original @lid form is asked for as it is', async () => {
    const { service, keys, rmr } = await serviceWithPhone();
    const key = { remoteJid: LID, remoteJidAlt: PHONE, fromMe: false, id: ID, addressingMode: 'lid' };

    await downloadWithKey(service, key);

    expect(keys).toEqual([key]);
    expect(rmr).toEqual([{ jid: LID, from_me: 'false', participant: undefined }]);
  });

  it('control: a group key from the webhook (the @lid participant, as Baileys gave it) is asked for as it is', async () => {
    const { service, keys, rmr } = await serviceWithPhone();
    const key = { remoteJid: GROUP, fromMe: false, id: ID, participant: LID, participantAlt: PHONE, addressingMode: 'lid' };

    await downloadWithKey(service, key);

    expect(keys).toEqual([key]);
    expect(rmr).toEqual([{ jid: GROUP, from_me: 'false', participant: LID }]);
  });

  it('control: a chat addressed by phone, with no @lid known, is asked for under the phone', async () => {
    const { service, keys, rmr } = await serviceWithPhone();
    const key = { remoteJid: PHONE, fromMe: false, id: ID };

    await downloadWithKey(service, key);

    expect(keys).toEqual([key]);
    expect(rmr).toEqual([{ jid: PHONE, from_me: 'false', participant: undefined }]);
  });
});
