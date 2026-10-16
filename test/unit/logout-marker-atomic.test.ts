// The pending-logout marker (logout-pending.json, next to the session's key
// files) is what finishes a logout WhatsApp was never told about, after a
// restart that lost the database row's record of it. It was written in place
// (fs.writeFile), so a write that failed partway, a full disk here, left half a
// marker over the whole one: it reads as pending, but with no instance name.
//
// The write fails the way a full disk fails it: the first half of the bytes
// lands, then ENOSPC. It is injected into fs/promises for whichever way the
// marker is written (writeFile on a path, or on an open file handle).
import { vi } from 'vitest';

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-marker-atomic-'));
});
const fault = vi.hoisted(() => ({ armed: false }));

vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));
vi.mock('fs/promises', async (importOriginal) => {
  const real: any = await importOriginal();
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
  const half = (data: any) => {
    const bytes = Buffer.from(data);
    return bytes.subarray(0, Math.floor(bytes.length / 2));
  };
  const writeFile = async (path: any, data: any, ...rest: any[]) => {
    if (!fault.armed) return real.writeFile(path, data, ...rest);
    await real.writeFile(path, half(data));
    throw enospc();
  };
  const open = async (...args: any[]) => {
    const handle = await real.open(...args);
    if (!fault.armed) return handle;
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'writeFile' || prop === 'write') {
          return async (data: any) => {
            await target.write(half(data));
            throw enospc();
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const faulty = { ...real, writeFile, open };
  return { ...faulty, default: faulty };
});

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { LOGOUT_MARKER_FILE, readLogoutMarker, writeLogoutMarker } from '@utils/logout-marker';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the pending-logout marker is never left half-written', () => {
  it('a marker write that fails partway keeps the previous marker, rejects, and leaves no temp file', async () => {
    const id = 'inst-marker';
    const first = { instanceName: 'first-name', deleted: false, since: new Date(0).toISOString() };
    const second = { instanceName: 'second-name', deleted: true, since: new Date(1000).toISOString() };
    await writeLogoutMarker(id, first);

    fault.armed = true;
    let outcome: string;
    try {
      outcome = await writeLogoutMarker(id, second).then(
        () => 'written',
        (error) => error?.code,
      );
    } finally {
      fault.armed = false;
    }

    expect(outcome).toBe('ENOSPC');
    expect(readLogoutMarker(id)).toEqual(first);
    expect(readdirSync(join(tmp, id))).toEqual([LOGOUT_MARKER_FILE]);

    // The next write, with room on the disk, replaces it.
    await writeLogoutMarker(id, second);
    expect(readLogoutMarker(id)).toEqual(second);
    expect(readdirSync(join(tmp, id))).toEqual([LOGOUT_MARKER_FILE]);
  });
});
