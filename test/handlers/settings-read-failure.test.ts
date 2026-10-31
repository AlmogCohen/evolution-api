// eventHandler() starts every event batch by reading the instance's Setting row
// (findSettings), inside the one try that covers the whole batch. When that read
// failed, the batch was dropped: messages.upsert, creds.update and
// connection.update alike, with nothing sent to the webhook. A database blip
// therefore lost the messages that arrived during it.
//
// A failed settings read must not cost the batch. The batch runs with the last
// known settings (loaded at connect, kept by /settings/set), and the failure is
// logged without anything the batch carries.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { beforeEach, describe, expect, it } from 'vitest';

import { msg } from '../helpers/baileys-fixtures';
import { deliver, makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { emitted } from '../helpers/fake-server-module';
import type { Profile } from '../helpers/profiles';

const PHONE = '972509876543';
const SENDER = `${PHONE}@s.whatsapp.net`;
const GROUP = '120363000000000002@g.us';
const TEXT = 'Zq9 a message that arrived during a database blip Zq9';
const DB_ERROR = "Can't reach database server at `127.0.0.1:5432`";

beforeEach(() => void emitted.splice(0));

/** A connected instance whose stored settings ignore groups, and whose next Setting read fails. */
async function serviceWithFailingSettingsRead(profile: Profile) {
  const { service, prisma, ev } = await makeService({ profile });
  await prisma.setting.create({
    data: { instanceId: 'inst-1', rejectCall: false, msgCall: '', groupsIgnore: true, readMessages: false, readStatus: false },
  });
  await service.loadSettings(); // what connectToWhatsapp does before the socket opens
  const read = prisma.setting.findUnique;
  let failed = false;
  prisma.setting.findUnique = async (args: any) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error(DB_ERROR), { code: 'P1001' });
    }
    return read(args);
  };
  return { service, ev };
}

describe.each(['minimal', 'stored'] as Profile[])('a failed settings read does not drop an event batch (profile %s)', (profile) => {
  it('the batch messages still reach the webhook, under the last known settings', async () => {
    const { service, ev } = await serviceWithFailingSettingsRead(profile);
    const direct = msg(SENDER, 'B1', TEXT).message;
    // Stored groupsIgnore is true, so this one is skipped; defaults (no settings) would send it.
    const group = msg(GROUP, 'B2', TEXT, { key: { remoteJid: GROUP, fromMe: false, id: 'B2', participant: SENDER } }).message;
    const out = await captureOutput(() => deliver(service, ev, { 'messages.upsert': { messages: [direct, group], type: 'notify' } }));

    const upserts = emitted
      .filter((e) => e.event === 'messages.upsert')
      .map((e) => ({ id: e.data?.key?.id, remoteJid: e.data?.key?.remoteJid, text: e.data?.message?.conversation }));
    expect(upserts).toEqual([{ id: 'B1', remoteJid: SENDER, text: TEXT }]);

    // The failure is logged, and nothing the batch carries is.
    const lines = out.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(lines.some((l) => l.includes('Settings read failed') && l.includes(DB_ERROR))).toBe(true);
    expect(lines.filter((l) => l.includes('Zq9') || l.includes(PHONE))).toEqual([]);
  });
});
