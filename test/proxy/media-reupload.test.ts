// When a media file has expired on WhatsApp's CDN, the only copy left is on
// the sender's phone. Evolution hands Baileys' downloadMediaMessage a
// reuploadRequest (the socket's updateMediaMessage) for that case, and nothing
// recorded whether it was used or how it ended, so a failed download could not
// say whether the phone was asked and did not answer, or was never asked.
//
// Baileys 7.0.0-rc14 asks only when the download error has a numeric `status`
// of 404 or 410 (lib/Utils/messages.js downloadMediaMessage), but its CDN fetch
// throws a Boom that carries the HTTP status in `output.statusCode` and has no
// `status` (lib/Utils/messages-media.js getHttpStream). So rc14 never asks: an
// expired file fails without a re-upload request. BAILEYS_ASKS probes the build
// under test with a real 404, and the cases below run for the build that
// behaves each way (BAILEYS_DIR points the suite at another build).
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { readFile, rm } from 'node:fs/promises';

import { downloadMediaMessage, encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { type Listening, startCdn } from '../helpers/local-net';

const PHONE = '972509876543';
const CAPTION = 'Zq7 a private caption Zq7';
const ID = '3EB0CCCCCCCCCCCCCCC1';
const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const LIVE = '/v/t62.7118-24/reuploaded.enc';
const GONE = '/v/t62.7118-24/expired.enc';

/** Whether the Baileys under test asks for a re-upload when the CDN answers 404. */
const BAILEYS_ASKS = await (async () => {
  const cdn = await startCdn({});
  let asked = false;
  const expired = { key: { id: 'PROBE' }, message: { imageMessage: { url: `http://127.0.0.1:${cdn.port}${GONE}`, mediaKey: new Uint8Array(32) } } };
  const silent: any = { info: () => undefined, debug: () => undefined, trace: () => undefined, warn: () => undefined, error: () => undefined };
  await (downloadMediaMessage as any)(expired, 'buffer', {}, { logger: silent, reuploadRequest: async () => ((asked = true), Promise.reject(new Error('probe'))) }).catch(() => undefined);
  await cdn.close();
  return asked;
})();

let cdn: Listening;
let mediaKey: Uint8Array;

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
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({ [LIVE]: body });
  // Evolution waits 5s before its own fallback download; nothing here depends on the wait.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args)) as any);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => void cdn.log.splice(0));

const expiredImage = () => ({
  key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: ID },
  message: {
    imageMessage: {
      url: `http://127.0.0.1:${cdn.port}${GONE}`,
      mediaKey,
      mimetype: 'image/jpeg',
      caption: CAPTION,
      fileLength: PLAIN.length,
    },
  },
  messageTimestamp: 1_700_000_000,
  pushName: 'Sender',
});

/** A service whose socket answers a re-upload request the way `answer` says, counting the requests. */
async function serviceWithPhone(answer: 'reuploads' | 'fails') {
  const made = await makeService();
  const asked: string[] = [];
  made.service.client.updateMediaMessage = async (message: any) => {
    asked.push(message.key.id);
    if (answer === 'fails') {
      // What Baileys raises when the phone reports the file is gone (messages-send.js updateMediaMessage).
      const { Boom } = await import('@hapi/boom');
      throw new Boom('Media re-upload failed by device (NOT_FOUND)', { statusCode: 404 });
    }
    // What Baileys does on success: point the message at the new copy (by url
    // alone here, since a directPath is fetched over https from the url's host).
    message.message.imageMessage.url = `http://127.0.0.1:${cdn.port}${LIVE}`;
    return message;
  };
  return { ...made, asked };
}

/** Run a download, returning what it answered or threw and everything printed meanwhile. */
async function download(service: any) {
  let result: any;
  let thrown: any;
  const out = await captureOutput(async () => {
    try {
      result = await service.getBase64FromMediaMessage({ message: expiredImage() });
    } catch (e) {
      thrown = e;
    }
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  return { result, thrown, out: plain, lines: plain.split('\n').filter((l) => l.includes('media download:')) };
}

const line = (fields: string) => expect.stringContaining(`media download: message=${ID}, chat=user, ${fields}`);

function expectNothingPrivate(out: string) {
  expect(out).not.toContain(PHONE);
  expect(out).not.toContain('Zq7');
}

describe('a media download says whether it asked the phone to re-upload', () => {
  it.runIf(!BAILEYS_ASKS)('Baileys does not ask: the error and the log say no re-upload was requested', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { thrown, out, lines } = await download(service);

    expect(asked).toEqual([]);
    expect(cdn.log).toEqual([`GET ${GONE}`]);
    expect(thrown).toEqual({ status: 400, error: 'Bad Request', message: [expect.any(String)], reupload: 'not_requested' });
    expect(lines).toEqual([line('outcome=download_failed, status=404, reupload=not_requested')]);
    expectNothingPrivate(out);
  });

  it.runIf(BAILEYS_ASKS)('the phone re-uploads: the download succeeds and the log says so', async () => {
    const { service, asked } = await serviceWithPhone('reuploads');
    const { result, thrown, out, lines } = await download(service);

    expect(thrown).toBeUndefined();
    expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${LIVE}`]);
    expect(lines).toEqual([line('outcome=reupload_requested'), line('outcome=reupload_ok')]);
    expectNothingPrivate(out);
  });

  it.runIf(BAILEYS_ASKS)('the phone cannot re-upload: the error and the log say the re-upload failed', async () => {
    const { service, asked } = await serviceWithPhone('fails');
    const { thrown, out, lines } = await download(service);

    expect(asked).toEqual([ID]);
    expect(thrown).toEqual({ status: 400, error: 'Bad Request', message: [expect.any(String)], reupload: 'failed' });
    expect(lines).toEqual([
      line('outcome=reupload_requested'),
      line('outcome=reupload_failed, error=Error, status=404'),
      line('outcome=download_failed, status=404, reupload=failed'),
    ]);
    expectNothingPrivate(out);
  });
});
