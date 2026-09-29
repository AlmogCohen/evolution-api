// Live check archive-toggle, recorded 2026-09-27 (docs/LIVE-CHECKS.md): the owner
// archived a chat on the phone, then unarchived it. WhatsApp sent app-state chat
// actions (the archive together with an unpin), and Evolution sent chats.update
// with archived: true, then archived: false.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';

const FIXTURE = 'test/fixtures/live/2026-09-27-rig-session';
const CHAT = '100000000000002@lid';

describe('live: archive and unarchive on the phone', () => {
  it('reaches chats.update with archived: true, then archived: false', async () => {
    const { webhooks } = await replayFixture(FIXTURE);
    const archive = webhooks
      .filter((w) => w.event === 'chats.update')
      .flatMap((w) => w.data)
      .filter((c) => c.archived !== undefined);

    expect(archive).toEqual([
      expect.objectContaining({ remoteJid: CHAT, archived: true, pinned: null }),
      expect.objectContaining({ remoteJid: CHAT, archived: false }),
    ]);
    expect(compareGolden(webhooks, loadFixture(FIXTURE).webhooks, { events: ['chats.update'] })).toEqual([]);
  });
});
