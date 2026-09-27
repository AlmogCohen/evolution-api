// Scans live-check fixtures for what personal data looks like, independently of
// the scrubber that made them: it knows only the scrubber's fake ranges.
//
//   an address (JID) whose user part is not a fake: 972500<6>, 100000000<6>, 120363<12>
//   a run of 8+ digits that is neither a fake nor an epoch timestamp (s or ms)
//   a signed media URL (mmg/pps/media*.whatsapp.net, oh= / oe= parameters)
//   an email address
//   bytes ({"$bytes"}) of 16+ bytes not tagged fake by the scrubber, and any other
//   base64 blob of 24+ characters that is not one of those fake bytes
//
// A finding names the file, the line, a masked JSON path and the kind of value,
// never the value itself. Run on every commit by test/live/fixture-guard.test.ts,
// and by scripts/live-guard.ts from lint-staged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Finding = { file: string; line: number; path: string; kind: string };

const FAKE_USER = [/^972500\d{6}$/, /^100000000\d{6}$/, /^120363\d{12}$/, /^(0|16505361212|13135550002)$/];
const JID = /(\d+(?:-\d+)?)(?:[:_]\d+)*@(s\.whatsapp\.net|c\.us|hosted\.lid|hosted|lid|g\.us|broadcast|newsletter)\b/g;
const WA_DOMAIN = /^(s\.whatsapp\.net|c\.us|g\.us|lid|hosted|hosted\.lid|broadcast|newsletter)$/;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const SIGNED_URL = /(mmg|pps|media[\w.-]*)\.whatsapp\.net|[?&](oh|oe)=/i;
const BASE64 = /^[A-Za-z0-9+/]{24,}={0,2}$/;
/** Numbers under these keys are sizes, counts and times, not people. */
const NUMERIC_KEY = /(length|size|seconds|duration|count|progress|timestamp|time|^t$|^seq$|at$|height|width|expiration|ttl)/i;

const isEpoch = (d: string) => /^1\d{9}$/.test(d) || /^1\d{12}$/.test(d);
const isFakeUser = (user: string) =>
  user.split('-').every((part, i) => (i === 0 ? FAKE_USER.some((r) => r.test(part)) : isEpoch(part)));
/** A path segment that could itself be the leak (an address or a number used as a key) is masked. */
const mask = (segment: string) => (/\d{5,}|@/.test(segment) ? '<key>' : segment);

function scanString(s: string, report: (kind: string) => void, fakeBytes: Set<string>) {
  let rest = s;
  for (const m of s.matchAll(JID)) {
    if (!isFakeUser(m[1])) report('address not in the fake ranges');
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(EMAIL)) if (!WA_DOMAIN.test(m[1])) report('email address');
  if (SIGNED_URL.test(s)) report('signed media URL');
  for (const run of rest.match(/\d{8,}/g) ?? []) {
    if (!isFakeUser(run) && !isEpoch(run)) report('phone-like digit run');
  }
  if (BASE64.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && !fakeBytes.has(s)) report('base64 blob');
}

function walk(value: any, path: string[], report: (kind: string, path: string[]) => void, fakeBytes: Set<string>) {
  const at = (kind: string) => report(kind, path);
  // A commit hash can hold eight digits in a row.
  if (typeof value === 'string' && path[path.length - 1] === 'forkCommit' && /^[0-9a-f]{7,40}(-dirty)?$/.test(value)) return;
  if (typeof value === 'string') return scanString(value, at, fakeBytes);
  if (typeof value === 'number') {
    const key = path[path.length - 1] ?? '';
    if (!NUMERIC_KEY.test(key)) scanString(String(value), at, fakeBytes);
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, [...path, String(i)], report, fakeBytes));
  if (!value || typeof value !== 'object') return;
  if (typeof value.$bytes === 'string') {
    if (!value.fake && Buffer.from(value.$bytes, 'base64').length >= 16) at('bytes not tagged fake');
    return;
  }
  if (typeof value.$long === 'string') {
    const key = path[path.length - 1] ?? '';
    if (!NUMERIC_KEY.test(key)) scanString(value.$long.replace('-', ''), at, fakeBytes);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    scanString(k, (kind) => report(kind, [...path, k]), fakeBytes);
    walk(v, [...path, k], report, fakeBytes);
  }
}

/** Every fake-tagged byte string in a fixture: a plain copy of one elsewhere is not a leak. */
function collectFakeBytes(value: any, into: Set<string>) {
  if (Array.isArray(value)) return value.forEach((v) => collectFakeBytes(v, into));
  if (!value || typeof value !== 'object') return;
  if (typeof value.$bytes === 'string' && value.fake) into.add(value.$bytes);
  for (const v of Object.values(value)) collectFakeBytes(v, into);
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });

/** Parse a file into [line number, JSON value or raw text] units. */
function unitsOf(file: string): [number, any][] {
  const text = readFileSync(file, 'utf8');
  const parse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return s; // not JSON: scanned as text
    }
  };
  if (file.endsWith('.ndjson')) {
    return text.split('\n').flatMap((l, i): [number, any][] => (l.trim() ? [[i + 1, parse(l)]] : []));
  }
  return [[1, parse(text)]];
}

/** Scan files, or every file under a directory. A missing path has nothing to find. */
export function scanFixtures(...paths: string[]): Finding[] {
  const files = paths.flatMap((p) => (!existsSync(p) ? [] : statSync(p).isDirectory() ? filesUnder(p) : [p]));
  const units = files.map((file) => ({ file, units: unitsOf(file) }));
  const fakeBytes = new Set<string>();
  for (const { units: us } of units) for (const [, v] of us) collectFakeBytes(v, fakeBytes);

  const findings: Finding[] = [];
  for (const { file, units: us } of units) {
    for (const [line, value] of us) {
      walk(
        value,
        [],
        (kind, path) =>
          findings.push({ file: relative(process.cwd(), file), line, path: '$.' + path.map(mask).join('.'), kind }),
        fakeBytes,
      );
    }
  }
  return findings;
}

/** One line per finding, no values; empty when there are none. */
export function formatFindings(findings: Finding[]) {
  return findings.map((f) => `${f.file}:${f.line} ${f.kind} at ${f.path}`).join('\n');
}
