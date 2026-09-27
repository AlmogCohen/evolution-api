// A contact's picture is looked up after its contacts.upsert, in the background, and sent on
// contacts.update when the lookups of the whole batch finish. That update carried the name the
// contact had in the batch, so a rename that arrived meanwhile was overwritten for the consumer
// by the old name. And a lookup answered after WhatsApp said the picture was removed wrote the
// old picture back, in the cache and on the update. Each test applies the webhooks in the order
// they were sent, as a consumer does, and checks where the consumer ends.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { deliver, makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const A = '972500000001@s.whatsapp.net';
const B = '972500000002@s.whatsapp.net';
const OLD_PICTURE = 'https://pps.whatsapp.test/a/old.jpg';

/** A profilePictureUrl whose answers the test gives, one call at a time. */
function heldPictures(service: any) {
  const calls: { jid: string; answer: (url: string | null) => void }[] = [];
  service.client.profilePictureUrl = (jid: string) =>
    new Promise<string | null>((answer) => calls.push({ jid, answer }));
  const next = async (jid: string) => {
    await vi.waitFor(() => expect(calls.some((c) => c.jid === jid)).toBe(true));
    const i = calls.findIndex((c) => c.jid === jid);
    return calls.splice(i, 1)[0].answer;
  };
  return { next };
}

/** What a consumer holds for a contact after applying every contacts webhook in order. */
function consumerView(jid: string) {
  const view: Record<string, any> = {};
  for (const e of emitted.filter((e) => e.event === 'contacts.upsert' || e.event === 'contacts.update')) {
    for (const item of [].concat(e.data) as any[]) {
      if (item?.remoteJid !== jid) continue;
      for (const [k, v] of Object.entries(item)) if (v !== undefined) view[k] = v;
    }
  }
  return view;
}

describe('a picture lookup that finishes late', () => {
  beforeEach(() => void emitted.splice(0));

  it('does not bring back a name the contact has changed since', async () => {
    const { service, ev } = await makeService();
    const pictures = heldPictures(service);
    await deliver(service, ev, {
      'contacts.upsert': [
        { id: A, name: 'Old' },
        { id: B, name: 'Bea' },
      ],
    });
    const answerA = await pictures.next(A);
    const answerB = await pictures.next(B);

    // A is renamed while B's picture is still being looked up.
    answerA('https://pps.whatsapp.test/a/1.jpg');
    const rename = deliver(service, ev, { 'contacts.update': [{ id: A, name: 'New' }] }, { buffered: false });
    await rename;
    answerB('https://pps.whatsapp.test/b/1.jpg');
    await settle(service);
    await new Promise((r) => setTimeout(r, 20));

    expect(consumerView(A).pushName).toBe('New');
  });

  it('does not bring back a picture WhatsApp said was removed', async () => {
    const { service, ev } = await makeService();
    const pictures = heldPictures(service);
    await deliver(service, ev, { 'contacts.upsert': [{ id: A, name: 'Ann' }] });
    const answerA = await pictures.next(A);

    // WhatsApp's picture notification: removed. The lookup started before it answers after it.
    await deliver(service, ev, { 'contacts.update': [{ id: A, imgUrl: 'removed' }] }, { buffered: false });
    answerA(OLD_PICTURE);
    await settle(service);
    await new Promise((r) => setTimeout(r, 20));

    const next = await service.cachedProfilePicture(A);
    expect({ consumer: consumerView(A).profilePicUrl, kept: next.profilePictureUrl }).toEqual({
      consumer: null,
      kept: null,
    });
  });
});
