// A logout that could not reach WhatsApp stays pending across a restart (a
// marker in the instance's directory); on boot Evolution connects only to
// deliver it. When that connect fails (the network is still down), the line
// it logs must say why, as the reconnect loop's does: the error's name, its
// message (scrubbed: no URL, JID or phone number) and its status code when it
// has one. It printed the thrown value's toString(), which for the 500 that
// openConnection throws is "[object Object]".
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-pending-log-'));
});

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { rmSync } from 'node:fs';

import { Boom } from '@hapi/boom';
import { writeLogoutMarker } from '@utils/logout-marker';
import { afterAll, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { captureOutput } from '../helpers/capture-output';
import { fakeSocket } from '../helpers/connect';

socketSpy.mockImplementation(fakeSocket);

const PHONE = '972509876543';
const URL_SECRET = 'https://web.whatsapp.com/check?token=Zq7secret';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('a failed connect for a pending logout says why', () => {
  it('a Boom: its name, scrubbed message and status code', async () => {
    await writeLogoutMarker('inst-1', { instanceName: 'test', deleted: false, since: new Date(0).toISOString() });
    const { service } = await makeService();
    service.defineAuthState = async () => {
      throw new Boom(`request to ${URL_SECRET} for ${PHONE}@s.whatsapp.net failed, reason: getaddrinfo ENOTFOUND`, {
        statusCode: 503,
      });
    };

    let resumed: boolean | undefined;
    const out = await captureOutput(async () => {
      resumed = await service.resumePendingLogout();
    });
    service.stopReconnecting();

    expect(resumed).toBe(true);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    const logged = plain
      .split('\n')
      .filter((l) => l.includes('Connect for a pending logout failed'))
      .map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    expect(logged).toEqual([
      {
        message: 'Connect for a pending logout failed',
        error: { name: 'Error', message: 'request to [url] for [jid] failed, reason: getaddrinfo ENOTFOUND', statusCode: 503 },
      },
    ]);
    expect(plain).not.toContain(PHONE);
    expect(plain).not.toContain('Zq7secret');
  });
});
