// Build a real encrypted app-state patch with Baileys' own encoder, and decode it
// with whatever key the code under test hands back. No WhatsApp involved.
import { randomBytes } from 'node:crypto';

import { decodePatches, encodeSyncdPatch, newLTHashState, proto } from 'baileys';

export function freshAppStateKey() {
  const keyId = randomBytes(6).toString('base64');
  // As Baileys receives it in APP_STATE_SYNC_KEY_SHARE: a decoded proto message.
  const key = proto.Message.AppStateSyncKeyData.decode(
    proto.Message.AppStateSyncKeyData.encode({
      keyData: randomBytes(32),
      fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
      timestamp: Date.now(),
    }).finish(),
  );
  return { keyId, key };
}

/** A contact saved on the phone, as the phone syncs it to a linked device. */
export async function contactPatch(keyId: string, key: any, jid: string, fullName: string) {
  const { patch } = await encodeSyncdPatch(
    {
      type: 'critical_unblock_low',
      index: ['contact', jid],
      syncAction: { contactAction: { fullName } },
      apiVersion: 2,
      operation: proto.SyncdMutation.SyncdOperation.SET,
    } as any,
    keyId,
    newLTHashState(),
    async () => key,
  );
  return { ...patch, version: { version: 1 } };
}

/** Names Baileys recovers from the patch; an Error when it throws (rc9), [] when it skips (rc13+). */
export async function decodeContactNames(patch: any, getKey: (id: string) => Promise<any>) {
  try {
    const { mutationMap } = await decodePatches('critical_unblock_low', [patch], newLTHashState(), getKey, {}, 0);
    return Object.values(mutationMap).map((m: any) => m.syncAction.value?.contactAction?.fullName);
  } catch (error) {
    return error as Error;
  }
}
