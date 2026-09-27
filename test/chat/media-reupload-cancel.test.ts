// A re-upload request waits for the phone's answer for MEDIA_REUPLOAD_TIMEOUT_MS, and then the
// download fails with no_answer. But Baileys' updateMediaMessage waits for that answer with no
// timeout of its own: a listener on messages.media-update and one on connection.update, removed
// only when an answer for the message arrives or the connection closes. Evolution stopped waiting
// and left them there: every unanswered request on a long connection kept two listeners, the
// message and its key, and an answer arriving later still rewrote the message and emitted
// messages.update after the API had answered no_answer.
//
// The socket's updateMediaMessage here is Baileys' own shape: it writes the request and waits with
// Baileys' own bindWaitForEvent on the real event buffer.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { rm } from 'node:fs/promises';

import { MEDIA_REUPLOAD_TIMEOUT_MS } from '@api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { bindWaitForEvent, encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { type Listening, startCdn } from '../helpers/local-net';

const PHONE = '972509876543@s.whatsapp.net';
const ID = '3EB0CCCCCCCCCCCCCCC1';
const GONE = '/v/t62.7118-24/expired.enc';

let cdn: Listening;
let mediaKey: Uint8Array;
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
  // Evolution's 5s fallback wait and the phone's answer time, shortened.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms === MEDIA_REUPLOAD_TIMEOUT_MS ? 20 : ms, ...args)) as any);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

describe('a re-upload the phone does not answer in time', () => {
  it('leaves no waiter behind, and an answer arriving later changes nothing', async () => {
    const { service, ev } = await makeService();
    const listening: Record<string, number> = {};
    const on = ev.on.bind(ev);
    const off = ev.off.bind(ev);
    ev.on = (event: string, listener: any) => ((listening[event] = (listening[event] ?? 0) + 1), on(event, listener));
    ev.off = (event: string, listener: any) => ((listening[event] = (listening[event] ?? 0) - 1), off(event, listener));
    const waitForMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');
    const lateUpdates: any[] = [];
    service.client.updateMediaMessage = async (message: any) => {
      // As Baileys: write the request (nothing to write here), then wait for the answer, untimed.
      await waitForMediaUpdate(async (update: any[]) => !!update.find((u) => u.key.id === message.key.id));
      lateUpdates.push(message.key.id);
      ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);
      return message;
    };

    const failed = await service
      .getBase64FromMediaMessage({
        message: {
          key: { remoteJid: PHONE, fromMe: false, id: ID },
          message: { imageMessage: { url: `http://127.0.0.1:${cdn.port}${GONE}`, mediaKey, mimetype: 'image/jpeg' } },
        },
      })
      .catch((e: any) => e);
    expect(failed?.reuploadReason).toBe('no_answer');
    await new Promise((r) => setTimeout(r, 10));
    const waiters = {
      media: listening['messages.media-update'] ?? 0,
      close: listening['connection.update'] ?? 0,
    };

    // The phone answers after all.
    ev.emit('messages.media-update', [{ key: { remoteJid: PHONE, fromMe: false, id: ID }, media: {} }]);
    await new Promise((r) => setTimeout(r, 10));
    expect({ waiters, lateUpdates }).toEqual({ waiters: { media: 0, close: 0 }, lateUpdates: [] });
  });
});
