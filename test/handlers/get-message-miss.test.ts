// Evolution hands Baileys its getMessage (the socket config's `getMessage`), and
// Baileys calls it to answer a recipient's retry request for a message this
// instance sent, when the message is no longer in its own recent-message cache.
// Baileys relays whatever comes back if it is truthy, under the original message
// id; only a falsy answer (its own default is `async () => undefined`) means "not
// available, send nothing" (lib/Socket/messages-recv.js, sendMessagesAgain).
// Evolution answers a database miss with `{ conversation: '' }`, so the recipient
// is sent an empty message. A deployment that stores no messages (for example
// DATABASE_SAVE_DATA_NEW_MESSAGE=false, the `minimal` profile) misses every time.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { deliver, makeService } from '../helpers/baileys-service';
import type { Profile } from '../helpers/profiles';

const CHAT = '972500000001@s.whatsapp.net';

/** getMessage's query over the fake's rows: WHERE "instanceId" = $1 AND "key"->>'id' = $2. */
function answerFromRows(prisma: any) {
  prisma.$queryRaw = async (_sql: TemplateStringsArray, instanceId: string, id: string) =>
    prisma.message.rows.filter((r: any) => r.instanceId === instanceId && r.key?.id === id);
}

describe('getMessage, as Baileys calls it to answer a retry request', () => {
  it.each<Profile>(['minimal', 'stored'])('under the %s profile, answers a message it does not have with undefined', async (profile) => {
    const { service, prisma } = await makeService({ profile });
    answerFromRows(prisma);
    const answer = await service.getMessage({ remoteJid: CHAT, fromMe: true, id: '3EB0MISSING0000000001' });
    expect(answer).toBeUndefined();
  });

  it('under the minimal profile, a message the instance sent is not stored, so a retry for it finds nothing', async () => {
    const { service, prisma, ev } = await makeService({ profile: 'minimal' });
    answerFromRows(prisma);
    const key = { remoteJid: CHAT, fromMe: true, id: '3EB0SENT0000000000001' };
    await deliver(service, ev, {
      'messages.upsert': { messages: [{ key, message: { conversation: 'the real text' }, messageTimestamp: 1_700_000_000 }], type: 'notify' },
    });
    expect(prisma.message.rows).toHaveLength(0);
    expect(await service.getMessage(key)).toBeUndefined();
  });

  it('under the stored profile, a stored message is still returned as stored, so Baileys can resend it', async () => {
    const { service, prisma, ev } = await makeService({ profile: 'stored' });
    answerFromRows(prisma);
    const key = { remoteJid: CHAT, fromMe: true, id: '3EB0SENT0000000000002' };
    await deliver(service, ev, {
      'messages.upsert': { messages: [{ key, message: { conversation: 'the real text' }, messageTimestamp: 1_700_000_000 }], type: 'notify' },
    });
    expect(prisma.message.rows.map((r: any) => r.key?.id)).toEqual([key.id]);
    expect(await service.getMessage(key)).toEqual({ conversation: 'the real text' });
  });
});
