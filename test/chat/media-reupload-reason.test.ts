// When the phone refuses to re-upload an expired file, it says why: its
// answer to the request (a <receipt type="server-error"> notification) carries
// either an <error code> or an encrypted MediaRetryNotification whose result is
// NOT_FOUND, DECRYPTION_ERROR or GENERAL_ERROR. Baileys turns that into the
// error updateMediaMessage throws. Evolution records the reason, and only the
// reason (never content or JIDs), in the re-upload log line (`reason=`) and on
// the download's error (`reuploadReason`, which the HTTP answer carries).
//
// The phone's answer is built as the notification node and read by Baileys'
// own decodeMediaRetryNode and decryptMediaRetryData. The Boom for a refused
// result is the one updateMediaMessage builds inline (messages-send.js), with
// no builder of its own, so it is written out here the same way.
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

import { randomBytes } from 'node:crypto';

import { Boom } from '@hapi/boom';
import { MEDIA_REUPLOAD_TIMEOUT_MS } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import {
  aesEncryptGCM,
  decodeMediaRetryNode,
  decryptMediaRetryData,
  encryptedStream,
  getStatusCodeForMediaRetry,
  hkdf,
  proto,
} from 'baileys';
import { rm } from 'node:fs/promises';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';
import { type Listening, startCdn } from '../helpers/local-net';

const TOKEN = 'instance-token';
const PHONE = '972509876543';
const ID = '3EB0FFFFFFFFFFFFFFF1';
const CAPTION = 'Zq7 a private caption Zq7';
const GONE = '/v/t62.7118-24/expired.enc';
const { NOT_FOUND, DECRYPTION_ERROR, GENERAL_ERROR } = proto.MediaRetryNotification.ResultType;

let cdn: Listening;
let mediaKey: Uint8Array;
let app: Awaited<ReturnType<typeof startChatApp>>;
let service: any;
/** What the phone answers to the next re-upload request: an error to throw, or nothing at all. */
let phone: () => Promise<never>;

const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(Buffer.from('a photo'), 'image', {});
  mediaKey = enc.mediaKey;
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({});
  // Evolution waits 5s before its own fallback download, and gives the phone a
  // bounded time to answer; both are shortened here.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms === MEDIA_REUPLOAD_TIMEOUT_MS ? 20 : ms, ...args)) as any);

  await prisma.instance.create({ data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' } });
  ({ service } = await makeService({ prisma }));
  service.client.updateMediaMessage = () => phone();
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

beforeEach(() => void cdn.log.splice(0));

/** The phone's notification for a re-upload request: an <error code>, or an encrypted result. */
function answerNode(answer: { code: string } | { result: number }) {
  const rmr = { tag: 'rmr', attrs: { jid: `${PHONE}@s.whatsapp.net`, from_me: 'false' } };
  if ('code' in answer) return { tag: 'receipt', attrs: { id: ID }, content: [rmr, { tag: 'error', attrs: { code: answer.code } }] };
  const plain = proto.MediaRetryNotification.encode({ stanzaId: ID, result: answer.result }).finish();
  const iv = randomBytes(12);
  const retryKey = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });
  const ciphertext = aesEncryptGCM(plain, retryKey, iv, Buffer.from(ID));
  const encrypt = { tag: 'encrypt', attrs: {}, content: [{ tag: 'enc_p', attrs: {}, content: ciphertext }, { tag: 'enc_iv', attrs: {}, content: iv }] };
  return { tag: 'receipt', attrs: { id: ID }, content: [encrypt, rmr] };
}

/** What Baileys' updateMediaMessage throws when the phone answers with this node. */
function refusal(node: any): Error {
  const event: any = decodeMediaRetryNode(node);
  if (event.error) return event.error;
  const media: any = decryptMediaRetryData(event.media, mediaKey, ID);
  const resultStr = proto.MediaRetryNotification.ResultType[media.result];
  return new Boom(`Media re-upload failed by device (${resultStr})`, {
    data: media,
    statusCode: getStatusCodeForMediaRetry(media.result) || 404,
  });
}

const refuses = (answer: { code: string } | { result: number }) => () => Promise.reject(refusal(answerNode(answer)));
const expiredImage = () => ({
  key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: ID },
  message: { imageMessage: { url: `http://127.0.0.1:${cdn.port}${GONE}`, mediaKey, mimetype: 'image/jpeg', caption: CAPTION } },
});

async function download() {
  let thrown: any;
  const out = await captureOutput(async () => {
    try {
      await service.getBase64FromMediaMessage({ message: expiredImage() });
    } catch (e) {
      thrown = e;
    }
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  return { thrown, out: plain, lines: plain.split('\n').filter((l) => l.includes('media download:')).map((l) => l.slice(l.indexOf('media download:'))) };
}

const at = (fields: string) => `media download: message=${ID}, chat=user, ${fields}`;

describe('a refused re-upload says why', () => {
  it.each([
    ['NOT_FOUND', NOT_FOUND, 404],
    ['DECRYPTION_ERROR', DECRYPTION_ERROR, 412],
    ['GENERAL_ERROR', GENERAL_ERROR, 418],
  ])('the phone answers %s: the log line and the error carry it', async (name, result, status) => {
    phone = refuses({ result });
    const { thrown, out, lines } = await download();

    expect(lines).toEqual([
      at('outcome=reupload_requested'),
      at(`outcome=reupload_failed, error=Error, status=${status}, reason=${name}`),
      at('outcome=download_failed, status=404, reupload=failed'),
    ]);
    expect(thrown).toEqual({ status: 400, error: 'Bad Request', message: [expect.any(String)], reupload: 'failed', reuploadReason: name });
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain('Zq7');
  });

  it('the phone answers with an error code: the reason is that code', async () => {
    phone = refuses({ code: '2' });
    const { thrown, lines } = await download();

    expect(lines[1]).toBe(at('outcome=reupload_failed, error=Error, status=404, reason=error_2'));
    expect(thrown.reuploadReason).toBe('error_2');
  });

  it('the phone answers with neither an error nor a result: missing_ciphertext', async () => {
    phone = () => Promise.reject(refusal({ tag: 'receipt', attrs: { id: ID }, content: [{ tag: 'rmr', attrs: { jid: `${PHONE}@s.whatsapp.net`, from_me: 'false' } }] }));
    const { thrown, lines } = await download();

    expect(lines[1]).toBe(at('outcome=reupload_failed, error=Error, status=404, reason=missing_ciphertext'));
    expect(thrown.reuploadReason).toBe('missing_ciphertext');
  });

  it('the phone does not answer in time: no_answer', async () => {
    phone = () => new Promise<never>(() => undefined);
    const { thrown, lines } = await download();

    expect(lines[1]).toBe(at('outcome=reupload_failed, error=ReuploadTimeoutError, status=none, reason=no_answer'));
    expect(thrown.reuploadReason).toBe('no_answer');
  });

  it('the HTTP answer carries the reason', async () => {
    phone = refuses({ result: NOT_FOUND });
    const res = await fetch(`${app.base}/chat/getBase64FromMediaMessage/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: TOKEN },
      body: JSON.stringify({ message: JSON.parse(JSON.stringify({ ...expiredImage(), message: { imageMessage: { ...expiredImage().message.imageMessage, mediaKey: Uint8Array.from(mediaKey) } } })) }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 400,
      error: 'Bad Request',
      response: { message: [expect.any(String)], reupload: 'failed', reuploadReason: 'NOT_FOUND' },
    });
  });
});
