// A history message with no push name was named by its sender's number. For a
// WhatsApp Business account WhatsApp certifies a name (verifiedBizName on the
// message, as on a live one), and fd192f45 already names live messages by it.
// History is what a consumer gets when it asks for a chat again
// (POST /chat/fetchHistory), so without this the business it asked about came
// back as a bare number a second time.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { historyEvent, msg } from '../helpers/baileys-fixtures';
import { deliver, makeService } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import type { Profile } from '../helpers/profiles';

const ON_DEMAND = 6;
const BUSINESS = '972500000077@s.whatsapp.net';
const PERSON = '972500000078@s.whatsapp.net';

async function historyPushNames(profile: Profile, conversations: any[]) {
  const { service, ev } = await makeService({ profile });
  await deliver(service, ev, { 'messaging-history.set': historyEvent({ syncType: ON_DEMAND, conversations }) });
  return Object.fromEntries(
    emitted
      .filter((e) => e.event === 'messages.set')
      .flatMap((e) => e.data)
      .map((m: any) => [m.key.id, m.pushName]),
  );
}

describe.each<Profile>(['minimal', 'stored'])('a business in history is named by its verified name (%s)', (profile) => {
  beforeEach(() => void emitted.splice(0));

  it('a history message with no push name carries the verified business name as its pushName', async () => {
    const names = await historyPushNames(profile, [
      { id: BUSINESS, messages: [msg(BUSINESS, 'BIZ1', 'notice', { verifiedBizName: 'The Committee' })] },
    ]);
    expect(names).toEqual({ BIZ1: 'The Committee' });
  });

  it('a push name, when there is one, still wins over the verified name', async () => {
    const names = await historyPushNames(profile, [
      { id: BUSINESS, messages: [msg(BUSINESS, 'BIZ2', 'notice', { pushName: 'Their own name', verifiedBizName: 'The Committee' })] },
    ]);
    expect(names).toEqual({ BIZ2: 'Their own name' });
  });

  it('a person with no push name and no verified name is still named by their number', async () => {
    const names = await historyPushNames(profile, [{ id: PERSON, messages: [msg(PERSON, 'P1', 'hi')] }]);
    expect(names).toEqual({ P1: '972500000078' });
  });
});
