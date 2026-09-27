// Fixtures are WhatsApp-side inputs (a HistorySync proto, an app-state sync
// action). The Baileys version under test turns them into events, so each
// version hands Evolution exactly what it would in production, no more.
import { processHistoryMessage, processSyncAction, proto } from 'baileys';

import { WUID } from './baileys-service';

/** What Baileys emits as messaging-history.set for this HistorySync payload. */
export function historyEvent(sync: Record<string, any>) {
  const data: any = (processHistoryMessage as any)(proto.HistorySync.fromObject(sync));
  return { ...data, isLatest: true };
}

/** The events Baileys emits for one decoded app-state mutation. */
export function syncActionEvents(index: string[], action: Record<string, any>) {
  const events: Record<string, any> = {};
  const collector: any = { emit: (name: string, data: any) => void (events[name] = data) };
  const syncAction = { index, syncAction: { value: proto.SyncActionValue.fromObject({ timestamp: 1_700_000_000, ...action }) } };
  (processSyncAction as any)(syncAction, collector, { id: WUID, name: 'Me' }, undefined, undefined);
  return events;
}

export const msg = (remoteJid: string, id: string, text: string, extra: Record<string, any> = {}) => ({
  message: {
    key: { remoteJid, fromMe: false, id },
    message: { conversation: text },
    messageTimestamp: 1_700_000_000,
    ...extra,
  },
});
