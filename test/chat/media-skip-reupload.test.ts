// POST /chat/getBase64FromMediaMessage takes an optional `reupload` (boolean,
// default true). A consumer that only wants what is still on WhatsApp's
// servers sends reupload: false: Evolution does not hand Baileys a
// reuploadRequest, so the phone is never asked, and a file that has expired on
// the CDN (404 or 410) fails at once, without Evolution's own 5s fallback, with
// an error that says the file is gone and no re-upload was attempted.
// Omitting the field keeps today's behaviour: the phone is asked.
import { vi } from 'vitest';

const h = vi.hoisted(() => ({ waMonitor: undefined as any, chatController: undefined as any }));

vi.mock('@api/server.module', async () => {
  const fake = await import('../helpers/fake-server-module');
  return {
    ...fake,
    get waMonitor() {
      return h.waMonitor;
    },
    get chatController() {
      return h.chatController;
    },
  };
});

import { readFile, rm } from 'node:fs/promises';

import { encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';
import { type Listening, startCdn } from '../helpers/local-net';

const TOKEN = 'instance-token';
const ID = '3EB0DDDDDDDDDDDDDDD1';
const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const LIVE = '/v/t62.7118-24/reuploaded.enc';
const GONE = '/v/t62.7118-24/expired.enc';
const GONE_MESSAGE =
  "The media is no longer on WhatsApp's servers (HTTP 404), and no re-upload from the phone was attempted (reupload: false)";

let cdn: Listening;
let mediaKey: Uint8Array;
let app: Awaited<ReturnType<typeof startChatApp>>;
let asked: string[];

// Refuse any connection that is not to 127.0.0.1, before any lookup: Evolution's
// fallback retries the download at mmg.whatsapp.net, which must fail here, not leave.
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
  // Evolution waits 5s before its own fallback download; shortened, so a test that
  // takes it is not slow, and one that skips it is told apart by what it answers.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args)) as any);

  await prisma.instance.create({ data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' } });
  const { service } = await makeService({ prisma });
  asked = [];
  service.client.updateMediaMessage = async (message: any) => {
    asked.push(message.key.id);
    // What Baileys does when the phone re-uploads: point the message at the new copy.
    message.message.imageMessage.url = `http://127.0.0.1:${cdn.port}${LIVE}`;
    return message;
  };
  h.waMonitor = { waInstances: { test: service } };
  const { ChatController } = await import('@api/controllers/chat.controller');
  h.chatController = new ChatController(h.waMonitor);
  app = await startChatApp();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => {
  cdn.log.splice(0);
  asked.length = 0;
});

/** A stored image message as a consumer holds it: JSON, with the media key (a Uint8Array, as Baileys decodes it) an object of bytes. */
const expiredImage = () =>
  JSON.parse(
    JSON.stringify({
      key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: ID },
      message: { imageMessage: { url: `http://127.0.0.1:${cdn.port}${GONE}`, mediaKey: Uint8Array.from(mediaKey), mimetype: 'image/jpeg', fileLength: PLAIN.length } },
      messageTimestamp: 1_700_000_000,
    }),
  );

async function post(body: Record<string, any>) {
  const res = await fetch(`${app.base}/chat/getBase64FromMediaMessage/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('a media download can skip asking the phone to re-upload', () => {
  it('reupload: false and an expired file: the phone is not asked, and the error says the file is gone', async () => {
    const answer = await post({ message: expiredImage(), reupload: false });

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([`GET ${GONE}`]);
    expect(answer).toEqual({
      status: 400,
      body: { status: 400, error: 'Bad Request', response: { message: [GONE_MESSAGE], reupload: 'not_requested' } },
    });
  });

  it('reupload must be a boolean', async () => {
    const answer = await post({ message: expiredImage(), reupload: 'no' });

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([]);
    expect(answer).toEqual({
      status: 400,
      // Evolution's validation error: the router wraps the list of schema errors in another list.
      body: { status: 400, error: 'Bad Request', response: { message: [['reupload is not of a type(s) boolean']] } },
    });
  });

  it('reupload: false does not stop a download of a file that is still there', async () => {
    const message = expiredImage();
    message.message.imageMessage.url = `http://127.0.0.1:${cdn.port}${LIVE}`;
    const answer = await post({ message, reupload: false });

    expect(answer.status).toBe(201);
    expect(Buffer.from(answer.body.base64, 'base64').equals(PLAIN)).toBe(true);
  });

  it('reupload omitted: as before, the phone is asked and the download succeeds', async () => {
    const answer = await post({ message: expiredImage() });

    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${LIVE}`]);
    expect(answer.status).toBe(201);
    expect(Buffer.from(answer.body.base64, 'base64').equals(PLAIN)).toBe(true);
  });
});
