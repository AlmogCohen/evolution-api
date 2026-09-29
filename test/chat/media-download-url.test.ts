// A WhatsApp media link is signed per message: its `oh` and `oe` query
// parameters let anyone holding it fetch the (encrypted) file until it
// expires. A deployment running with LOG_LEVEL=ERROR,WARN and LOG_BAILEYS=error
// must not print one. Seen live: when the download, the re-upload and the
// fallback download all failed, Evolution logged the fallback's error object,
// whose message and data both carry https://mmg.whatsapp.net/...&oh=...&oe=...
//
// Baileys downloads from https://<the url's host><directPath>, so the first
// download goes to a local HTTPS CDN (the test certificate, trusted for the
// test) that answers 410. The phone refuses the re-upload with an <error code>
// answer, read by Baileys' own decodeMediaRetryNode. The fallback, which
// Evolution sends to https://mmg.whatsapp.net + directPath whatever the url
// says, is answered 410 in-process by the undici mock agent, so nothing leaves
// 127.0.0.1.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { rm } from 'node:fs/promises';

import { makeBaileysLogger } from '@utils/log-privacy';
import { decodeMediaRetryNode, encryptedStream, getHttpStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { type Listening, startHttpsServer, trustTestCertificate } from '../helpers/local-net';

const PHONE = '972509876543';
const ID = '3EB0CCCCCCCCCCCCCCC1';
// The shape WhatsApp's links have: a path, then ccb, oh (the signature), oe (the expiry, hex) and _nc_sid.
const DIRECT_PATH = '/v/t62.7118-24/gone.enc?ccb=11-4&oh=01_Q5Aa1wSecretSignatureXyz&oe=6A0B1C2D&_nc_sid=5e03e0';
const LEAKS = ['http://', 'https://', 'mmg.whatsapp.net', 'oh=', 'oe=', 'Q5Aa1wSecretSignatureXyz', '_nc_sid', PHONE];

let cdn: Listening;
let mediaKey: Uint8Array;
let untrust: () => void;

const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(Buffer.from('a photo'), 'image', {});
  mediaKey = enc.mediaKey;
  await rm(enc.encFilePath, { force: true });
  untrust = trustTestCertificate();
  cdn = await startHttpsServer((_req, _body, res) => void res.writeHead(410).end());
  // Evolution waits 5s before its fallback download; shortened here.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args)) as any);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cdn.close();
  untrust();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

/** Every line of `out` that carries any part of a media link, stripped of colour and truncated. */
function leaks(out: string) {
  return out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => LEAKS.some((l) => line.includes(l)))
    .map((line) => line.trim().slice(0, 200));
}

const cdnGone = () => guard.get('https://mmg.whatsapp.net').intercept({ path: DIRECT_PATH, method: 'GET' }).reply(410);

describe('a failed media download never logs the media URL', () => {
  it('download, re-upload and fallback all fail: no link, signature or expiry in the output', async () => {
    const { service } = await makeService();
    // The phone's <error code="2"> answer, as updateMediaMessage throws it.
    const rmr = { tag: 'rmr', attrs: { jid: `${PHONE}@s.whatsapp.net`, from_me: 'false' } };
    service.client.updateMediaMessage = async () => {
      throw (decodeMediaRetryNode({ tag: 'receipt', attrs: { id: ID }, content: [rmr, { tag: 'error', attrs: { code: '2' } }] } as any) as any).error;
    };
    cdnGone();
    const message = {
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: ID },
      message: {
        imageMessage: { url: `https://127.0.0.1:${cdn.port}${DIRECT_PATH}`, directPath: DIRECT_PATH, mediaKey, mimetype: 'image/jpeg' },
      },
    };

    let thrown: any;
    const out = await captureOutput(async () => {
      try {
        await service.getBase64FromMediaMessage({ message });
      } catch (e) {
        thrown = e;
      }
    });

    expect(cdn.log).toEqual([`GET ${DIRECT_PATH}`]);
    guard.assertNoPendingInterceptors(); // the fallback asked mmg.whatsapp.net, and got its 410
    expect(thrown?.status).toBe(400);
    expect(leaks(out)).toEqual([]);
    // The download's own lines are unchanged; the fallback and the final failure each get a line of bounded fields.
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const from = (prefix: string) => plain.filter((l) => l.includes(prefix)).map((l) => l.slice(l.indexOf(prefix)).trim());
    expect(from('media download:')).toEqual([
      `media download: message=${ID}, chat=user, outcome=reupload_requested`,
      `media download: message=${ID}, chat=user, outcome=reupload_failed, error=Error, status=404, reason=error_2`,
      `media download: message=${ID}, chat=user, outcome=download_failed, status=410, reupload=failed`,
    ]);
    expect(from('media fallback:')).toEqual([`media fallback: message=${ID}, chat=user, outcome=failed, error=Error, status=410`]);
    expect(from('media processing failed:')).toEqual([`media processing failed: message=${ID}, chat=user, error=Error, status=410`]);
  });

  it('the same error in a Baileys log line (the logger Evolution hands Baileys) is printed without its link', async () => {
    cdnGone();
    const error = await getHttpStream(`https://mmg.whatsapp.net${DIRECT_PATH}`).catch((e) => e);
    expect(error?.message).toBe(`Failed to fetch stream from https://mmg.whatsapp.net${DIRECT_PATH}`);

    const out = await captureOutput(async () => {
      const logger = makeBaileysLogger('error');
      logger.error({ err: error, key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: ID } }, `failed to download ${error.message}`);
      await new Promise((r) => setTimeout(r, 20)); // pino's async write
    });

    expect(out).toContain('Failed to fetch stream from');
    expect(leaks(out)).toEqual([]);
  });
});
