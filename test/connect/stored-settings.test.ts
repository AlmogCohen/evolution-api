// connectToWhatsapp loads the instance's settings from the database and then
// builds the socket, which takes several of them as config: syncFullHistory
// (history at link time), groupsIgnore and readStatus (shouldIgnoreJid) and
// alwaysOnline (markOnlineOnConnect). If the socket is built before the Setting
// row has been read, it is built from defaults. A real database round trip
// takes time, so the fake one here does too.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
// This file is about settings; the version fetch has its own tests.
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';
import { loopbackOnly } from '../helpers/local-net';

socketSpy.mockImplementation(fakeSocket);

const SETTING_READ_MS = 50;
const GROUP = '120363000000000000@g.us';
const DM = '972500000001@s.whatsapp.net';

let guard: ReturnType<typeof loopbackOnly>;
beforeAll(() => void (guard = loopbackOnly()));
afterAll(() => {
  expect(guard.refused).toEqual([]);
  guard.restore();
});

/** A service as the monitor builds it on boot: the Setting row is in the database, nothing is in memory yet. */
async function bootedService(settings: Record<string, unknown>) {
  const { service, prisma } = await makeService();
  await prisma.setting.create({
    data: { instanceId: 'inst-1', rejectCall: false, msgCall: '', readMessages: false, readStatus: false, ...settings },
  });
  const read = prisma.setting.findUnique;
  prisma.setting.findUnique = async (args: any) => {
    await new Promise((r) => setTimeout(r, SETTING_READ_MS));
    return read(args);
  };
  stubAuthState(service);
  return service;
}

async function connect(service: any) {
  const before = socketSpy.mock.calls.length;
  await service.connectToWhatsapp();
  const config = socketSpy.mock.calls[before][0];
  return {
    syncFullHistory: config.syncFullHistory,
    markOnlineOnConnect: config.markOnlineOnConnect,
    ignoresGroup: !!config.shouldIgnoreJid(GROUP),
    ignoresDm: !!config.shouldIgnoreJid(DM),
  };
}

// Evolution's own rule (createClient, shouldIgnoreJid): with full history on, groups are kept even when groupsIgnore is set.
const cases = [
  {
    name: 'full history, groups ignored, always online',
    settings: { syncFullHistory: true, groupsIgnore: true, alwaysOnline: true },
    expected: { syncFullHistory: true, markOnlineOnConnect: true, ignoresGroup: false, ignoresDm: false },
  },
  {
    name: 'no full history, groups ignored, always online',
    settings: { syncFullHistory: false, groupsIgnore: true, alwaysOnline: true },
    expected: { syncFullHistory: false, markOnlineOnConnect: true, ignoresGroup: true, ignoresDm: false },
  },
];

describe('a connect uses the instance stored settings, not defaults', () => {
  for (const { name, settings, expected } of cases) {
    it(`on boot (${name})`, async () => {
      const service = await bootedService(settings);
      expect(await connect(service)).toEqual(expected);
    });

    // A reconnect comes to an instance that has been running, so the first connect's reads have landed.
    // loadSettings, unlike loadProxy, does not clear the values before reading, so this case holds
    // on the code before the fix too: it guards the reconnect path against a fix that breaks it.
    it(`on a restart or reconnect (${name})`, async () => {
      const service = await bootedService(settings);
      await connect(service);
      await new Promise((r) => setTimeout(r, SETTING_READ_MS * 2));
      expect(await connect(service)).toEqual(expected);
    });
  }
});
