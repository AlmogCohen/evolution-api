// With webhookBase64 on, Evolution downloads a message's media to put it in
// the webhook. When that download fails, the error Baileys throws says
// "Failed to fetch stream from <the signed media link>": its `oh` and `oe`
// let anyone holding it fetch the file until it expires. The log line for the
// failure must say which message and why, never the link.
//
// Both directions: an incoming message's media, and a sent message's (Evolution
// downloads what it just uploaded, from the link WhatsApp's upload answer gave).
//
// Baileys downloads from https://<the url's host><directPath>, so the file is
// on a local HTTPS CDN (the test certificate, trusted for the test) that
// answers 410. The undici mock agent refuses anything not on 127.0.0.1.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { rm } from 'node:fs/promises';

import { encryptedStream, generateWAMessage } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, WUID } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { emitted } from '../helpers/fake-server-module';
import { type Listening, startHttpsServer, trustTestCertificate } from '../helpers/local-net';
import type { Profile } from '../helpers/profiles';

const PHONE = '972509876543';
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
});

afterAll(async () => {
  await cdn.close();
  untrust();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => {
  cdn.log.splice(0);
  emitted.splice(0);
});

/** Every line of `out` that carries any part of a media link, stripped of colour and truncated. */
function leaks(out: string) {
  return out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => LEAKS.some((l) => line.includes(l)))
    .map((line) => line.trim().slice(0, 200));
}

/** The log objects printed for a failed base64 conversion. */
function conversionLines(out: string) {
  return out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.includes('Error converting media to base64'))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))));
}

describe.each(['minimal', 'stored'] as Profile[])('a failed media conversion never logs the media URL (profile %s)', (profile) => {
  it('an incoming image whose download fails', async () => {
    const { service, ev } = await makeService({ profile });
    Object.assign(service.localWebhook, { enabled: true, webhookBase64: true });
    const id = `3EB0DDDDDDDDDDDDDD-${profile}`;
    const incoming = {
      key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id },
      message: {
        imageMessage: { url: `https://127.0.0.1:${cdn.port}${DIRECT_PATH}`, directPath: DIRECT_PATH, mediaKey, mimetype: 'image/jpeg' },
      },
      messageTimestamp: 1_700_000_000,
      pushName: 'Sender',
    };

    const out = await captureOutput(() => deliver(service, ev, { 'messages.upsert': { messages: [incoming], type: 'notify' } }));

    expect(cdn.log).toEqual([`GET ${DIRECT_PATH}`]);
    // The message still reaches the webhook, without the media.
    const upsert = emitted.find((e) => e.event === 'messages.upsert');
    expect(upsert?.data?.key?.id).toBe(id);
    expect(upsert?.data?.message?.base64).toBeUndefined();
    expect(leaks(out)).toEqual([]);
    expect(conversionLines(out)).toEqual([
      {
        message: 'Error converting media to base64',
        messageId: id,
        chatType: 'user',
        error: { name: 'Error', message: 'Failed to fetch stream from [url]', statusCode: 410 },
      },
    ]);
  });

  it('a sent document whose download fails', async () => {
    const { service } = await makeService({ profile });
    Object.assign(service.localWebhook, { enabled: true, webhookBase64: true });
    const id = `3EB0EEEEEEEEEEEEEE-${profile}`;
    Object.assign(service.client, {
      onWhatsApp: async (...jids: string[]) => jids.map((jid) => ({ exists: true, jid })),
      // WhatsApp's answer to an upload: where the encrypted file now is.
      waUploadToServer: async () => ({ mediaUrl: `https://127.0.0.1:${cdn.port}${DIRECT_PATH}`, directPath: DIRECT_PATH }),
      // What the socket sends and returns, built by Baileys (Evolution sends media as a { forward }).
      sendMessage: (jid: string, content: any) => generateWAMessage(jid, content, { userJid: WUID, messageId: id } as any),
      presenceSubscribe: async () => undefined,
      sendPresenceUpdate: async () => undefined,
    });

    let sent: any;
    const out = await captureOutput(async () => {
      sent = await service.mediaMessage({
        number: PHONE,
        mediatype: 'document',
        mimetype: 'application/pdf',
        fileName: 'a.pdf',
        media: Buffer.from('%PDF-1.4 a document').toString('base64'),
      });
    });

    expect(sent?.key?.id).toBe(id);
    expect(cdn.log).toEqual([`GET ${DIRECT_PATH}`]);
    expect(leaks(out)).toEqual([]);
    expect(conversionLines(out)).toEqual([
      {
        message: 'Error converting media to base64',
        messageId: id,
        chatType: 'user',
        error: { name: 'Error', message: 'Failed to fetch stream from [url]', statusCode: 410 },
      },
    ]);
  });
});
