// messages.undecryptable (test/handlers/undecryptable-message.test.ts) is an event
// of this fork's, so a consumer has to be able to ask for it: /webhook/set (and
// every /<transport>/set) validates the names it is given against
// EventController.events and refuses the whole request on one it does not know,
// and the global configurations are keyed by name. Subscribed, it is delivered;
// not subscribed, it is not, and no other subscription brings it.
//
// Through the real WebhookController, to a real HTTP destination on 127.0.0.1.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { validate } from 'jsonschema';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

const DATA = {
  key: { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'AC2695000000000000000000000000AA' },
  pushName: 'Sender',
  messageTimestamp: 1761934500,
  chatKind: 'group',
  reason: 'No session found to decrypt message',
};

describe('a webhook subscribed to messages.undecryptable', () => {
  const hits: { path: string; body: any }[] = [];
  let base: string;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => (hits.push({ path: req.url ?? '', body: JSON.parse(body) }), res.end('ok')));
  });

  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => void hits.splice(0));

  async function emit(events: string[] | null, event: string, data: any = DATA) {
    const { WebhookController } = await import('@api/integrations/event/webhook/webhook.controller');
    const row = events && { enabled: true, events, url: `${base}/hook`, headers: {}, webhookBase64: false, webhookByEvents: false };
    const prisma: any = { webhook: { findUnique: async () => row, findFirst: async () => row } };
    const monitor: any = { waInstances: { test: { instanceId: 'inst-1' } } };
    await new WebhookController(prisma, monitor).emit({
      instanceName: 'test',
      origin: 'test',
      event,
      data,
      serverUrl: 'http://127.0.0.1',
      dateTime: '2026-11-01T00:00:00.000Z',
      sender: '972500000000@s.whatsapp.net',
      apiKey: null,
      local: true,
    });
  }

  it('/webhook/set accepts MESSAGES_UNDECRYPTABLE beside the events it already took', async () => {
    const { webhookSchema } = await import('@api/integrations/event/webhook/webhook.schema');
    const body = { webhook: { enabled: true, url: `${base}/hook`, events: ['MESSAGES_UPSERT', 'MESSAGES_UNDECRYPTABLE'] } };
    expect(validate(body, webhookSchema).errors).toEqual([]);
  });

  it('every /<transport>/set takes it: it is one of EventController.events', async () => {
    const { EventController } = await import('@api/integrations/event/event.controller');
    expect(EventController.events).toContain('MESSAGES_UNDECRYPTABLE');
  });

  it('per instance, subscribed, receives it as sent', async () => {
    await emit(['MESSAGES_UNDECRYPTABLE'], 'messages.undecryptable');
    expect(hits.map((h) => [h.path, h.body.event, h.body.instance])).toEqual([['/hook', 'messages.undecryptable', 'test']]);
    expect(hits[0].body.data).toEqual(DATA);
  });

  it('per instance, a subscription to messages.upsert does not bring it', async () => {
    await emit(['MESSAGES_UPSERT', 'MESSAGES_UPDATE'], 'messages.undecryptable');
    expect(hits).toEqual([]);
  });

  it('global, enabled by WEBHOOK_EVENTS_MESSAGES_UNDECRYPTABLE, receives it', async () => {
    const saved = process.env.WEBHOOK_EVENTS_MESSAGES_UNDECRYPTABLE;
    process.env.WEBHOOK_EVENTS_MESSAGES_UNDECRYPTABLE = 'true';
    const { ConfigService, configService } = await import('@config/env.config');
    const fresh = new ConfigService().get<any>('WEBHOOK');
    if (saved === undefined) delete process.env.WEBHOOK_EVENTS_MESSAGES_UNDECRYPTABLE;
    else process.env.WEBHOOK_EVENTS_MESSAGES_UNDECRYPTABLE = saved;
    expect(fresh.EVENTS.MESSAGES_UNDECRYPTABLE).toBe(true);

    const webhook = configService.get<any>('WEBHOOK');
    const before = structuredClone(webhook);
    Object.assign(webhook.GLOBAL, { ENABLED: true, URL: `${base}/global`, WEBHOOK_BY_EVENTS: false });
    webhook.EVENTS = Object.fromEntries(Object.keys(webhook.EVENTS).map((k) => [k, false]));
    webhook.EVENTS.MESSAGES_UNDECRYPTABLE = fresh.EVENTS.MESSAGES_UNDECRYPTABLE;
    try {
      await emit(null, 'messages.undecryptable');
      await emit(null, 'messages.upsert', { key: { id: 'X' } });
    } finally {
      Object.assign(webhook, before);
    }
    expect(hits.map((h) => [h.path, h.body.event])).toEqual([['/global', 'messages.undecryptable']]);
  });
});
