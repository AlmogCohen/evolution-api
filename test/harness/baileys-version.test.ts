// The harness tests the Baileys that package.json pins, and a deep import
// reaches the same build as the package itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const pinned = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).dependencies.baileys;
const resolved = process.env.BAILEYS_RESOLVED_DIR!;
const version = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8')).version;

describe('harness: Baileys resolution', () => {
  it.runIf(!process.env.BAILEYS_DIR)('tests the version package.json pins', () => {
    expect(version).toBe(pinned);
  });

  it('resolves deep imports from the same build', async () => {
    const deep = await import('baileys/lib/Utils/event-buffer.js' as any);
    const top = await import('baileys');
    expect(deep.makeEventBuffer).toBe((top as any).makeEventBuffer);
  });
});
