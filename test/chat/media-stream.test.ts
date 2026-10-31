// POST /chat/streamMediaMessage/:instance takes what /chat/getBase64FromMediaMessage
// takes (the message, `reupload`) and answers the file itself, decrypted, as it
// arrives from WhatsApp's servers: application/octet-stream, the media's type in
// `x-media-mimetype`. getBase64FromMediaMessage holds the whole file, then its
// base64, then the JSON around it, which is about three times the file per
// download on a server that carries every other number too: a 200 MB recording
// cannot come through it. A failure before the first byte answers what
// getBase64FromMediaMessage answers (the same 400, `reupload`, `reuploadReason`);
// a failure after it cuts the answer short, never ends it as if it were whole.
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
import { readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';

const TOKEN = 'instance-token';
const ID = '3EB0EEEEEEEEEEEEEEE1';
/** Large enough to arrive in many chunks, small enough for a test. */
const PLAIN = randomBytes(4 * 1024 * 1024);
const LIVE = '/v/t62.7118-24/live.enc';
const HELD = '/v/t62.7118-24/held.enc';
const CUT = '/v/t62.7118-24/cut.enc';
const REUPLOADED = '/v/t62.7118-24/reuploaded.enc';
const GONE = '/v/t62.7118-24/expired.enc';
const GONE_MESSAGE =
  "The media is no longer on WhatsApp's servers (HTTP 404), and no re-upload from the phone was attempted (reupload: false)";

let encrypted: Buffer;
let mediaKey: Uint8Array;
let app: Awaited<ReturnType<typeof startChatApp>>;
let asked: string[];

/**
 * WhatsApp's CDN, as far as these tests need it. HELD sends the first half and
 * waits for `release` before the rest; CUT sends the first half and drops the
 * connection.
 */
const cdn = {
  port: 0,
  log: [] as string[],
  release: () => {},
  server: undefined as http.Server | undefined,
};

// Refuse any connection that is not to 127.0.0.1, before any lookup: Evolution's
// fallback retries the download at mmg.whatsapp.net, which must fail here, not leave.
const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  const enc = await encryptedStream(PLAIN, 'document', {});
  mediaKey = enc.mediaKey;
  encrypted = await readFile(enc.encFilePath);
  await rm(enc.encFilePath, { force: true });
  const half = Math.floor(encrypted.length / 2);
  cdn.server = http.createServer((req, res) => {
    cdn.log.push(`GET ${req.url}`);
    if (req.url === LIVE || req.url === REUPLOADED) {
      return void res.writeHead(200, { 'content-length': encrypted.length }).end(encrypted);
    }
    if (req.url === HELD) {
      res.writeHead(200, { 'content-length': encrypted.length });
      res.write(encrypted.subarray(0, half));
      cdn.release = () => res.end(encrypted.subarray(half));
      return;
    }
    if (req.url === CUT) {
      res.writeHead(200, { 'content-length': encrypted.length });
      res.write(encrypted.subarray(0, half), () => setTimeout(() => res.socket?.destroy(), 50));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => cdn.server!.listen(0, '127.0.0.1', resolve));
  cdn.port = (cdn.server.address() as AddressInfo).port;

  // Evolution waits 5s before its own fallback download; shortened, as in media-skip-reupload.test.ts.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args)) as any);

  await prisma.instance.create({
    data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' },
  });
  const { service } = await makeService({ prisma });
  asked = [];
  service.client.updateMediaMessage = async (message: any) => {
    asked.push(message.key.id);
    // What Baileys does when the phone re-uploads: point the message at the new copy.
    message.message.documentMessage.url = `http://127.0.0.1:${cdn.port}${REUPLOADED}`;
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
  cdn.server?.closeAllConnections();
  await new Promise((r) => cdn.server?.close(r));
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

beforeEach(() => {
  cdn.log.splice(0);
  asked.length = 0;
});

/** A stored document message as a consumer holds it: JSON, the media key an object of bytes. */
const document = (path: string) =>
  JSON.parse(
    JSON.stringify({
      key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: ID },
      message: {
        documentMessage: {
          url: `http://127.0.0.1:${cdn.port}${path}`,
          mediaKey: Uint8Array.from(mediaKey),
          mimetype: 'audio/mp4',
          fileName: 'meeting.m4a',
          fileLength: PLAIN.length,
        },
      },
      messageTimestamp: 1_700_000_000,
    }),
  );

const post = (body: Record<string, any>) =>
  fetch(`${app.base}/chat/streamMediaMessage/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: TOKEN },
    body: JSON.stringify(body),
  });

/** Never 5000 ms: the spy above turns a 5000 ms timer into 0. */
const WAIT_MS = 4000;
const within = <T>(ms: number, promise: Promise<T>) =>
  Promise.race([promise, new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms))]);

describe('a media download can be streamed', () => {
  it('answers the decrypted file as a stream of bytes, its type in a header', async () => {
    const res = await post({ message: document(LIVE) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-media-mimetype')).toBe('audio/mp4');
    expect(Buffer.from(await res.arrayBuffer()).equals(PLAIN)).toBe(true);
    expect(cdn.log).toEqual([`GET ${LIVE}`]);
  });

  it('the first bytes reach the consumer before WhatsApp has sent the last', async () => {
    const res = await within(WAIT_MS, post({ message: document(HELD) }));
    if (res === 'timed out') {
      cdn.release();
      throw new Error('no answer until the whole file had arrived');
    }
    const reader = res.body!.getReader();
    const first = await within(WAIT_MS, reader.read());
    cdn.release();
    expect(first).not.toBe('timed out');

    const chunks = [Buffer.from((first as { value: Uint8Array }).value)];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    expect(Buffer.concat(chunks).equals(PLAIN)).toBe(true);
  });

  it('a download that breaks off midway cuts the answer short: it never ends as if it were whole', async () => {
    const res = await post({ message: document(CUT) });

    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('reupload: false and an expired file: the same 400 as getBase64FromMediaMessage, and the phone is not asked', async () => {
    const res = await post({ message: document(GONE), reupload: false });

    expect(asked).toEqual([]);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 400,
      body: { status: 400, error: 'Bad Request', response: { message: [GONE_MESSAGE], reupload: 'not_requested' } },
    });
  });

  it('reupload omitted and an expired file: the phone is asked, and the copy it sends is streamed', async () => {
    const res = await post({ message: document(GONE) });

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PLAIN)).toBe(true);
    expect(asked).toEqual([ID]);
    expect(cdn.log).toEqual([`GET ${GONE}`, `GET ${REUPLOADED}`]);
  });
});
