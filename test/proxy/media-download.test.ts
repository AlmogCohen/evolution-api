// A deployment can give each linked account its own proxy exit (Evolution's per-instance
// proxy, /proxy/set, the Proxy table). The socket leaves through it; media
// downloads must leave through the same exit, or the account's media is fetched
// from the server's own IP while its messages come from the person's.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { readFile, rm } from 'node:fs/promises';

import { encryptedStream } from 'baileys';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import { type Listening, startCdn, startHttpProxy, startSocks5Proxy } from '../helpers/local-net';

const PLAIN = Buffer.from('a photo, as the person sent it '.repeat(200));
const PATH = '/v/t62.7118-24/media.enc';

let cdn: Listening;
let mediaKey: Uint8Array;

// Refuse any connection that is not to 127.0.0.1, whatever path a request takes.
const previousDispatcher = getGlobalDispatcher();
const guard = new MockAgent();
guard.disableNetConnect();
guard.enableNetConnect((host: string) => host.startsWith('127.0.0.1:'));

beforeAll(async () => {
  setGlobalDispatcher(guard);
  // Encrypt with Baileys' own upload path, so the CDN serves exactly what WhatsApp would.
  const enc = await encryptedStream(PLAIN, 'image', {});
  mediaKey = enc.mediaKey;
  const body = await readFile(enc.encFilePath);
  await rm(enc.encFilePath, { force: true });
  cdn = await startCdn({ [PATH]: body });
});

afterAll(async () => {
  await cdn.close();
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
});

const proxies: Listening[] = [];
beforeEach(() => {
  cdn.log.splice(0);
  emitted.splice(0);
});
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
});

const imageMessage = () => ({
  key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: '3EB0BBBBBBBBBBBBBBBB' },
  message: {
    imageMessage: {
      url: `http://127.0.0.1:${cdn.port}${PATH}`,
      mediaKey,
      mimetype: 'image/jpeg',
      fileLength: PLAIN.length,
    },
  },
  messageTimestamp: 1_700_000_000,
  pushName: 'Sender',
});

/** Set the instance's proxy the way /proxy/set does, then load it the way a connect does. */
async function serviceBehind(protocol: 'http' | 'socks5') {
  const proxy = protocol === 'http' ? await startHttpProxy() : await startSocks5Proxy();
  proxies.push(proxy);
  const made = await makeService();
  await made.service.setProxy({
    enabled: true,
    host: '127.0.0.1',
    port: String(proxy.port),
    protocol,
    username: '',
    password: '',
  });
  await made.service.loadProxy();
  return { ...made, proxy };
}

const tunnelled = (protocol: 'http' | 'socks5') =>
  protocol === 'http' ? `CONNECT 127.0.0.1:${cdn.port}` : `SOCKS5 127.0.0.1:${cdn.port}`;

describe('media downloads leave through the instance proxy', () => {
  it('control: with no proxy, getBase64FromMediaMessage fetches the CDN directly', async () => {
    const { service } = await makeService();
    const media = await service.getBase64FromMediaMessage({ message: imageMessage() });
    expect(Buffer.from(media.base64, 'base64').equals(PLAIN)).toBe(true);
    expect(cdn.log).toEqual([`GET ${PATH}`]);
  });

  for (const protocol of ['http', 'socks5'] as const) {
    it(`getBase64FromMediaMessage (/chat/getBase64FromMediaMessage, and S3 storage) goes through a ${protocol} proxy`, async () => {
      const { service, proxy } = await serviceBehind(protocol);
      const media = await service.getBase64FromMediaMessage({ message: imageMessage() });
      expect(Buffer.from(media.base64, 'base64').equals(PLAIN)).toBe(true);
      expect(proxy.log).toEqual([tunnelled(protocol)]);
      expect(cdn.log).toEqual([`GET ${PATH}`]);
    });
  }

  it('the messages.upsert webhook base64 download goes through the proxy', async () => {
    const { service, ev, proxy } = await serviceBehind('http');
    Object.assign(service.localWebhook, { enabled: true, webhookBase64: true });
    await deliver(service, ev, { 'messages.upsert': { messages: [imageMessage()], type: 'notify' } });
    const upsert = emitted.find((e) => e.event === 'messages.upsert');
    expect(Buffer.from(upsert?.data?.message?.base64 ?? '', 'base64').equals(PLAIN)).toBe(true);
    expect(proxy.log).toEqual([tunnelled('http')]);
    expect(cdn.log).toEqual([`GET ${PATH}`]);
  });
});
