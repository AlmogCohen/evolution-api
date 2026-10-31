// A contact has two names: the one the phone's owner SAVED in their address
// book (Baileys `name`, from an app-state contact action) and the contact's own
// PROFILE name (the message stanza's pushName, Baileys `notify`). Evolution
// folds both into one `pushName` on contacts.upsert, so a consumer cannot tell
// them apart and a profile name that arrives later replaces the saved one.
// Each contacts.upsert item says `saved: true` only when the name is certainly
// the saved one, and `saved: false` otherwise.
//
// Where the names come from in Baileys 7.0.0-rc14:
// - contactAction (lib/Utils/sync-action-utils.js processContactAction) and
//   lidContactAction (lib/Utils/chat-utils.js) emit contacts.upsert with
//   name = fullName || firstName || username, and `username` alongside. A name
//   equal to the username is the contact's handle, not a saved name.
// - history (lib/Utils/history.js) builds name = displayName || name ||
//   username for every conversation, and PUSH_NAME syncs carry only `notify`:
//   neither is certainly a saved name.
// - a live message (lib/Socket/chats.js upsertMessage) carries the sender's
//   pushName, and emits contacts.update [{ id, notify, verifiedName }].
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { historyEvent, msg, syncActionEvents } from '../helpers/baileys-fixtures';
import { deliver, makeService } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const ALPHA = '972500000001@s.whatsapp.net';
const BRAVO = '972500000002@s.whatsapp.net';
const CHARLIE = '972500000003@s.whatsapp.net';
const DELTA = '972500000004@s.whatsapp.net';
const ECHO_LID = '100000000005@lid';
const INITIAL_BOOTSTRAP = 0;
const PUSH_NAME = 4;

const upserts = (jid: string) =>
  emitted
    .filter((e) => e.event === 'contacts.upsert')
    .flatMap((e) => [].concat(e.data))
    .filter((c: any) => c?.remoteJid === jid);

/** An item from Evolution's contacts.upsert handler (Baileys contacts.upsert, or history). */
const item = (remoteJid: string, pushName: string, saved: boolean) => ({
  remoteJid,
  pushName,
  profilePicUrl: null,
  instanceId: 'inst-1',
  saved,
});

/** An item from Evolution's messages.upsert handler, which looks the picture up (none here). */
const fromMessage = (remoteJid: string, pushName: string, saved: boolean) => ({
  ...item(remoteJid, pushName, saved),
  profilePicUrl: undefined,
});

/** What the socket emits for an incoming text: the message, and the sender's profile name (chats.js upsertMessage). */
const incoming = (jid: string, id: string, pushName: string) => ({
  'messages.upsert': { messages: [{ ...msg(jid, id, 'hi').message, pushName }], type: 'notify' },
  'contacts.update': [{ id: jid, notify: pushName, verifiedName: undefined }],
});

describe('contacts.upsert says whether a name is the one the owner saved', () => {
  beforeEach(() => void emitted.splice(0));

  it('app-state contact action: the address-book name is saved, a bare username is not', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, syncActionEvents(['contact', ALPHA], { contactAction: { fullName: 'Alpha Saved', firstName: 'Alpha' } }));
    await deliver(service, ev, syncActionEvents(['contact', BRAVO], { contactAction: { firstName: 'Bravo' } }));
    await deliver(service, ev, syncActionEvents(['contact', CHARLIE], { contactAction: { username: 'charlie.handle' } }));
    await deliver(service, ev, syncActionEvents(['lid_contact', ECHO_LID], { lidContactAction: { fullName: 'Echo Saved' } }));

    expect(upserts(ALPHA)).toEqual([item(ALPHA, 'Alpha Saved', true)]);
    expect(upserts(BRAVO)).toEqual([item(BRAVO, 'Bravo', true)]);
    expect(upserts(CHARLIE)).toEqual([item(CHARLIE, 'charlie.handle', false)]);
    expect(upserts(ECHO_LID)).toEqual([item(ECHO_LID, 'Echo Saved', true)]);
  });

  it('a live message: the sender profile name is kept, and is not saved', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, incoming(DELTA, '3EB0DDDDDDDDDDDDDDD1', 'delta profile'));

    expect(upserts(DELTA)).toEqual([fromMessage(DELTA, 'delta profile', false)]);
  });

  it('history: display names, usernames, chat names and push names are never marked saved', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, {
      'messaging-history.set': historyEvent({
        syncType: INITIAL_BOOTSTRAP,
        progress: 100,
        conversations: [
          { id: ALPHA, displayName: 'Alpha Display', messages: [msg(ALPHA, 'A1', 'hi')] },
          { id: BRAVO, username: 'bravo.handle', messages: [msg(BRAVO, 'B1', 'hi')] },
          { id: CHARLIE, name: 'Charlie Chat', messages: [msg(CHARLIE, 'C1', 'hi')] },
        ],
      }),
    });
    await deliver(service, ev, {
      'messaging-history.set': historyEvent({ syncType: PUSH_NAME, pushnames: [{ id: DELTA, pushname: 'delta profile' }] }),
    });

    expect(upserts(ALPHA)).toEqual([item(ALPHA, 'Alpha Display', false)]);
    expect(upserts(BRAVO)).toEqual([item(BRAVO, 'bravo.handle', false)]);
    expect(upserts(CHARLIE)).toEqual([item(CHARLIE, 'Charlie Chat', false)]);
    expect(upserts(DELTA)).toEqual([item(DELTA, 'delta profile', false)]);
  });

  it('the saved name and a later profile name for the same person stay distinguishable', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, syncActionEvents(['contact', ALPHA], { contactAction: { fullName: 'Alpha Saved', firstName: 'Alpha' } }));
    await deliver(service, ev, incoming(ALPHA, '3EB0AAAAAAAAAAAAAAA1', 'alpha profile'));

    expect(upserts(ALPHA)).toEqual([item(ALPHA, 'Alpha Saved', true), fromMessage(ALPHA, 'alpha profile', false)]);
  });
});
