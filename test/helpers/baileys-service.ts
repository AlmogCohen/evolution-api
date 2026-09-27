// Build a BaileysStartupService with fakes around it, and a fake socket whose
// event emitter is the REAL Baileys event buffer, so eventHandler() receives
// batches the way it does in production.
import EventEmitter2 from 'eventemitter2';
import { makeEventBuffer } from 'baileys';
import P from 'pino';

import { fakePrisma } from './fake-prisma';
import { applyProfile, type Profile } from './profiles';

export const WUID = '972500000000@s.whatsapp.net';

export async function makeService(opts: { profile?: Profile } = {}) {
  applyProfile(opts.profile ?? 'minimal');
  const { BaileysStartupService } = await import('@api/integrations/channel/whatsapp/whatsapp.baileys.service');
  const { CacheService } = await import('@api/services/cache.service');
  const { LocalCache } = await import('@cache/localcache');
  const { ConfigService } = await import('@config/env.config');
  const configService = new ConfigService();
  const prisma = fakePrisma();
  const cache = new CacheService(new LocalCache(configService, 'instance'));
  const baileysCache = new CacheService(new LocalCache(configService, 'baileys'));
  const service: any = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, null as any, baileysCache, null as any);
  service.setInstance({ instanceName: 'test', instanceId: 'inst-1', integration: 'WHATSAPP-BAILEYS' });
  const ev = makeEventBuffer(P({ level: 'silent' }) as any);
  service.client = {
    ev,
    user: { id: WUID },
    profilePictureUrl: async () => undefined,
    signalRepository: { lidMapping: { getPNForLID: async () => undefined, getLIDForPN: async () => undefined } },
  };
  service.instance.wuid = WUID;
  // eventHandler() saves creds on every creds.update (Baileys emits one per history batch).
  service.instance.authState = { saveCreds: async () => undefined };
  return { service, prisma, ev };
}

/** Wire eventHandler() to the fake socket and emit a batch through the real event buffer. */
export async function deliver(service: any, ev: any, events: Record<string, any>, opts: { buffered?: boolean } = {}) {
  if (!service.__wired) {
    service.eventHandler();
    service.__wired = true;
  }
  // Baileys emits history and most message events inside a buffered function
  // (upsertMessage is ev.createBufferedFunction), so buffered is the production path.
  if (opts.buffered !== false) ev.buffer();
  for (const [name, payload] of Object.entries(events)) ev.emit(name, payload);
  if (opts.buffered !== false) await ev.flush();
  await settle(service);
}

/** eventHandler() chains every batch on eventProcessingQueue; handlers fire async work after it. */
export async function settle(service: any) {
  for (let i = 0; i < 5; i++) {
    await service.eventProcessingQueue;
    await new Promise((r) => setTimeout(r, 5));
  }
}
