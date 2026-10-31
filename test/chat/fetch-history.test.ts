// POST /chat/fetchHistory asks the phone to send a chat's history again, older
// than a message the consumer names (Baileys' fetchMessageHistory, WhatsApp's
// HISTORY_SYNC_ON_DEMAND peer request). The phone answers later, on its own, with
// an ON_DEMAND history batch that reaches the consumer as messages.set.
//
// Why: a consumer that stored a message before it could read its type (a
// WhatsApp Business template, 2026-10) holds an empty row, and WhatsApp is the
// only place the text still exists. Until now the request was reachable only by
// sending "onDemandHistSync" to yourself, a debug path.
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';

const TOKEN = 'instance-token';
const CHAT = '972500000001@s.whatsapp.net';
const KEY = { remoteJid: CHAT, fromMe: false, id: '3EB0EEEEEEEEEEEEEEE1' };
const AT_MS = 1_760_000_000_000;

let app: Awaited<ReturnType<typeof startChatApp>>;
let calls: any[][];

beforeAll(async () => {
  await prisma.instance.create({ data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' } });
  const { service } = await makeService({ prisma });
  service.client.fetchMessageHistory = async (...args: any[]) => {
    calls.push(args);
    return 'PDO-REQUEST-1';
  };
  h.waMonitor = { waInstances: { test: service } };
  const { ChatController } = await import('@api/controllers/chat.controller');
  h.chatController = new ChatController(h.waMonitor);
  app = await startChatApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  calls = [];
});

async function post(body: Record<string, any>) {
  const res = await fetch(`${app.base}/chat/fetchHistory/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /chat/fetchHistory asks the phone for a chat history older than a message', () => {
  it('passes the count, the anchor key and its time in ms to the socket, and answers the request id', async () => {
    const res = await post({ key: KEY, timestampMs: AT_MS, count: 50 });
    expect(res).toEqual({ status: 201, body: { requestId: 'PDO-REQUEST-1' } });
    expect(calls).toEqual([[50, KEY, AT_MS]]);
  });

  it('asks for 50 when no count is given', async () => {
    expect((await post({ key: KEY, timestampMs: AT_MS })).status).toBe(201);
    expect(calls).toEqual([[50, KEY, AT_MS]]);
  });

  it.each([
    ['no key', { timestampMs: AT_MS }],
    ['a key with no id', { key: { remoteJid: CHAT, fromMe: false }, timestampMs: AT_MS }],
    ['a key with no chat', { key: { id: KEY.id, fromMe: false }, timestampMs: AT_MS }],
    ['a key that does not say who sent it', { key: { remoteJid: CHAT, id: KEY.id }, timestampMs: AT_MS }],
    ['no time', { key: KEY }],
    ['a count over 50', { key: KEY, timestampMs: AT_MS, count: 51 }],
    ['a count of 0', { key: KEY, timestampMs: AT_MS, count: 0 }],
  ])('refuses %s with a 400 and asks the phone nothing', async (_what, body) => {
    expect((await post(body)).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
