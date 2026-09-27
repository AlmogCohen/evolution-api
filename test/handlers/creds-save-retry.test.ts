// Baileys emits creds.update whenever the account's credentials change (pairing, pre-key uploads,
// app-state keys), and Evolution saves them. The save was not awaited and its failure not handled:
// a database blip lost the update (the process ran on creds only in memory, and a restart opened
// the old ones), and the rejection went unhandled.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { deliver, makeService, settle } from '../helpers/baileys-service';

describe('a creds.update whose save fails', () => {
  it('is saved again until it lands', async () => {
    const { service, ev } = await makeService();
    let attempts = 0;
    let saved = false;
    service.instance.authState.saveCreds = async () => {
      attempts++;
      if (attempts === 1) throw new Error("Can't reach database server");
      saved = true;
    };
    await deliver(
      service,
      ev,
      { 'creds.update': { me: { id: '972500000000:1@s.whatsapp.net' } } },
      { buffered: false },
    );
    await vi.waitFor(() => expect(saved).toBe(true), { timeout: 3_000 });
    await settle(service);
    expect(attempts).toBe(2);
  });
});
