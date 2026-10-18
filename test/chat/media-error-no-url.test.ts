// A media download that fails fails with Baileys' error, whose message is
// "Failed to fetch stream from <the link>" and whose Boom data carries the same
// link (data.url). A WhatsApp media link is signed per message (`oh`, `oe`, the
// `_nc_*` parameters) and whoever holds it can fetch the file until it expires;
// even its directPath alone names the file. The logs are scrubbed already, but
// the error itself used to leave the process as it was: in the HTTP answer of
// POST /chat/getBase64FromMediaMessage (the message was the error's text), in
// what main.ts's error handler posts to the errors webhook (the same object),
// and in the S3 upload's error log line (which prints that object's message).
//
// The answer keeps what a caller can act on: the CDN's status, whether the phone
// was asked to re-upload the file and why it refused, and a stable reason text.
// It never carries a link, with or without its query.
//
// The CDN here is WhatsApp's own host, answered by the undici mock agent (so the
// links are the real shape and nothing leaves the machine): Baileys downloads
// from https://<the url's host><directPath>, and Evolution's own fallback from
// https://mmg.whatsapp.net<directPath>.
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

import { rm } from 'node:fs/promises';

import { Boom } from '@hapi/boom';
import { MEDIA_REUPLOAD_TIMEOUT_MS } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { encryptedStream, proto } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { emitted, prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';

const TOKEN = 'instance-token';
const PHONE = '972509876543';
const ID = '3EB0ABABABABABABABA1';
const CDN = 'https://mmg.whatsapp.net';
const SIGNATURE = '01_Q5Aa2wSignedHashXyz7Qp';
/** A media link's `oe` (when it stops working): hex unix seconds, as WhatsApp writes it. */
const oe = (fromNowS: number) => (Math.floor(Date.now() / 1000) + fromNowS).toString(16).toUpperCase();
const DAY = 24 * 60 * 60;
/** A directPath as WhatsApp signs it. */
const signed = (file: string, fromNowS = 14 * DAY) =>
  `/v/t62.7118-24/${file}_n.enc?ccb=11-4&oh=${SIGNATURE}&oe=${oe(fromNowS)}&_nc_sid=5e03e0&_nc_ohc=AbCdEfGh&mms3=true`;
const GONE_404 = signed('31415926_27182818284590_1234567890123456789');
const GONE_410 = signed('31415926_27182818284590_1234567890123456790');
const EXPIRED_403 = signed('31415926_27182818284590_1234567890123456791', -DAY);
const VALID_403 = signed('31415926_27182818284590_1234567890123456792');
const REUPLOADED = signed('31415926_27182818284590_1234567890123456793');
const STATUS: Record<string, number> = { [GONE_404]: 404, [GONE_410]: 410, [EXPIRED_403]: 403, [VALID_403]: 403, [REUPLOADED]: 404 };
/** Any part of a media link. */
const LEAKS = ['whatsapp.net', 'http://', 'https://', 'oh=', 'oe=', '_nc_', 'mms3', '/v/t62', 't62.7118', SIGNATURE, '31415926'];

let mediaKey: Uint8Array;
let app: Awaited<ReturnType<typeof startChatApp>>;
let service: any;
/** Every request the CDN answered: `GET <path>`. */
const cdnLog: string[] = [];
/** What the phone does with the next re-upload request. */
let phone: (message: any) => Promise<any>;

const refuses = () => () =>
  Promise.reject(
    new Boom('Media re-upload failed by device (NOT_FOUND)', {
      data: { stanzaId: ID, result: proto.MediaRetryNotification.ResultType.NOT_FOUND },
      statusCode: 404,
    }),
  );
const silent = () => () => new Promise<never>(() => undefined);
/** What Baileys does when the phone re-uploads: point the message at the new copy, which fails too. */
const reuploads = () => async (message: any) => {
  Object.assign(message.message.imageMessage, { url: `${CDN}${REUPLOADED}`, directPath: REUPLOADED });
  return message;
};

const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));
guard
  .get(CDN)
  .intercept({ path: () => true, method: 'GET' })
  .reply((req: any) => {
    cdnLog.push(`GET ${req.path}`);
    return { statusCode: STATUS[req.path] ?? 404, data: '' };
  })
  .persist();

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(Buffer.from('a photo'), 'image', {});
  mediaKey = enc.mediaKey;
  await rm(enc.encFilePath, { force: true });
  // Evolution waits 5s before its own fallback download, and gives the phone a
  // bounded time to answer; both are shortened here.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms === MEDIA_REUPLOAD_TIMEOUT_MS ? 20 : ms, ...args)) as any);

  await prisma.instance.create({ data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' } });
  ({ service } = await makeService({ prisma }));
  service.client.updateMediaMessage = (message: any) => phone(message);
  h.waMonitor = { waInstances: { test: service } };
  const { ChatController } = await import('@api/controllers/chat.controller');
  h.chatController = new ChatController(h.waMonitor);
  app = await startChatApp();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => {
  cdnLog.splice(0);
  emitted.splice(0);
});

/** A stored image message as a consumer holds it: JSON, with the media key an object of bytes. */
const image = (directPath: string) =>
  JSON.parse(
    JSON.stringify({
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: ID },
      message: { imageMessage: { url: `${CDN}${directPath}`, directPath, mediaKey: Uint8Array.from(mediaKey), mimetype: 'image/jpeg' } },
      messageTimestamp: 1_700_000_000,
    }),
  );

/** Every line of `text` that carries any part of a media link. */
const leaks = (text: string) =>
  text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => LEAKS.some((l) => line.includes(l)))
    .map((line) => line.trim().slice(0, 240));

async function post(body: Record<string, any>) {
  let res: Response;
  let text = '';
  const out = await captureOutput(async () => {
    res = await fetch(`${app.base}/chat/getBase64FromMediaMessage/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: TOKEN },
      body: JSON.stringify(body),
    });
    text = await res.text();
  });
  const headers = JSON.stringify([...res!.headers]);
  return { status: res!.status, body: JSON.parse(text), leaks: leaks(`${text}\n${headers}\n${out}`) };
}

const failed = (status: number) => `The media could not be downloaded (HTTP ${status})`;

describe('a failed media download never answers with the media link', () => {
  it.each([
    ['a CDN 404, and the phone refuses the re-upload', GONE_404, refuses, {}, 404, { reupload: 'failed', reuploadReason: 'NOT_FOUND' }],
    ['a CDN 410, and the phone does not answer in time', GONE_410, silent, {}, 410, { reupload: 'failed', reuploadReason: 'no_answer' }],
    ['a CDN 403 on an expired link, and the phone refuses the re-upload', EXPIRED_403, refuses, {}, 403, { reupload: 'failed', reuploadReason: 'NOT_FOUND' }],
    ['a CDN 404, the phone re-uploads, and the new link fails too', GONE_404, reuploads, {}, 404, { reupload: 'ok' }],
    ['a CDN 403 on a link that has not expired: the phone is not asked', VALID_403, refuses, {}, 403, { reupload: 'not_requested' }],
    ['reupload: false, and a CDN 403 on a link that has not expired', VALID_403, refuses, { reupload: false }, 403, { reupload: 'not_requested' }],
  ])('%s', async (_name, link, answer, extra, status, facts) => {
    phone = answer();
    const answered = await post({ message: image(link), ...extra });

    // The download really went to the signed link, and Evolution's fallback to the same file.
    expect(cdnLog[0]).toBe(`GET ${link}`);
    expect(answered.status).toBe(400);
    expect(answered.body).toEqual({ status: 400, error: 'Bad Request', response: { message: [failed(status)], ...facts } });
    // Not in the body, the headers, or anything logged meanwhile.
    expect(answered.leaks).toEqual([]);
  });

  it('the error the service throws (what the error handler, its errors webhook and callers read) holds no link', async () => {
    phone = reuploads();
    let thrown: any;
    await captureOutput(async () => {
      try {
        await service.getBase64FromMediaMessage({ message: image(GONE_404) });
      } catch (e) {
        thrown = e;
      }
    });

    expect(thrown).toEqual({ status: 400, error: 'Bad Request', message: [failed(404)], reupload: 'ok' });
    expect(leaks(JSON.stringify(thrown))).toEqual([]);
    expect(leaks(String(thrown?.stack ?? ''))).toEqual([]);
  });

  it('an incoming image the S3 upload cannot download: its error log does not name the link', async () => {
    const { service: stored, ev } = await makeService({ profile: 'stored' });
    const config = stored.configService;
    const get = config.get.bind(config);
    config.get = (key: string) => (key === 'S3' ? { ...get('S3'), ENABLE: true, SAVE_VIDEO: true } : get(key));
    stored.client.updateMediaMessage = () => refuses()();
    const incoming = {
      ...image(GONE_404),
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: `${ID}-S3` },
      pushName: 'Sender',
    };

    const out = await captureOutput(() => deliver(stored, ev, { 'messages.upsert': { messages: [incoming], type: 'notify' } }));

    expect(cdnLog[0]).toBe(`GET ${GONE_404}`);
    expect(out).toContain('Error on upload file to minio');
    expect(leaks(out)).toEqual([]);
    // The message still reaches the webhook (with its own link, as every media message does), without an S3 copy.
    const upsert = emitted.find((e) => e.event === 'messages.upsert');
    expect(upsert?.data?.key?.id).toBe(`${ID}-S3`);
    expect(upsert?.data?.message?.mediaUrl).toBeUndefined();
  });
});
