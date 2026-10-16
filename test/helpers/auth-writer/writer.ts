// A child process around the real Prisma auth store, whose keys are files under
// INSTANCE_DIR (./instances of the process's cwd). test/unit/auth-key-atomic-write.test.ts
// bundles it with esbuild (aliases from tsconfig, @api/server.module replaced by
// server-module.js) and runs it with node.
//
//   loop <session> <id> <from> <size>  prints "ready" once the store is open, then writes
//                                      the key `session-<id>` over and over, tag from, from+1...,
//                                      until it is killed.
//   fault <session> <id> <size>        writes tag 1 (small) and prints "wrote 1", then tag 2
//                                      (`size`), and prints "rejected <code>" if that write
//                                      rejects, else "wrote 2".
import useMultiFileAuthStatePrisma from '@utils/use-multi-file-auth-state-prisma';

import { payload } from './payload';

async function main() {
  const [mode, session, id, ...rest] = process.argv.slice(2);
  const auth = await useMultiFileAuthStatePrisma(session, null as any);
  const write = (tag: number, size: number) => auth.state.keys.set({ session: { [id]: payload(tag, size) } } as any);
  if (mode === 'loop') {
    const [from, size] = rest.map(Number);
    process.stdout.write('ready\n');
    for (let tag = from; ; tag++) await write(tag, size);
  }
  if (mode === 'fault') {
    await write(1, 1000);
    process.stdout.write('wrote 1\n');
    const outcome = await write(2, Number(rest[0])).then(
      () => 'wrote 2',
      (error) => `rejected ${error?.code ?? error?.name}`,
    );
    process.stdout.write(`${outcome}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
