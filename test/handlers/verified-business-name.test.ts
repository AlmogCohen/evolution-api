// A WhatsApp Business account (a bot such as Instinct) can send messages with no
// push name at all, only the verified business name WhatsApp certifies for it.
// Baileys puts that on the message as verifiedBizName (decode-wa-message.js) and
// emits contacts.update only when there IS a push name (chats.js upsertMessage),
// so before this the name never left Evolution: consumers saw a bare number
// where WhatsApp itself shows "Instinct". Found live in Circles on 2026-10-16.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { decodeMessageNode } from 'baileys';
import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, WUID } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import type { Profile } from '../helpers/profiles';

const ME_LID = '100000000000001@lid';
const BUSINESS = '16508702892@s.whatsapp.net';

/** What Baileys emits for a business DM: no `notify` (push name), the verified name set by decrypt(). */
function businessMessage(attrs: Record<string, string> = {}, verifiedBizName?: string) {
  const { fullMessage } = decodeMessageNode(
    { tag: 'message', attrs: { id: '3EB0BBBBBBBBBBBBBBB1', from: BUSINESS, type: 'text', t: '1700000000', ...attrs }, content: [] } as any,
    WUID,
    ME_LID,
  );
  return { ...fullMessage, ...(verifiedBizName ? { verifiedBizName } : {}), message: { conversation: 'hello' } };
}

async function webhookPushName(profile: Profile, message: any) {
  const { service, ev } = await makeService({ profile });
  await deliver(service, ev, { 'messages.upsert': { messages: [message], type: 'notify' } });
  const upserts = emitted.filter((e) => e.event === 'messages.upsert');
  expect(upserts).toHaveLength(1);
  return upserts[0].data.pushName;
}

describe.each<Profile>(['minimal', 'stored'])('a business sender is named by its verified name (%s)', (profile) => {
  beforeEach(() => void emitted.splice(0));

  it('a message with no push name carries the verified business name as its pushName', async () => {
    const message = businessMessage({}, 'Instinct');
    expect(message.pushName).toBeFalsy();
    expect(await webhookPushName(profile, message)).toBe('Instinct');
  });

  it('a push name, when there is one, still wins over the verified name', async () => {
    expect(await webhookPushName(profile, businessMessage({ notify: 'Their own name' }, 'Instinct'))).toBe('Their own name');
  });
});
