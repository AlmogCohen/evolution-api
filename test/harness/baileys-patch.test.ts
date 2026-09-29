// The Baileys this fork runs is the pinned release plus the patches in
// patches/, applied by patch-package on npm's postinstall (npm ci in the Docker
// builder included). A patch is named for the version it was written against,
// so a Baileys bump that forgets it, or an install that skipped it, fails here
// instead of shipping a Baileys that cannot link a device.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pinned = pkg.dependencies.baileys;
const resolved = process.env.BAILEYS_RESOLVED_DIR!;

/** Each hunk of a unified diff, as the text of its new side, per file (relative to the package). */
function hunks(patch: string) {
  const out: { file: string; text: string }[] = [];
  let file = '';
  let lines: string[] | undefined;
  const flush = () => lines && out.push({ file, text: lines.join('\n') });
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      lines = undefined;
    } else if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ b\/node_modules\/baileys\//, '');
    } else if (line.startsWith('@@')) {
      flush();
      lines = [];
    } else if (lines && (line.startsWith(' ') || line.startsWith('+'))) {
      lines.push(line.slice(1));
    }
  }
  flush();
  return out;
}

describe('harness: the pinned Baileys carries its patch', () => {
  const patchFile = join(root, 'patches', `baileys+${pinned}.patch`);

  it('patches/ holds a patch for the pinned version, and none for another', () => {
    expect(existsSync(patchFile)).toBe(true);
    expect(readdirSync(join(root, 'patches')).filter((f) => f.startsWith('baileys+'))).toEqual([`baileys+${pinned}.patch`]);
  });

  it.runIf(!process.env.BAILEYS_DIR)('every hunk of it is in the Baileys under test', () => {
    const missing = hunks(readFileSync(patchFile, 'utf8')).filter(
      ({ file, text }) => !readFileSync(join(resolved, file), 'utf8').includes(text),
    );
    expect(missing.map((h) => h.file)).toEqual([]);
  });

  it('npm applies it on install, including the Docker build', () => {
    expect(pkg.scripts.postinstall).toBe('patch-package --error-on-fail');
    // The builder runs npm ci with dev dependencies, so patch-package is there when postinstall runs.
    expect(pkg.devDependencies['patch-package']).toBeDefined();
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8').split('\n');
    const copy = docker.findIndex((l) => /^COPY \.\/patches \.\/patches\s*$/.test(l));
    const ci = docker.findIndex((l) => /^RUN npm ci\b/.test(l));
    expect(copy).toBeGreaterThan(-1);
    expect(ci).toBeGreaterThan(copy);
    expect(docker[ci]).not.toMatch(/--ignore-scripts|--omit[= ]dev|--production/);
  });
});
