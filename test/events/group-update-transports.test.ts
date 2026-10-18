// The same two spellings of the group update event (see group-update-webhook.test.ts)
// in every other transport. Each one upper-cases `groups.update` to GROUPS_UPDATE
// and compares it with the instance's stored events (which /<transport>/set only
// accepts as GROUP_UPDATE) and, where it has one, with its global env config
// (keyed GROUP_UPDATE, except SQS). The real controllers run; only the client
// each one publishes through (socket.io, AMQP channel, NATS, SQS, Kafka, Pusher)
// is a recording fake, so nothing leaves the process.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

const GROUP = { id: '120363000000000001@g.us', subject: 'Synthetic group' };
const monitor: any = { waInstances: { test: { instanceId: 'inst-1' } } };
const emitData = (event: string) => ({
  instanceName: 'test',
  origin: 'test',
  event,
  data: event === 'groups.update' ? GROUP : { key: { id: 'X' } },
  serverUrl: 'http://127.0.0.1',
  dateTime: '2026-09-27T00:00:00.000Z',
  sender: '972500000000@s.whatsapp.net',
  apiKey: null,
  local: true,
});

// Each transport: its table and config section, how to build it with a recording
// client, and how to read the event names it published from that client.
type Transport = {
  name: string;
  config?: string;
  build: (prisma: any) => Promise<{ ctrl: any; published: () => string[] }>;
};

const transports: Transport[] = [
  {
    name: 'websocket',
    build: async (prisma) => {
      const { WebsocketController } = await import('@api/integrations/event/websocket/websocket.controller');
      const sent: string[] = [];
      const ctrl: any = new WebsocketController(prisma, monitor);
      ctrl.io = { emit: (e: string) => sent.push(e), of: () => ({ emit: (e: string) => sent.push(e) }) };
      return { ctrl, published: () => sent };
    },
  },
  {
    name: 'rabbitmq',
    config: 'RABBITMQ',
    build: async (prisma) => {
      const { RabbitmqController } = await import('@api/integrations/event/rabbitmq/rabbitmq.controller');
      const sent: string[] = [];
      const ctrl: any = new RabbitmqController(prisma, monitor);
      ctrl.amqpChannel = {
        assertExchange: async () => undefined,
        assertQueue: async () => undefined,
        bindQueue: async () => undefined,
        publish: async (_x: string, _k: string, body: Buffer) => void sent.push(JSON.parse(body.toString()).event),
      };
      return { ctrl, published: () => sent };
    },
  },
  {
    name: 'nats',
    config: 'NATS',
    build: async (prisma) => {
      const { NatsController } = await import('@api/integrations/event/nats/nats.controller');
      const sent: string[] = [];
      const ctrl: any = new NatsController(prisma, monitor);
      ctrl.natsClient = { publish: (_s: string, body: Uint8Array) => void sent.push(JSON.parse(Buffer.from(body).toString()).event) };
      return { ctrl, published: () => sent };
    },
  },
  {
    name: 'sqs',
    build: async (prisma) => {
      const { SqsController } = await import('@api/integrations/event/sqs/sqs.controller');
      const sent: string[] = [];
      const ctrl: any = new SqsController(prisma, monitor);
      ctrl.sqs = { sendMessage: (p: any) => void sent.push(JSON.parse(p.MessageBody).event) };
      return { ctrl, published: () => sent };
    },
  },
  {
    name: 'kafka',
    config: 'KAFKA',
    build: async (prisma) => {
      const { KafkaController } = await import('@api/integrations/event/kafka/kafka.controller');
      const sent: string[] = [];
      const ctrl: any = new KafkaController(prisma, monitor);
      ctrl.producer = { send: async (r: any) => void sent.push(JSON.parse(r.messages[0].value).event) };
      return { ctrl, published: () => sent };
    },
  },
  {
    name: 'pusher',
    config: 'PUSHER',
    build: async (prisma) => {
      const { PusherController } = await import('@api/integrations/event/pusher/pusher.controller');
      const sent: string[] = [];
      const client = { trigger: (_c: string, _e: string, d: any) => void sent.push(d.event) };
      const ctrl: any = new PusherController(prisma, monitor);
      ctrl.pusherClients = { test: client };
      ctrl.globalPusherClient = client;
      return { ctrl, published: () => sent };
    },
  },
];

async function emitThrough(t: Transport, events: string[] | null, names: string[]) {
  const row = events && { enabled: true, events, appId: 'app', key: 'k', secret: 's', cluster: 'eu', useTLS: true };
  const prisma: any = { [t.name]: { findUnique: async () => row }, instance: { findMany: async () => [] } };
  const { ctrl, published } = await t.build(prisma);
  ctrl.status = true; // the transport is ENABLED (read from env at construction)
  for (const event of names) await ctrl.emit(emitData(event));
  return published();
}

describe.each(transports)('$name', (t) => {
  beforeEach(async () => void (await import('@config/env.config')));

  it.each(['GROUP_UPDATE', 'GROUPS_UPDATE'])('per instance, subscribed as %s, receives groups.update', async (name) => {
    expect(await emitThrough(t, [name], ['groups.update'])).toEqual(['groups.update']);
  });

  it('per instance, other subscriptions are unchanged and do not bring group updates', async () => {
    const events = ['messages.upsert', 'groups.upsert', 'group-participants.update', 'groups.update'];
    expect(await emitThrough(t, ['MESSAGES_UPSERT', 'GROUPS_UPSERT', 'GROUP_PARTICIPANTS_UPDATE'], events)).toEqual([
      'messages.upsert',
      'groups.upsert',
      'group-participants.update',
    ]);
    expect(await emitThrough(t, ['GROUP_UPDATE'], ['messages.upsert', 'groups.upsert'])).toEqual([]);
  });

  if (t.config) {
    it('global, enabled by its GROUPS_UPDATE env var (config key GROUP_UPDATE), receives groups.update', async () => {
      const { configService } = await import('@config/env.config');
      const section = configService.get<any>(t.config!);
      const saved = structuredClone(section);
      if ('GLOBAL_ENABLED' in section) section.GLOBAL_ENABLED = true;
      else section.GLOBAL.ENABLED = true;
      section.EVENTS = Object.assign(section.EVENTS, Object.fromEntries(Object.keys(section.EVENTS).map((k) => [k, false])));
      section.EVENTS.GROUP_UPDATE = true;
      try {
        expect(await emitThrough(t, null, ['groups.update', 'messages.upsert'])).toEqual(['groups.update']);
      } finally {
        Object.assign(section, saved);
        Object.assign(section.EVENTS, saved.EVENTS);
      }
    });
  }
});
