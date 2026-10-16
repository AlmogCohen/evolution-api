// Scan live-check fixtures for personal data (test/tools/fixture-guard.ts).
//
//   npx tsx scripts/live-guard.ts [files or directories...]   (default: test/fixtures/live)
//
// Prints the file, line, masked path and kind of each finding, never the value,
// and exits 1 when there is one. lint-staged runs it on staged fixture files.
import { formatFindings, scanFixtures } from '../test/tools/fixture-guard';

const paths = process.argv.slice(2);
const findings = scanFixtures(...(paths.length ? paths : ['test/fixtures/live']));
if (findings.length) {
  console.error(`live fixture guard: ${findings.length} finding(s). Fix the scrubber and re-scrub; never edit a fixture by hand.`);
  console.error(formatFindings(findings));
  process.exit(1);
}
console.log('live fixture guard: clean');
