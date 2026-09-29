// The Prisma auth store (the one production runs, DATABASE_SAVE_DATA_INSTANCE=true)
// keeps creds in the database and every signal key (sessions, pre-keys, sender
// keys, app-state sync keys) as a JSON file under INSTANCE_DIR. It wrote a key
// with fs.writeFile over the file in place: the file is truncated first and the
// bytes follow, so a process that dies meanwhile (a crash, an OOM kill, a
// deploy's SIGKILL), a disk that fills up, or two writes of the same key at
// once leave a torn or empty file. The store reads a file that does not parse
// as no key at all, so a torn session key silently becomes a lost session.
//
// A key file on disk must always hold one complete value: the previous one or
// the new one. The crash test proves it the only way it can be proved: a child
// process runs the real store on a real filesystem and writes one key over and
// over with large, distinguishable values (4 MB each, so a write spans many
// syscalls and the window is real), and this process SIGKILLs it at random
// moments, dozens of times, reading the file after each kill.
import { vi } from 'vitest';

const tmp = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'evo-auth-atomic-')));
});
vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
// The child's INSTANCE_DIR is ./instances of its cwd (path.config), and its cwd is `tmp`.
vi.mock('@config/path.config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  INSTANCE_DIR: (await import('node:path')).join(tmp, 'instances'),
}));

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { complete, payload } from '../helpers/auth-writer/payload';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const WRITER = join(tmp, 'writer.cjs');
/** A session key id as Baileys names one (`session-<user>.<device>`). */
const ID = '972500000001.0';
const KEY_FILE = `session-${ID}.json`;
const SIZE = 4_000_000;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  // The real store and everything it imports, bundled once; packages stay external and are
  // found through NODE_PATH. The logger reads ./package.json from the cwd.
  await build({
    entryPoints: [join(REPO, 'test/helpers/auth-writer/writer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: WRITER,
    packages: 'external',
    logLevel: 'error',
    plugins: [
      {
        name: 'server-module',
        setup(b) {
          b.onResolve({ filter: /^@api\/server\.module$/ }, () => ({ path: join(REPO, 'test/helpers/auth-writer/server-module.js') }));
        },
      },
    ],
  });
  writeFileSync(join(tmp, 'package.json'), '{"version":"0.0.0"}');
});

afterAll(() => {
  children.forEach((c) => c.kill('SIGKILL'));
  rmSync(tmp, { recursive: true, force: true });
});

/** The writer in a child process; `fileSizeBlocks` caps the size of any file it writes (ulimit -f, 512-byte blocks). */
function writer(args: string[], fileSizeBlocks?: number) {
  const env = { ...process.env, NODE_PATH: join(REPO, 'node_modules'), CACHE_REDIS_ENABLED: 'false' };
  const argv = [WRITER, ...args];
  const child = fileSizeBlocks
    ? spawn('/bin/sh', ['-c', `ulimit -f ${fileSizeBlocks} && exec "$0" "$@"`, process.execPath, ...argv], { cwd: tmp, env })
    : spawn(process.execPath, argv, { cwd: tmp, env });
  children.add(child);
  const lines: string[] = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const waiting: { prefix: string; resolve: (line: string) => void }[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    for (const w of waiting.filter((w) => line.startsWith(w.prefix))) w.resolve(line);
  });
  const exited = new Promise<number | string>((resolve) =>
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve(signal ?? code);
    }),
  );
  /** The first line that starts with `prefix`; fails if the child exits first. */
  const line = (prefix: string) =>
    Promise.race([
      new Promise<string>((resolve) => waiting.push({ prefix, resolve })),
      exited.then((how) => Promise.reject(new Error(`writer exited (${how}) before "${prefix}": ${stderr}`))),
    ]);
  return { child, lines, line, exited, stderr: () => stderr };
}

const folder = (session: string) => join(tmp, 'instances', session);
const onDisk = (session: string) => {
  const file = join(folder(session), KEY_FILE);
  return complete(existsSync(file) ? readFileSync(file, 'utf8') : undefined);
};
/** Whatever is in the session's folder besides the key file. */
const strays = (session: string) => readdirSync(folder(session)).filter((f) => f !== KEY_FILE);

const open = async (session: string) => {
  const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
  return useMultiFileAuthStatePrisma(session, null as any);
};
const read = async (auth: any) => (await auth.state.keys.get('session', [ID]))[ID];

describe('a signal key file is never left half-written', () => {
  it(
    'killed at random moments while writing, the key file always holds one whole value',
    async () => {
      const LANES = 4;
      const KILLS = 16;
      const tally = { kills: 0, whole: 0, torn: 0, empty: 0, missing: 0 };
      let mostStrays = 0;

      await Promise.all(
        Array.from({ length: LANES }, async (_, lane) => {
          const session = `crash-${lane}`;
          await mkdir(folder(session), { recursive: true });
          // The value before the first kill: a complete write of tag 0.
          writeFileSync(join(folder(session), KEY_FILE), JSON.stringify(payload(0, SIZE)));
          for (let k = 0; k < KILLS; k++) {
            // Each child writes its own tags, so a whole value also says who wrote it.
            const w = writer(['loop', session, ID, String((lane * KILLS + k + 1) * 1_000_000), String(SIZE)]);
            await w.line('ready');
            // The random moment: somewhere in the child's stream of writes.
            await new Promise((r) => setTimeout(r, Math.random() * 60));
            w.child.kill('SIGKILL');
            expect(await w.exited).toBe('SIGKILL');

            const state = onDisk(session);
            tally.kills++;
            if (typeof state === 'object') tally.whole++;
            else tally[state]++;
            mostStrays = Math.max(mostStrays, strays(session).length);
          }
        }),
      );

      expect(tally).toEqual({ kills: LANES * KILLS, whole: LANES * KILLS, torn: 0, empty: 0, missing: 0 });
      // A kill can leave the write it interrupted behind, never more: the next start clears it.
      expect(mostStrays).toBeLessThanOrEqual(1);

      // A restart (a new store over the same folder) reads the value on disk, and clears what a kill left.
      for (let lane = 0; lane < LANES; lane++) {
        const session = `crash-${lane}`;
        const state = onDisk(session) as { tag: number };
        const auth = await open(session);
        expect(strays(session)).toEqual([]);
        expect((await read(auth))?.tag).toBe(state.tag);
      }
    },
    120_000,
  );

  it('a write that fails partway (the file size limit) keeps the previous value, reaches the caller, and leaves no temp file', async () => {
    const session = 'fault';
    // 1 MiB: tag 1 (1 kB) fits, tag 2 (4 MB) fails with EFBIG after the first MiB is written.
    const w = writer(['fault', session, ID, String(SIZE)], 2048);

    expect(await w.exited).toBe(0);
    expect(w.stderr()).toBe('');
    expect(w.lines).toEqual(['wrote 1', 'rejected EFBIG']);
    expect(onDisk(session)).toEqual({ tag: 1 });
    expect(strays(session)).toEqual([]);
  });

  it('concurrent writes of one key end with the last one, whole', async () => {
    const session = 'concurrent';
    const auth = await open(session);
    // Each value smaller than the one before, so the last to be asked for is the first to be written.
    const size = (tag: number) => 1_000_000 + (12 - tag) * 250_000;
    const tags = Array.from({ length: 12 }, (_, i) => i + 1);

    await Promise.all(tags.map((tag) => auth.state.keys.set({ session: { [ID]: payload(tag, size(tag)) } } as any)));

    expect(onDisk(session)).toEqual({ tag: 12 });
    expect(strays(session)).toEqual([]);
    expect(await read(auth)).toEqual(payload(12, size(12)));
  });

  it('what was written is read back, by the same store and by a new one after a restart', async () => {
    const session = 'restart';
    const auth = await open(session);
    await auth.state.keys.set({ session: { [ID]: payload(7, 10_000) } } as any);
    expect(await read(auth)).toEqual(payload(7, 10_000));

    vi.resetModules();
    const restarted = await open(session);
    expect(await read(restarted)).toEqual(payload(7, 10_000));
    expect(strays(session)).toEqual([]);
  });
});
