// Scrub a raw live-check recording into a committable fixture (docs/LIVE-CHECKS.md).
//
//   npx tsx scripts/live-scrub.ts <raw session dir> <check-id> [--date YYYY-MM-DD]
//     [--phone-model "Pixel 8"] [--os-version "Android 15"] [--wa-version 2.25.27.78]
//     [--country-code 972] [--out test/fixtures/live]
//
// Exits 1 and writes nothing when the leak gate finds an original in the output.
import { scrubSession } from '../test/tools/live-scrub';

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [rawDir, checkId] = positional;
if (!rawDir || !checkId) {
  console.error('usage: npx tsx scripts/live-scrub.ts <raw session dir> <check-id> [--date YYYY-MM-DD] [--phone-model ...] [--os-version ...] [--wa-version ...] [--country-code ...] [--out dir]');
  process.exit(2);
}

try {
  const { dir, report } = scrubSession(rawDir, {
    checkId,
    date: flags.date,
    outRoot: flags.out,
    operator: {
      phoneModel: flags['phone-model'],
      osVersion: flags['os-version'],
      whatsappAppVersion: flags['wa-version'],
      countryCode: flags['country-code'],
    },
  });
  console.log(`fixture written: ${dir}`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
