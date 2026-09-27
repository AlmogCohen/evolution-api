// Group updates have two spellings. Baileys emits `groups.update`, which every
// transport upper-cases to GROUPS_UPDATE before comparing it with what the
// instance subscribed to. But the only spelling /webhook/set (and every other
// /<transport>/set) accepts is GROUP_UPDATE (EventController.events), and the
// global env config is keyed GROUP_UPDATE too. So a webhook subscribed to group
// updates, per instance or global, never receives one, and GROUP_UPDATE is the
// spelling a client can store.
//
// Through the real WebhookController, to a real HTTP destination on 127.0.0.1.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

const GROUP = { id: '120363000000000001@g.us', subject: 'Synthetic group' };

describe('a webhook subscribed to group updates', () => {
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

  /** Emit one event through a WebhookController whose instance row subscribes to `events` (null: no row). */
  async function emit(events: string[] | null, event: string, data: any = GROUP) {
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
      dateTime: '2026-09-27T00:00:00.000Z',
      sender: '972500000000@s.whatsapp.net',
      apiKey: null,
      local: true,
    });
  }

  it.each(['GROUP_UPDATE', 'GROUPS_UPDATE'])('per instance, subscribed as %s, receives groups.update', async (name) => {
    await emit([name], 'groups.update');
    expect(hits.map((h) => h.path)).toEqual(['/hook']);
    expect(hits[0].body.event).toBe('groups.update');
    expect(hits[0].body.instance).toBe('test');
    expect(hits[0].body.data).toEqual(GROUP);
  });

  it('per instance, a group update subscription does not bring other events', async () => {
    await emit(['GROUP_UPDATE'], 'messages.upsert', { key: { id: 'X' } });
    await emit(['GROUP_UPDATE'], 'groups.upsert');
    await emit(['GROUP_UPDATE'], 'group-participants.update');
    expect(hits).toEqual([]);
  });

  it('per instance, other subscriptions are unchanged and do not bring group updates', async () => {
    const subscribed = ['MESSAGES_UPSERT', 'GROUPS_UPSERT', 'GROUP_PARTICIPANTS_UPDATE'];
    for (const event of ['messages.upsert', 'groups.upsert', 'group-participants.update', 'groups.update'])
      await emit(subscribed, event);
    expect(hits.map((h) => h.body.event)).toEqual(['messages.upsert', 'groups.upsert', 'group-participants.update']);
  });

  it('global, enabled by WEBHOOK_EVENTS_GROUPS_UPDATE (config key GROUP_UPDATE), receives groups.update', async () => {
    const { configService } = await import('@config/env.config');
    const webhook = configService.get<any>('WEBHOOK');
    const saved = structuredClone(webhook);
    Object.assign(webhook.GLOBAL, { ENABLED: true, URL: `${base}/global`, WEBHOOK_BY_EVENTS: false });
    webhook.EVENTS = Object.fromEntries(Object.keys(webhook.EVENTS).map((k) => [k, false]));
    webhook.EVENTS.GROUP_UPDATE = true;
    try {
      await emit(null, 'groups.update');
      await emit(null, 'messages.upsert', { key: { id: 'X' } });
    } finally {
      Object.assign(webhook, saved);
    }
    expect(hits.map((h) => [h.path, h.body.event])).toEqual([['/global', 'groups.update']]);
    expect(hits[0].body.data).toEqual(GROUP);
  });
});
