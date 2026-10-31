// Evolution's own TypeScript source, run by vitest, against the Baileys that
// npm installed (package.json pins it). BAILEYS_DIR points the same tests at
// another Baileys build, for trying a newer release before bumping the pin.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const baileysDir = process.env.BAILEYS_DIR ?? dirname(require.resolve('baileys/package.json'));
process.env.BAILEYS_RESOLVED_DIR = baileysDir;

export default defineConfig({
  resolve: {
    // Both the package and deep imports (baileys/lib/...) resolve to ONE directory,
    // so a test can never mix two Baileys versions.
    alias: [
      { find: /^baileys$/, replacement: `${baileysDir}/lib/index.js` },
      { find: /^baileys\/(.*)$/, replacement: `${baileysDir}/$1` },
      { find: /^@api\/(.*)$/, replacement: `${root}src/api/$1` },
      { find: /^@cache\/(.*)$/, replacement: `${root}src/cache/$1` },
      { find: /^@config\/(.*)$/, replacement: `${root}src/config/$1` },
      { find: /^@exceptions$/, replacement: `${root}src/exceptions` },
      { find: /^@libs\/(.*)$/, replacement: `${root}src/libs/$1` },
      { find: /^@utils\/(.*)$/, replacement: `${root}src/utils/$1` },
      { find: /^@validate\/(.*)$/, replacement: `${root}src/validate/$1` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20000,
  },
});
