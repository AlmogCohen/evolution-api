// Archiving, pinning and muting a chat reach Evolution from Baileys, and were
// dropped on the way out: every chats.update item was reduced to
// { remoteJid, instanceId }, and the history chat list to its name. A consumer
// that hides archived chats could not tell which ones were.
//
// Where the state comes from in Baileys 7.0.0-rc14:
// - app-state actions (lib/Utils/chat-utils.js processSyncAction):
//   archiveChatAction emits chats.update { id, archived }, pinAction
//   { id, pinned: <timestamp> | null }, muteAction { id, muteEndTime: <ms> | null }.
//   Each action carries its own field only; an update that carries none (a
//   read marker, say) says nothing about the archive state.
// - history (lib/Utils/history.js) passes each HistorySync Conversation through
//   as a chat, with archived, pinned and muteEndTime set when WhatsApp sent them.
// - the event buffer (lib/Utils/event-buffer.js) folds a chats.update into a
//   chats.upsert of the same batch, so an upsert can carry the state too.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { historyEvent, msg, syncActionEvents } from '../helpers/baileys-fixtures';
import { deliver, makeService } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const ALPHA = '972500000001@s.whatsapp.net';
const BRAVO = '972500000002@s.whatsapp.net';
const CHARLIE = '972500000003@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const INITIAL_BOOTSTRAP = 0;

const items = (event: string) => emitted.filter((e) => e.event === event).flatMap((e) => [].concat(e.data));

describe('chat updates and the history chat list carry the archive state', () => {
  beforeEach(() => void emitted.splice(0));

  it('an archive action says archived: true, an unarchive action archived: false', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, syncActionEvents(['archive', ALPHA], { archiveChatAction: { archived: true } }));
    await deliver(service, ev, syncActionEvents(['archive', ALPHA], { archiveChatAction: { archived: false } }));

    expect(items('chats.update')).toEqual([
      { remoteJid: ALPHA, instanceId: 'inst-1', archived: true },
      { remoteJid: ALPHA, instanceId: 'inst-1', archived: false },
    ]);
  });

  it('pin and mute actions say pinned and muteEndTime, and null when cleared', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, syncActionEvents(['pin_v1', ALPHA], { pinAction: { pinned: true } }));
    await deliver(service, ev, syncActionEvents(['pin_v1', ALPHA], { pinAction: { pinned: false } }));
    await deliver(service, ev, syncActionEvents(['mute', BRAVO], { muteAction: { muted: true, muteEndTimestamp: 1_800_000_000_000 } }));
    await deliver(service, ev, syncActionEvents(['mute', BRAVO], { muteAction: { muted: false } }));

    expect(items('chats.update')).toEqual([
      { remoteJid: ALPHA, instanceId: 'inst-1', pinned: 1_700_000_000 },
      { remoteJid: ALPHA, instanceId: 'inst-1', pinned: null },
      { remoteJid: BRAVO, instanceId: 'inst-1', muteEndTime: 1_800_000_000_000 },
      { remoteJid: BRAVO, instanceId: 'inst-1', muteEndTime: null },
    ]);
  });

  it('an update without archive information does not claim the chat is unarchived', async () => {
    const { service, ev } = await makeService();
    await deliver(service, ev, syncActionEvents(['markChatAsRead', ALPHA], { markChatAsReadAction: { read: true } }));

    expect(items('chats.update')).toEqual([{ remoteJid: ALPHA, instanceId: 'inst-1' }]);
  });

  for (const profile of ['minimal', 'stored'] as const) {
    it(`history: an archived conversation is archived on its chats.set item (${profile})`, async () => {
      const { service, ev, prisma } = await makeService({ profile });
      await deliver(service, ev, {
        'messaging-history.set': historyEvent({
          syncType: INITIAL_BOOTSTRAP,
          progress: 100,
          conversations: [
            { id: ALPHA, name: 'Alpha', archived: true, messages: [msg(ALPHA, 'A1', 'hi')] },
            { id: BRAVO, name: 'Bravo', pinned: 1_700_000_100, muteEndTime: 1_800_000_000_000, messages: [msg(BRAVO, 'B1', 'hi')] },
            { id: CHARLIE, name: 'Charlie', messages: [msg(CHARLIE, 'C1', 'hi')] },
          ],
        }),
      });

      expect(items('chats.set')).toEqual([
        { remoteJid: ALPHA, instanceId: 'inst-1', name: 'Alpha', archived: true },
        { remoteJid: BRAVO, instanceId: 'inst-1', name: 'Bravo', pinned: 1_700_000_100, muteEndTime: 1_800_000_000_000 },
        { remoteJid: CHARLIE, instanceId: 'inst-1', name: 'Charlie' },
      ]);
      // The Chat table has no column for any of it: a stored row keeps its own shape.
      const stored = prisma.chat.rows.map(({ id: _id, ...row }: any) => row);
      expect(stored).toEqual(
        profile === 'stored'
          ? [
              { remoteJid: ALPHA, instanceId: 'inst-1', name: 'Alpha' },
              { remoteJid: BRAVO, instanceId: 'inst-1', name: 'Bravo' },
              { remoteJid: CHARLIE, instanceId: 'inst-1', name: 'Charlie' },
            ]
          : [],
      );
    });
  }

  it('an archive action folded into a chat upsert of the same batch reaches chats.upsert', async () => {
    const { service, ev } = await makeService();
    // What the socket emits for a group it learns was created (lib/Socket/messages-recv.js).
    await deliver(service, ev, {
      'chats.upsert': [{ id: GROUP, name: 'Group', conversationTimestamp: 1_700_000_000 }],
      ...syncActionEvents(['archive', GROUP], { archiveChatAction: { archived: true } }),
    });

    expect(items('chats.upsert')).toEqual([
      { remoteJid: GROUP, instanceId: 'inst-1', name: 'Group', unreadMessages: 0, archived: true },
    ]);
  });
});
