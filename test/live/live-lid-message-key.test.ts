// Live check live-lid-message-key, recorded 2026-09-27 (docs/LIVE-CHECKS.md): a
// text and an image arrived in a DM that WhatsApp addressed by @lid (remoteJid
// @lid, remoteJidAlt the phone, addressingMode 'lid'). Evolution shows the phone
// as remoteJid and keeps the original @lid in remoteJidAlt, with addressingMode 'pn'.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';

const FIXTURE = 'test/fixtures/live/2026-09-27-rig-session';
const SENDER = { pn: '972500000002@s.whatsapp.net', lid: '100000000000002@lid' };

describe('live: a DM addressed by @lid', () => {
  it('reaches messages.upsert with the phone as remoteJid and the @lid kept in remoteJidAlt', async () => {
    const { webhooks } = await replayFixture(FIXTURE);
    const upserts = webhooks.filter((w) => w.event === 'messages.upsert').map((w) => w.data);

    expect(upserts.map((m) => m.messageType)).toEqual(['conversation', 'imageMessage']);
    for (const message of upserts) {
      expect(message.key).toMatchObject({
        remoteJid: SENDER.pn,
        remoteJidAlt: SENDER.lid,
        addressingMode: 'pn',
        fromMe: false,
      });
    }
    const golden = loadFixture(FIXTURE).webhooks;
    expect(compareGolden(webhooks, golden, { events: ['messages.upsert'] })).toEqual([]);
  });
});
