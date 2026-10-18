// WhatsApp addresses many personal chats by a private @lid, and Baileys (rc13+)
// learns which phone number each @lid belongs to: from the history sync
// (`lidPnMappings` on messaging-history.set, built from phoneNumberToLidMappings
// and from each conversation's pnJid / lidJid) and live (`lid-mapping.update`).
// A consumer learns a mapping from one CONTACTS_UPSERT item:
//   { remoteJid: <phone>, pushName: null, lid: <lid>, phoneNumber: <phone>, instanceId }
//
// History runs through the production path: Baileys' own processMessage inside
// ev.createBufferedFunction, with a real signal repository. That matters because
// Baileys' event buffer drops `lidPnMappings` when it flushes a buffered
// messaging-history.set (lib/Utils/event-buffer.js, consolidateEvents), so a fix
// that only reads the field off the event is not enough.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { msg, syncActionEvents } from '../helpers/baileys-fixtures';
import { deliver, makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';
import { realSignalRepository, socketHistory } from '../helpers/socket-history';

const INITIAL_BOOTSTRAP = 0;
const RECENT = 3;

const lid = (n: number) => `1000000000000${String(n).padStart(2, '0')}@lid`;
const pn = (n: number) => `9725000000${String(n).padStart(2, '0')}@s.whatsapp.net`;

/** The item a consumer reads a mapping from. */
const mapping = (n: number) => ({ remoteJid: pn(n), pushName: null, lid: lid(n), phoneNumber: pn(n), instanceId: 'inst-1' });

/** Every CONTACTS_UPSERT item, as the webhook carries it. */
const contactItems = () =>
  emitted.filter((e) => e.event === 'contacts.upsert').flatMap((e) => [].concat(e.data ?? []) as any[]);

/** The CONTACTS_UPSERT items that carry a mapping, ordered by lid. */
const mappingItems = () =>
  contactItems()
    .filter((item) => item && ('lid' in item || 'phoneNumber' in item))
    .sort((a, b) => String(a.lid).localeCompare(String(b.lid)));

/** A service wired to a real signal repository, fed history the way the socket feeds it. */
async function linkTime() {
  const { service, ev } = await makeService();
  const { repo, keys, creds } = await realSignalRepository();
  Object.assign(service.client, { signalRepository: repo, __keys: keys, __creds: creds });
  service.eventHandler();
  service.__wired = true;
  const history = async (sync: Record<string, any>) => {
    await socketHistory(ev, service.client, { syncType: INITIAL_BOOTSTRAP, progress: 100, ...sync });
    await settle(service);
  };
  return { service, ev, history };
}

describe('@lid to phone mappings reach CONTACTS_UPSERT', () => {
  beforeEach(() => void emitted.splice(0));

  it('(a) a conversation keyed by the @lid, mapped by phoneNumberToLidMappings or by its own pnJid', async () => {
    const { history } = await linkTime();
    await history({
      conversations: [
        { id: lid(1), messages: [msg(lid(1), 'A1', 'hi')] },
        { id: lid(2), pnJid: pn(2), messages: [msg(lid(2), 'A2', 'hello')] },
      ],
      phoneNumberToLidMappings: [{ lidJid: lid(1), pnJid: pn(1) }],
    });
    expect(mappingItems()).toEqual([mapping(1), mapping(2)]);
  });

  it('(b) a conversation keyed by the phone number, whose lidJid is set', async () => {
    const { history } = await linkTime();
    await history({ conversations: [{ id: pn(3), lidJid: lid(3), messages: [msg(pn(3), 'B1', 'hi')] }] });
    expect(mappingItems()).toEqual([mapping(3)]);
  });

  it('(c) a mapping in phoneNumberToLidMappings with no conversation of its own', async () => {
    const { history } = await linkTime();
    await history({
      conversations: [{ id: '120363000000000001@g.us', messages: [msg('120363000000000001@g.us', 'C1', 'group')] }],
      phoneNumberToLidMappings: [{ lidJid: lid(4), pnJid: pn(4) }],
    });
    expect(mappingItems()).toEqual([mapping(4)]);
  });

  it('(d) the mapping arrives in a later history batch than its conversation', async () => {
    const { history } = await linkTime();
    await history({ conversations: [{ id: lid(5), messages: [msg(lid(5), 'D1', 'hi')] }] });
    await history({ syncType: RECENT, conversations: [], phoneNumberToLidMappings: [{ lidJid: lid(5), pnJid: pn(5) }] });
    expect(mappingItems()).toEqual([mapping(5)]);
  });

  it('(d) the mapping arrives in an earlier history batch than its conversation', async () => {
    const { history } = await linkTime();
    await history({ conversations: [], phoneNumberToLidMappings: [{ lidJid: lid(6), pnJid: pn(6) }] });
    await history({ syncType: RECENT, conversations: [{ id: lid(6), messages: [msg(lid(6), 'D2', 'hi')] }] });
    expect(mappingItems()).toEqual([mapping(6)]);
  });

  it('(e) live, from the phone (pnForLidChatAction -> lid-mapping.update)', async () => {
    const { service, ev } = await makeService();
    const events = syncActionEvents(['pnForLidChat', lid(7)], { pnForLidChatAction: { pnJid: pn(7) } });
    expect(Object.keys(events)).toContain('lid-mapping.update');
    await deliver(service, ev, events);
    expect(mappingItems()).toEqual([mapping(7)]);
  });

  it('invents no mapping for an unmapped @lid, and links no unrelated pair', async () => {
    const { history } = await linkTime();
    await history({
      conversations: [
        { id: lid(8), messages: [msg(lid(8), 'N1', 'nobody told us who I am')] },
        { id: lid(9), messages: [msg(lid(9), 'N2', 'hi')] },
      ],
      phoneNumberToLidMappings: [
        { lidJid: lid(9), pnJid: pn(9) },
        { lidJid: lid(10), pnJid: pn(10) },
      ],
    });
    expect(mappingItems()).toEqual([mapping(9), mapping(10)]);
    const items = contactItems();
    expect(items.filter((i) => i.lid === lid(8) || (i.remoteJid === lid(8) && i.phoneNumber))).toEqual([]);
    expect(items.filter((i) => (i.lid === lid(9) && i.phoneNumber !== pn(9)) || (i.lid === lid(10) && i.phoneNumber !== pn(10)))).toEqual([]);
  });
});
