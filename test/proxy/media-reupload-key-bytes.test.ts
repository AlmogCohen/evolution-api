// A consumer hands getBase64FromMediaMessage a message over HTTP JSON, so the
// media key is no longer bytes: a base64 string, the index-keyed object
// JSON.stringify makes of a Uint8Array ({"0":..,"1":..}), or the
// {type:'Buffer',data:[..]} it makes of a Node Buffer. Baileys' download reads
// a base64 string itself (getMediaKeys), but its re-upload does not:
// updateMediaMessage derives the retry key with hkdf(mediaKey) as given
// (getMediaRetryKey, lib/Utils/messages-media.js:701), and decryptMediaRetryData
// then fails the phone's answer with "Unsupported state or unable to
// authenticate data" (seen live, 2026-09-27, on every re-upload asked for over
// HTTP). Evolution turns the key back into bytes before it asks.
//
// The socket's updateMediaMessage below is Baileys' own (lib/Socket/messages-send.js:1011),
// on Baileys' real encryptMediaRetryRequest, decodeMediaRetryNode and
// decryptMediaRetryData. The phone answers the way a phone does: a
// MediaRetryNotification encrypted under the file's true media key.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

import { Boom } from '@hapi/boom';
import {
  aesEncryptGCM,
  assertMediaContent,
  decodeMediaRetryNode,
  decryptMediaRetryData,
  encryptedStream,
  encryptMediaRetryRequest,
  getUrlFromDirectPath,
  hkdf,
  proto,
} from 'baileys';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService, WUID } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { type Listening, loopbackOnly, startHttpsServer, trustTestCertificate } from '../helpers/local-net';

const ID = '3EB0ABABABABABABABA1';
const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const GONE = '/v/t62.7118-24/expired.enc';
const NEW = '/v/t62.7118-24/reuploaded.enc';

let cdn: Listening;
let host: string;
let mediaKey: Buffer;
let untrust: () => void;
let net: ReturnType<typeof loopbackOnly>;

beforeAll(async () => {
  net = loopbackOnly();
  untrust = trustTestCertificate();
  const enc = await encryptedStream(PLAIN, 'image', {});
  mediaKey = Buffer.from(enc.mediaKey);
  const body = await readFile(enc.encFilePath);
  await rm(enc.encFilePath, { force: true });
  // WhatsApp's media servers: the expired copy is gone, the phone's new one is there.
  cdn = await startHttpsServer((req, _body, res) => {
    if (req.url === NEW) return void res.writeHead(200, { 'content-length': body.length }).end(body);
    res.writeHead(404).end();
  });
  host = `127.0.0.1:${cdn.port}`;
  // Evolution waits 5s before its own fallback download.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args)) as any);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cdn.close();
  untrust();
  net.restore();
});

beforeEach(() => {
  cdn.log.splice(0);
  net.refused.splice(0);
});

/** The phone's answer to a re-upload request: the new copy's directPath, encrypted under the file's true media key. */
function phoneAnswers(request: any) {
  const id = request.attrs.id;
  const plain = proto.MediaRetryNotification.encode({ stanzaId: id, directPath: NEW, result: proto.MediaRetryNotification.ResultType.SUCCESS }).finish();
  const iv = randomBytes(12);
  const retryKey = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });
  const ciphertext = aesEncryptGCM(plain, retryKey, iv, Buffer.from(id));
  return {
    tag: 'receipt',
    attrs: { id },
    content: [
      { tag: 'encrypt', attrs: {}, content: [{ tag: 'enc_p', attrs: {}, content: ciphertext }, { tag: 'enc_iv', attrs: {}, content: iv }] },
      { tag: 'rmr', attrs: { jid: '972509876543@s.whatsapp.net', from_me: 'false' } },
    ],
  };
}

async function serviceWithPhone() {
  const made = await makeService();
  const asked: string[] = [];
  // Baileys' updateMediaMessage, with the node round trip done in process.
  made.service.client.updateMediaMessage = async (message: any) => {
    asked.push(message.key.id);
    const content: any = assertMediaContent(message.message);
    const mediaKey = content.mediaKey;
    const request = encryptMediaRetryRequest(message.key, mediaKey, WUID);
    const result: any = decodeMediaRetryNode(phoneAnswers(request) as any);
    if (result.error) throw result.error;
    const media = decryptMediaRetryData(result.media, mediaKey, result.key.id);
    if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
      throw new Boom(`Media re-upload failed by device (${proto.MediaRetryNotification.ResultType[media.result]})`, { data: media });
    }
    content.directPath = media.directPath;
    content.url = getUrlFromDirectPath(content.directPath, host);
    return message;
  };
  return { ...made, asked };
}

/** The media key as a consumer holding the message as JSON sends it. */
const shapes: [string, () => any][] = [
  ['bytes (control)', () => Uint8Array.from(mediaKey)],
  ['a base64 string', () => mediaKey.toString('base64')],
  ['an index-keyed object (JSON of a Uint8Array)', () => JSON.parse(JSON.stringify(Uint8Array.from(mediaKey)))],
  ["a {type:'Buffer', data} object (JSON of a Buffer)", () => JSON.parse(JSON.stringify(mediaKey))],
];

describe('a re-upload works when the media key arrives as text', () => {
  it.each(shapes)('media key as %s: the phone is asked, and the download gets the new copy', async (_shape, key) => {
    const { service, asked } = await serviceWithPhone();
    let result: any;
    let thrown: any;
    const out = await captureOutput(async () => {
      try {
        result = await service.getBase64FromMediaMessage({
          message: {
            key: { remoteJid: '972509876543@s.whatsapp.net', fromMe: false, id: ID },
            message: { imageMessage: { url: `https://${host}${GONE}`, mediaKey: key(), mimetype: 'image/jpeg', fileLength: PLAIN.length } },
          },
        });
      } catch (e) {
        thrown = e;
      }
    });
    const lines = out
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((l) => l.includes('media download:'))
      .map((l) => l.slice(l.indexOf('media download:')));

    expect(asked).toEqual([ID]);
    expect(lines).toEqual([
      `media download: message=${ID}, chat=user, outcome=reupload_requested`,
      `media download: message=${ID}, chat=user, outcome=reupload_ok`,
    ]);
    expect(thrown).toBeUndefined();
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${NEW}`]);
    expect(Buffer.from(result.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(net.refused).toEqual([]);
  });
});
