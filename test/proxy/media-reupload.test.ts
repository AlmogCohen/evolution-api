// When a media file has expired on WhatsApp's CDN, the only copy left is on
// the sender's phone. Evolution asks the phone to re-upload it (the socket's
// updateMediaMessage), once per download, and records whether it asked and
// how that ended: a bounded log line, and `reupload` on the download's error.
//
// Baileys 7.0.0-rc14 is meant to ask by itself: downloadMediaMessage calls its
// reuploadRequest when the error has a numeric `status` of 404 or 410
// (lib/Utils/messages.js:836). Its CDN fetch throws a Boom that carries the
// HTTP status only in `output.statusCode` (lib/Utils/messages-media.js:304), so
// that check never matches and rc14 never asks. Evolution asks itself when
// Baileys did not.
//
// A 403 asks the phone only when the media link itself has expired: its `oe`
// query parameter (hex unix seconds, read from the url, else the directPath)
// has passed. Measured on WhatsApp's media CDN (2026-09-27, 84 history-sync
// attachments): 403 on 34 of 34 links whose `oe` had passed, on 0 of 50 valid
// ones, and a valid link to a file the CDN dropped answered 404 or 410.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { readFile, rm } from 'node:fs/promises';

import { MEDIA_REUPLOAD_TIMEOUT_MS } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { type Listening, startCdn, startHttpsServer, trustTestCertificate } from '../helpers/local-net';

const PHONE = '972509876543';
const CAPTION = 'Zq7 a private caption Zq7';
const ID = '3EB0CCCCCCCCCCCCCCC1';
const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const LIVE = '/v/t62.7118-24/reuploaded.enc';
const GONE = '/v/t62.7118-24/expired.enc';
const GONE_AGAIN = '/v/t62.7118-24/expired-again.enc';
const GONE_410 = '/v/t62.7118-24/expired-410.enc';
const GONE_403 = '/v/t62.7118-24/expired-403.enc';
/** A media link's `oe` (when it stops working): hex unix seconds, as WhatsApp writes it. */
const oe = (fromNowS: number) => (Math.floor(Date.now() / 1000) + fromNowS).toString(16).toUpperCase();
const DAY = 24 * 60 * 60;
const EXPIRED_LINK_403 = `${GONE_403}?ccb=11-4&oh=01_Q5Aa&oe=${oe(-DAY)}&_nc_sid=5e03e0`;
const VALID_LINK_403 = `${GONE_403}?ccb=11-4&oh=01_Q5Aa&oe=${oe(14 * DAY)}&_nc_sid=5e03e0`;
const BROKEN = '/v/t62.7118-24/broken.enc';

let cdn: Listening;
let mediaKey: Uint8Array;
let liveBody: Buffer;

// Refuse any connection that is not to 127.0.0.1: Evolution's own fallback
// retries the download at mmg.whatsapp.net, which must fail here, not leave.
const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(PLAIN, 'image', {});
  mediaKey = enc.mediaKey;
  const body = await readFile(enc.encFilePath);
  liveBody = body;
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({
    [LIVE]: body,
    [GONE_410]: 410,
    [GONE_403]: 403,
    [EXPIRED_LINK_403]: 403,
    [VALID_LINK_403]: 403,
    [BROKEN]: 500,
  });
  // Evolution waits 5s before its own fallback download, and gives the phone a
  // bounded time to answer a re-upload request; both are shortened here.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : MEDIA_REUPLOAD_TIMEOUT_MS && ms === MEDIA_REUPLOAD_TIMEOUT_MS ? 20 : ms, ...args)) as any);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => void cdn.log.splice(0));

const expiredImage = (path = GONE) => ({
  key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: ID },
  message: {
    imageMessage: {
      url: `http://127.0.0.1:${cdn.port}${path}`,
      mediaKey,
      mimetype: 'image/jpeg',
      caption: CAPTION,
      fileLength: PLAIN.length,
    },
  },
  messageTimestamp: 1_700_000_000,
  pushName: 'Sender',
});

type Phone = 'reuploads' | 'fails' | 'reuploads-expired' | 'silent';

/** A service whose socket answers a re-upload request the way `phone` says, counting the requests. */
async function serviceWithPhone(phone: Phone) {
  const made = await makeService();
  const asked: string[] = [];
  made.service.client.updateMediaMessage = async (message: any) => {
    asked.push(message.key.id);
    if (phone === 'silent') return new Promise(() => undefined);
    if (phone === 'fails') {
      // What Baileys raises when the phone reports the file is gone (messages-send.js updateMediaMessage).
      const { Boom } = await import('@hapi/boom');
      // Baileys puts the phone's decoded answer in the Boom's data (its result: 2 is NOT_FOUND).
      throw new Boom('Media re-upload failed by device (NOT_FOUND)', { data: { stanzaId: message.key.id, result: 2 }, statusCode: 404 });
    }
    // What Baileys does on success: point the message at the new copy (by url
    // alone here, since a directPath is fetched over https from the url's host).
    const path = phone === 'reuploads' ? LIVE : GONE_AGAIN;
    message.message.imageMessage.url = `http://127.0.0.1:${cdn.port}${path}`;
    return message;
  };
  return { ...made, asked };
}

/** Run a download, returning what it answered or threw and everything printed meanwhile. */
async function download(service: any, path = GONE) {
  let result: any;
  let thrown: any;
  const out = await captureOutput(async () => {
    try {
      result = await service.getBase64FromMediaMessage({ message: expiredImage(path) });
    } catch (e) {
      thrown = e;
    }
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  return { result, thrown, out: plain, lines: plain.split('\n').filter((l) => l.includes('media download:')) };
}

const line = (fields: string) => expect.stringContaining(`media download: message=${ID}, chat=user, ${fields}`);
const badRequest = (reupload: string, reuploadReason?: string) => ({
  status: 400,
  error: 'Bad Request',
  message: [expect.any(String)],
  reupload,
  ...(reuploadReason && { reuploadReason }),
});

function expectNothingPrivate(out: string) {
  expect(out).not.toContain(PHONE);
  expect(out).not.toContain('Zq7');
}

describe('a media download says whether it asked the phone to re-upload', () => {
  it('the phone re-uploads: the download succeeds and the log says so', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { result, thrown, out, lines } = await download(service);

    expect(thrown).toBeUndefined();
    expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${LIVE}`]);
    expect(lines).toEqual([line('outcome=reupload_requested'), line('outcome=reupload_ok')]);
    expectNothingPrivate(out);
  });

  it('the phone cannot re-upload: the error and the log say the re-upload failed', async () => {
    const { service, asked } = await serviceWithPhone('fails');
    const { thrown, out, lines } = await download(service);

    expect(asked).toEqual([ID]);
    expect(thrown).toEqual(badRequest('failed', 'NOT_FOUND'));
    expect(lines).toEqual([
      line('outcome=reupload_requested'),
      line('outcome=reupload_failed, error=Error, status=404, reason=NOT_FOUND'),
      line('outcome=download_failed, status=404, reupload=failed'),
    ]);
    expectNothingPrivate(out);
  });
});

describe('an expired media download asks the phone to re-upload, once', () => {
  it('a CDN 410 asks the phone too', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { result, thrown, lines } = await download(service, GONE_410);

    expect(thrown).toBeUndefined();
    expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE_410}`, `GET ${LIVE}`]);
    expect(lines).toEqual([line('outcome=reupload_requested'), line('outcome=reupload_ok')]);
  });

  it('a CDN 403 on a link whose oe has passed asks the phone', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { result, thrown, lines } = await download(service, EXPIRED_LINK_403);

    expect(thrown).toBeUndefined();
    expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${EXPIRED_LINK_403}`, `GET ${LIVE}`]);
    expect(lines).toEqual([line('outcome=reupload_requested'), line('outcome=reupload_ok')]);
  });

  it('a CDN 403 on a link whose oe has not passed does not ask the phone', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { thrown, out, lines } = await download(service, VALID_LINK_403);

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([`GET ${VALID_LINK_403}`]);
    expect(thrown).toEqual(badRequest('not_requested'));
    expect(lines).toEqual([line('outcome=download_failed, status=403, reupload=not_requested')]);
    expectNothingPrivate(out);
  });

  it('a CDN 403 on a link with no oe does not ask the phone', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { thrown, out, lines } = await download(service, GONE_403);

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([`GET ${GONE_403}`]);
    expect(thrown).toEqual(badRequest('not_requested'));
    expect(lines).toEqual([line('outcome=download_failed, status=403, reupload=not_requested')]);
    expectNothingPrivate(out);
  });

  it('a CDN 403 whose url has no oe reads it from the directPath', async () => {
    // A directPath is fetched over https from the url's host, so this CDN is https.
    const untrust = trustTestCertificate();
    const tlsCdn = await startHttpsServer((req, _body, res) => {
      if (req.url === LIVE) return void res.writeHead(200, { 'content-length': liveBody.length }).end(liveBody);
      res.writeHead(403).end();
    });
    try {
      const { service } = await makeService();
      const asked: string[] = [];
      service.client.updateMediaMessage = async (message: any) => {
        asked.push(message.key.id);
        message.message.imageMessage.directPath = LIVE;
        return message;
      };
      const directPath = `${GONE_403}?ccb=11-4&oh=01_Q5Aa&oe=${oe(-DAY)}&_nc_sid=5e03e0`;
      const message = expiredImage();
      message.message.imageMessage.url = `https://127.0.0.1:${tlsCdn.port}${GONE_403}`;
      (message.message.imageMessage as any).directPath = directPath;

      const result = await service.getBase64FromMediaMessage({ message });

      expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
      expect(asked).toEqual([ID]);
      expect(tlsCdn.log).toEqual([`GET ${directPath}`, `GET ${LIVE}`]);
    } finally {
      await tlsCdn.close();
      untrust();
    }
  });

  it('a re-uploaded copy that is gone as well is not re-uploaded again', async () => {
    const { service, asked } = await serviceWithPhone('reuploads-expired');
    const { thrown, out, lines } = await download(service);

    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${GONE_AGAIN}`]);
    expect(thrown).toEqual(badRequest('ok'));
    expect(lines).toEqual([
      line('outcome=reupload_requested'),
      line('outcome=reupload_ok'),
      line('outcome=download_failed, status=404, reupload=ok'),
    ]);
    expectNothingPrivate(out);
  });

  it('a phone that does not answer in time fails the re-upload', async () => {
    const { service, asked } = await serviceWithPhone('silent');
    const { thrown, out, lines } = await download(service);

    expect(MEDIA_REUPLOAD_TIMEOUT_MS).toBe(60_000);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`]);
    expect(thrown).toEqual(badRequest('failed', 'no_answer'));
    expect(lines).toEqual([
      line('outcome=reupload_requested'),
      line('outcome=reupload_failed, error=ReuploadTimeoutError, status=none, reason=no_answer'),
      line('outcome=download_failed, status=404, reupload=failed'),
    ]);
    expectNothingPrivate(out);
  });

  it('a failure that is not an expired file (a CDN 500) does not ask the phone', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { thrown, out, lines } = await download(service, BROKEN);

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([`GET ${BROKEN}`]);
    expect(thrown).toEqual(badRequest('not_requested'));
    expect(lines).toEqual([line('outcome=download_failed, status=500, reupload=not_requested')]);
    expectNothingPrivate(out);
  });
});
