import { randomBytes } from 'crypto';
import { open, readdir, rename, unlink } from 'fs/promises';
import { basename, dirname, join } from 'path';

// Session key material on disk is replaced whole or not at all. A file written in place
// (fs.writeFile truncates it, then writes) is torn or empty when the process dies, the disk
// fills up or two writes of it overlap, and a key file that does not parse reads as no key.
// So the new value goes to a temp file in the same directory, is flushed (fsync), and is
// renamed over the target, which POSIX makes atomic; the directory is then flushed, so the
// rename itself survives a power loss.

/** `.<file>.<pid>.<random>.tmp`, next to the file it replaces. */
const TEMP = /^\..+\.(\d+)\.[0-9a-f]{8}\.tmp$/;

/** Temp files this process is writing now. */
const writing = new Set<string>();

/** Per file, the write under way or queued last: writes of one file run one at a time, in call order. */
const queues = new Map<string, Promise<void>>();

/**
 * Replace `file` with `data`, atomically: a reader, a crash or a failure at any moment sees the
 * previous content or the new one, never a mix, and never an empty file. Writes of the same
 * file run in the order they were asked for, so the last one asked for is the one that stays.
 * A failed write rejects, removes its temp file and leaves the previous content.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => replace(file, data));
  queues.set(file, write);
  write
    .finally(() => {
      if (queues.get(file) === write) queues.delete(file);
    })
    .catch(() => undefined);
  return write;
}

async function replace(file: string, data: string | Uint8Array) {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writing.add(temp);
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  } finally {
    writing.delete(temp);
  }
  await syncDirectory(dir);
}

/** Per directory, a flush that has not started yet: every rename before it starts is covered by it. */
const pendingSyncs = new Map<string, Promise<void>>();
/** Per directory, the flush running now. */
const runningSyncs = new Map<string, Promise<void>>();

/** Flush a directory after a rename in it. Renames that land together share one flush. */
function syncDirectory(dir: string): Promise<void> {
  // Windows cannot open a directory to flush it.
  if (process.platform === 'win32') return Promise.resolve();
  const pending = pendingSyncs.get(dir);
  if (pending) return pending;
  const next = (runningSyncs.get(dir) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      pendingSyncs.delete(dir);
      const running = flush(dir);
      runningSyncs.set(dir, running);
      running
        .finally(() => {
          if (runningSyncs.get(dir) === running) runningSyncs.delete(dir);
        })
        .catch(() => undefined);
      return running;
    });
  pendingSyncs.set(dir, next);
  return next;
}

async function flush(dir: string) {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Whether a process with this pid runs (EPERM: it does, as another user). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Remove the temp files a killed writer left in `dir`: those of a process that no longer runs,
 * and this process's own that it is not writing now (a pid a restart reused). A temp file of
 * another running process is left alone. Run when a store opens its directory.
 */
export async function removeStaleTempFiles(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const pid = Number(TEMP.exec(entry)?.[1]);
      if (!pid) return;
      const path = join(dir, entry);
      if (pid === process.pid ? writing.has(path) : alive(pid)) return;
      await unlink(path).catch(() => undefined);
    }),
  );
}
