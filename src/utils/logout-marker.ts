import { INSTANCE_DIR } from '@config/path.config';
import { writeFileAtomic } from '@utils/atomic-file';
import { existsSync, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * A logout that could not reach WhatsApp is kept pending until it does, across restarts. The
 * marker is a file in the instance's directory under INSTANCE_DIR, next to the session's signal
 * key files, and removed by the same rm that wipes those keys. It is the second record: the first
 * is on the instance's row (disconnectionObject.logoutPending, BaileysStartupService.recordPending),
 * which survives the loss of that directory. No schema change: the fork stays migration-identical
 * to 2.3.7.
 */
export type LogoutMarker = { instanceName: string; deleted: boolean; since: string };

export const LOGOUT_MARKER_FILE = 'logout-pending.json';

export const logoutMarkerPath = (instanceId: string) => join(INSTANCE_DIR, instanceId, LOGOUT_MARKER_FILE);

export function readLogoutMarker(instanceId: string): LogoutMarker | undefined {
  const path = logoutMarkerPath(instanceId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Unreadable is still pending: keeping a session too long is recoverable, dropping a logout is not.
    return { instanceName: undefined, deleted: false, since: undefined };
  }
}

export async function writeLogoutMarker(instanceId: string, marker: LogoutMarker) {
  await mkdir(join(INSTANCE_DIR, instanceId), { recursive: true });
  // Replaced whole: a marker half-written over the last one would lose the instance's name.
  await writeFileAtomic(logoutMarkerPath(instanceId), JSON.stringify(marker));
}
