// History exactly as the socket delivers it at link time: Baileys' own
// processMessage handles a HISTORY_SYNC_NOTIFICATION (inline payload, no download)
// inside ev.createBufferedFunction, as Socket/chats.js upsertMessage does, with a REAL
// signal repository. So the event Evolution sees is whatever this Baileys version
// really emits (rc13+: mappings stored in the repository, then dropped by the buffer).
import { deflateSync } from 'node:zlib';

import * as B from 'baileys';
import P from 'pino';

const logger: any = P({ level: 'silent' });

export async function realSignalRepository() {
  const { makeLibSignalRepository } = await import('baileys/lib/Signal/libsignal.js' as any);
  const mem: Record<string, Record<string, any>> = {};
  const store = {
    get: async (type: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, mem[type]?.[id]])),
    set: async (data: any) => {
      for (const t in data)
        for (const id in data[t]) {
          mem[t] ??= {};
          data[t][id] == null ? delete mem[t][id] : (mem[t][id] = data[t][id]);
        }
    },
  };
  const keys = (B as any).addTransactionCapability((B as any).makeCacheableSignalKeyStore(store, logger), logger, {
    maxCommitRetries: 1,
    delayBetweenTriesMs: 1,
  });
  const creds = (B as any).initAuthCreds();
  return { repo: makeLibSignalRepository({ creds, keys }, logger, async () => undefined), keys, creds };
}

export async function socketHistory(ev: any, client: any, sync: Record<string, any>) {
  const { default: processMessage } = await import('baileys/lib/Utils/process-message.js' as any);
  const { proto } = B as any;
  const hs = proto.HistorySync.fromObject(sync);
  const inline = deflateSync(Buffer.from(proto.HistorySync.encode(hs).finish()));
  const msg = {
    key: { remoteJid: '972500000000@s.whatsapp.net', fromMe: true, id: 'HS1' },
    messageTimestamp: 1_700_000_001,
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
        historySyncNotification: { syncType: hs.syncType, chunkOrder: 1, progress: 100, initialHistBootstrapInlinePayload: inline },
      },
    },
  };
  const ctx = {
    shouldProcessHistoryMsg: true,
    ev,
    logger,
    options: {},
    placeholderResendCache: undefined,
    getMessage: async () => undefined,
    creds: { ...client.__creds, me: { id: '972500000000:3@s.whatsapp.net', lid: '999999999999999:3@lid', name: 'Me' }, processedHistoryMessages: [] },
    keyStore: client.__keys,
    signalRepository: client.signalRepository,
  };
  await ev.createBufferedFunction(async () => {
    await processMessage(msg, ctx);
  })();
  // createBufferedFunction flushes on a 100ms timer when it is the only buffer.
  await new Promise((r) => setTimeout(r, 250));
}
