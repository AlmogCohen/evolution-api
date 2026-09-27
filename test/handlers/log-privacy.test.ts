// A deployment can run Evolution with LOG_LEVEL=ERROR,WARN and LOG_BAILEYS=error
// on the promise that payloads never reach the logs. Each case drives one path
// that handles a message, a contact or a call with a distinctive text, phone
// number and push name, and asserts that none of the three is printed:
// not by Evolution's logger, not by a bare console call, and not by the pino
// logger Evolution hands Baileys.
import { vi } from 'vitest';

const sockets = vi.hoisted(() => ({ make: undefined as undefined | ((config: any) => any) }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));
// createClient() builds the socket with makeWASocket; the fake returns the
// harness client plus a ws emitter, and keeps the config (and so the logger)
// Evolution passed.
vi.mock('baileys', async (importOriginal) => {
  const real: any = await importOriginal();
  const makeWASocket = (config: any) => sockets.make!(config);
  return { ...real, default: makeWASocket, makeWASocket };
});

import { EventEmitter } from 'node:events';

import { binaryNodeToString, decryptMessageNode } from 'baileys';
import { describe, expect, it } from 'vitest';

import { historyEvent, msg } from '../helpers/baileys-fixtures';
import { deliver, makeService, settle, WUID } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import type { Profile } from '../helpers/profiles';

const PHONE = '972509876543';
const TEXT = 'Zq7 the private sentence Zq7';
const NAME = 'Dana Kfirovich';
const SENDER = `${PHONE}@s.whatsapp.net`;
// An old-format group id embeds its creator's phone number.
const GROUP = `${PHONE}-1600000000@g.us`;
const SECRETS = { text: 'Zq7', phone: PHONE, name: NAME };

/** Each secret that appears in the output, with the line it appeared on (truncated). */
function leaks(out: string) {
  const found: string[] = [];
  for (const [what, secret] of Object.entries(SECRETS)) {
    const line = out.split('\n').find((l) => l.includes(secret));
    if (line !== undefined) found.push(`${what}: ${line.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 160)}`);
  }
  return found;
}

const incoming = (id: string, extra: Record<string, any> = {}) => ({ ...msg(SENDER, id, TEXT).message, pushName: NAME, ...extra });

/** Run createClient() against the fake socket, so the ws handlers and the Baileys logger are Evolution's own. */
async function connect(service: any, ev: any) {
  const client = service.client;
  let config: any;
  sockets.make = (c: any) => ((config = c), { ...client, ev, ws: new EventEmitter() });
  service.defineAuthState = async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => undefined });
  service.localSettings ??= {};
  await service.createClient();
  service.__wired = true; // createClient() already called eventHandler()
  return { socket: service.client, config };
}

describe.each(['minimal', 'stored'] as Profile[])('nothing a message carries reaches the logs (profile %s)', (profile) => {
  it('an ordinary incoming message', async () => {
    const { service, ev } = await makeService({ profile });
    const out = await captureOutput(() => deliver(service, ev, { 'messages.upsert': { messages: [incoming('M1')], type: 'notify' } }));
    expect(leaks(out)).toEqual([]);
  });

  it('an incoming message whose push name renames a known chat, when the chat update fails', async () => {
    const { service, prisma, ev } = await makeService({ profile });
    prisma.chat.rows.push({ id: 'chat-1', remoteJid: SENDER, instanceId: 'inst-1', name: 'Old name' });
    prisma.chat.update = async () => {
      throw new Error('database unavailable');
    };
    const out = await captureOutput(() => deliver(service, ev, { 'messages.upsert': { messages: [incoming('M2')], type: 'notify' } }));
    expect(leaks(out)).toEqual([]);
  });

  it('a message the phone re-sent on request (placeholder resend)', async () => {
    const { service, ev } = await makeService({ profile });
    const out = await captureOutput(() =>
      deliver(service, ev, { 'messages.upsert': { messages: [incoming('M3')], type: 'notify', requestId: 'R1' } }),
    );
    expect(leaks(out)).toEqual([]);
  });

  it('a history batch', async () => {
    const { service, ev } = await makeService({ profile });
    const event = historyEvent({
      syncType: 3, // RECENT
      conversations: [{ id: SENDER, name: NAME, messages: [msg(SENDER, 'H1', TEXT, { pushName: NAME })] }],
      pushnames: [{ id: SENDER, pushname: NAME }],
    });
    const out = await captureOutput(() => deliver(service, ev, { 'messaging-history.set': event }));
    expect(leaks(out)).toEqual([]);
  });

  it('an on-demand history sync', async () => {
    const { service, ev } = await makeService({ profile });
    const event = historyEvent({
      syncType: 6, // ON_DEMAND
      conversations: [{ id: SENDER, messages: [msg(SENDER, 'H2', TEXT, { pushName: NAME })] }],
    });
    const out = await captureOutput(() => deliver(service, ev, { 'messaging-history.set': event }));
    expect(leaks(out)).toEqual([]);
  });

  it('a message that failed to decrypt (No session record), through Baileys and then Evolution', async () => {
    const { service, ev } = await makeService({ profile });
    const { socket, config } = await connect(service, ev);
    const stanza = {
      tag: 'message',
      attrs: { from: SENDER, id: 'D1', t: '1700000000', type: 'text', notify: NAME },
      content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: new Uint8Array([1, 2, 3]) }],
    };
    const repository = {
      lidMapping: { getLIDForPN: async () => null, storeLIDPNMappings: async () => undefined },
      decryptMessage: async () => {
        throw new Error('No session record');
      },
    };
    const out = await captureOutput(async () => {
      const { fullMessage, decrypt } = decryptMessageNode(stanza as any, socket.user.id, undefined as any, repository as any, config.logger);
      await decrypt();
      expect(fullMessage.messageStubParameters).toEqual(['No session record']);
      await deliver(service, ev, { 'messages.upsert': { messages: [fullMessage], type: 'notify' } });
      await new Promise((r) => setTimeout(r, 20)); // pino's async write
    });
    expect(leaks(out)).toEqual([]);
  });

  it('a message Baileys fails to handle (its "error in handling message" log)', async () => {
    const { service, ev } = await makeService({ profile });
    const { config } = await connect(service, ev);
    const node = { tag: 'message', attrs: { from: SENDER, id: 'E1', notify: NAME }, content: [{ tag: 'body', attrs: {}, content: TEXT }] };
    // The call Baileys makes at messages-recv.js:1436 (rc14).
    const out = await captureOutput(async () => {
      config.logger.error({ error: new Error('boom'), node: binaryNodeToString(node as any) }, 'error in handling message');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(leaks(out)).toEqual([]);
  });

  it('a message status update', async () => {
    const { service, ev } = await makeService({ profile });
    const out = await captureOutput(() =>
      deliver(service, ev, { 'messages.update': [{ key: { remoteJid: SENDER, fromMe: true, id: `S-${profile}` }, update: { status: 4 } }] }),
    );
    expect(leaks(out)).toEqual([]);
    // Nothing about an ordinary status update is an error or a warning.
    if (profile === 'minimal') expect(out).toBe('');
  });

  it('an incoming call (the raw call stanzas and the call event)', async () => {
    const { service, ev } = await makeService({ profile });
    const { socket } = await connect(service, ev);
    const offer = {
      tag: 'call',
      attrs: { from: SENDER, id: 'C1', t: '1700000000', notify: NAME },
      content: [{ tag: 'offer', attrs: { 'call-id': 'CALL1', 'call-creator': SENDER }, content: undefined }],
    };
    const ack = { tag: 'ack', attrs: { from: SENDER, id: 'C1', class: 'call', type: 'offer' } };
    const call = [{ chatId: SENDER, from: SENDER, id: 'CALL1', date: new Date(1_700_000_000_000), offline: false, status: 'offer', isVideo: false, isGroup: false }];
    const out = await captureOutput(async () => {
      socket.ws.emit('CB:call', offer);
      socket.ws.emit('CB:ack,class:call', ack);
      await deliver(service, ev, { call });
    });
    expect(leaks(out)).toEqual([]);
  });

  it('a group metadata cache lookup (miss, then hit)', async () => {
    const { service } = await makeService({ profile });
    service.client.groupMetadata = async (id: string) => ({ id, subject: TEXT, participants: [{ id: SENDER, admin: null }] });
    const out = await captureOutput(async () => {
      await service.getGroupMetadataCache(GROUP);
      await service.getGroupMetadataCache(GROUP);
    });
    expect(leaks(out)).toEqual([]);
  });

  it('a group participants update whose participant lookup fails', async () => {
    const { service, ev } = await makeService({ profile });
    service.client.groupMetadata = async () => {
      throw new Error('item-not-found');
    };
    const out = await captureOutput(() =>
      deliver(service, ev, { 'group-participants.update': { id: `${PHONE}-1600000001@g.us`, author: SENDER, participants: [SENDER], action: 'add' } }),
    );
    expect(leaks(out)).toEqual([]);
  });

  it('an outgoing text message', async () => {
    const { service } = await makeService({ profile });
    Object.assign(service.client, {
      onWhatsApp: async (...jids: string[]) => jids.map((jid) => ({ exists: true, jid })),
      sendMessage: async (jid: string, content: any) => ({
        key: { remoteJid: jid, fromMe: true, id: 'OUT1' },
        message: { conversation: content.text ?? TEXT },
        messageTimestamp: 1_700_000_000,
        status: 1,
      }),
      presenceSubscribe: async () => undefined,
      sendPresenceUpdate: async () => undefined,
    });
    let sent: any;
    const out = await captureOutput(async () => {
      sent = await service.textMessage({ number: PHONE, text: TEXT });
      await settle(service);
    });
    expect(sent?.key?.id).toBe('OUT1');
    expect(leaks(out)).toEqual([]);
  });

  it('a raw node sent through baileysSendNode', async () => {
    const { service } = await makeService({ profile });
    service.client.sendNode = async () => undefined;
    const stanza = { tag: 'message', attrs: { to: SENDER, id: 'N1' }, content: [{ tag: 'body', attrs: {}, content: TEXT }] };
    const out = await captureOutput(() => service.baileysSendNode(stanza));
    expect(leaks(out)).toEqual([]);
  });
});
