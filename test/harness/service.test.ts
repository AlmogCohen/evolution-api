// The harness drives Evolution's real BaileysStartupService through Baileys'
// real event buffer, under a configuration profile.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const incoming = {
  key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: '3EB0AAAAAAAAAAAAAAAA' },
  message: { conversation: 'hello' },
  messageTimestamp: 1_700_000_000,
  pushName: 'Sender',
};

describe('harness: an incoming text message', () => {
  beforeEach(() => void emitted.splice(0));

  it('reaches the messages.upsert webhook, and is not stored under the minimal profile', async () => {
    const { service, prisma, ev } = await makeService({ profile: 'minimal' });
    await deliver(service, ev, { 'messages.upsert': { messages: [incoming], type: 'notify' } });
    const upsert = emitted.find((e) => e.event === 'messages.upsert');
    expect(upsert?.data?.key?.id).toBe(incoming.key.id);
    expect(upsert?.data?.message?.conversation).toBe('hello');
    expect(prisma.message.rows).toHaveLength(0);
  });

  it('is stored under the stored profile', async () => {
    const { service, prisma, ev } = await makeService({ profile: 'stored' });
    await deliver(service, ev, { 'messages.upsert': { messages: [incoming], type: 'notify' } });
    expect(prisma.message.rows.map((r: any) => r.key?.id)).toEqual([incoming.key.id]);
  });
});
