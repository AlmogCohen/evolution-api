// Live check app-state-after-restart, recorded 2026-09-27 (docs/LIVE-CHECKS.md):
// after a restart, the owner renamed a saved contact on the phone. WhatsApp sent
// the rename as an app-state contact action with the @lid to phone mapping, and
// Evolution sent the mapping item, the contact marked saved, and the update echo.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { encode } from '@utils/live-record/codec';

import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';

const FIXTURE = 'test/fixtures/live/2026-09-27-rig-session';
const CONTACT = { pn: '972500000001@s.whatsapp.net', lid: '100000000000001@lid' };

/** Webhooks about the renamed contact only (the DM later in the session depends on the live database). */
const aboutContact = (w: Record<string, any>) => JSON.stringify(encode(w.data)).includes(CONTACT.pn.split('@')[0]);

describe('live: a contact renamed on the phone after a restart', () => {
  it('reaches contacts.upsert as a mapping item and as a saved name, then contacts.update', async () => {
    const { webhooks } = await replayFixture(FIXTURE);
    const contacts = webhooks.filter((w) => w.event.startsWith('contacts.') && aboutContact(w));
    const upserts = contacts.filter((w) => w.event === 'contacts.upsert').flatMap((w) => w.data);

    // The @lid to phone mapping, forwarded as its own item.
    expect(upserts).toContainEqual(
      expect.objectContaining({ remoteJid: CONTACT.pn, lid: CONTACT.lid, phoneNumber: CONTACT.pn }),
    );
    // The name the owner saved, marked saved.
    const saved = upserts.find((c) => c.saved !== undefined);
    expect(saved).toMatchObject({ remoteJid: CONTACT.pn, pushName: 'Name 2', saved: true });

    expect(contacts.map((w) => w.event)).toEqual(['contacts.upsert', 'contacts.upsert', 'contacts.update']);
    const golden = loadFixture(FIXTURE).webhooks.filter((w) => w.event.startsWith('contacts.') && aboutContact(w));
    expect(compareGolden(contacts, golden)).toEqual([]);
  });
});
