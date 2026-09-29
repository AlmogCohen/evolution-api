// Say which Baileys every run tested, and fail the run when it is not the one
// the job expected (BAILEYS_EXPECT), so a green run can never be a run against
// the wrong version.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export default function () {
  const require = createRequire(import.meta.url);
  const dir = process.env.BAILEYS_DIR ?? dirname(require.resolve('baileys/package.json'));
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  console.log(`[harness] baileys ${version} from ${dir}`);
  const expected = process.env.BAILEYS_EXPECT;
  if (expected && expected !== version) throw new Error(`BAILEYS_EXPECT=${expected}, but the tests resolve baileys ${version} (${dir})`);
}
