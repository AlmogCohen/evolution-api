// Evolution handles a socket's batches one at a time, on a queue (eventProcessingQueue): a batch
// can wait there behind a slow one (a large history sync) for a long time. The check that the
// batch's socket is still the instance's ran when the batch was queued, not when it ran. So a
// batch queued before the instance was removed (shut down: DELETE, DEL_INSTANCE) still ran after
// it: webhooks for an instance that no longer exists, and rows written again under it after its
// data was deleted. A lookup finishing late (a profile picture) did the same.
import { vi } from 'vitest';

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));

import { describe, expect, it } from 'vitest';

import { makeService, settle } from '../helpers/baileys-service';
import { emitted } from '../helpers/fake-server-module';

const CONTACT = '972500000001@s.whatsapp.net';

describe('an instance shut down while batches wait on its queue', () => {
  it('runs none of them afterwards: no webhook, no row', async () => {
    emitted.length = 0;
    const { service, ev, prisma } = await makeService({ profile: 'stored' });
    service.eventHandler();
    let release: () => void;
    service.eventProcessingQueue = new Promise<void>((r) => (release = r));

    ev.emit('contacts.upsert', [{ id: CONTACT, notify: 'Tal' }]);
    service.shutdown();
    release();
    await settle(service);

    expect({ webhooks: emitted.map((e) => e.event), contacts: prisma.contact.rows.length }).toEqual({
      webhooks: [],
      contacts: 0,
    });
  });

  it('forwards nothing a lookup finishes after it', async () => {
    emitted.length = 0;
    const { service, ev } = await makeService();
    let answer: (url: string) => void;
    service.client.profilePictureUrl = () => new Promise<string>((r) => (answer = r));
    service.eventHandler();
    ev.emit('contacts.upsert', [{ id: CONTACT, notify: 'Tal' }]);
    await settle(service);
    await vi.waitFor(() => expect(answer).toBeDefined());
    emitted.length = 0;

    service.shutdown();
    answer('https://pps.whatsapp.net/v/t61/picture.jpg');
    await settle(service);
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted.map((e) => e.event)).toEqual([]);
  });

  it('still announces its own removal, which the monitor sends after shutting it down', async () => {
    emitted.length = 0;
    const { service } = await makeService();
    service.shutdown();
    await service.sendDataWebhook('remove.instance', null);
    expect(emitted.map((e) => e.event)).toEqual(['remove.instance']);
  });
});
