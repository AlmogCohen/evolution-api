// Turns a raw live-check recording (LIVE_RECORD_DIR/<instance>/<start>/) into a
// fixture that can be committed: test/fixtures/live/<date>-<check-id>/.
//
// It works on the tapes as written (the tagged codec, never decoded), in three steps:
//   1. collect: pair each person's phone JID with their @lid wherever one object
//      names both, so one person keeps one fake index everywhere;
//   2. rewrite every string leaf, every number that could be a person's, and every
//      object key that is an address. A string under a field no list here knows
//      stops the scrub: nothing is written, and the error names the field's path;
//   3. the leak gate (leakGate), independent of what step 2 decided: every value of
//      the raw tapes that is not structure (live-fields.ts) is searched for in every
//      value and key of the output. One hit aborts, and nothing is written.
//
// What a value becomes:
//   phone JID / @lid / group        972500<6> / 100000000<6> / 120363<12>, device suffix kept; index 0 is the owner
//   a number of 7-15 digits         the same person's fake digits (kept: epoch timestamps, and sizes and times by field)
//   a name or a username            "Name <n>", one per distinct original ("Você" kept)
//   a message id                    same first two characters and length, the rest a counter (digits: zeros, then it)
//   bytes ($bytes)                  random bytes of the same length and type, tagged fake
//   a URL                           https://example.invalid/<n>
//   a text (TEXT_KEYS)              lorem of the same length
//   a location, any other decimal   0.<nnn>, one per distinct original (the tape's own clock, t, is kept)
//   structure (live-fields.ts)      kept: event names and enums, by field, never by shape alone
//   anything else                   stops the scrub
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  isCredsKey,
  isEpoch,
  isStructural,
  LOCATION_KEYS,
  NUMERIC_KEY,
  OWNER_LABEL,
  REPLAY_INSTANCE,
} from './live-fields';

export type Operator = { phoneModel?: string; osVersion?: string; whatsappAppVersion?: string; countryCode?: string };
export type ScrubOptions = { checkId: string; date?: string; outRoot?: string; operator?: Operator };

export class LeakError extends Error {}
/** The scrub stopped on a field it does not know. Names the path, never the value. */
export class UnknownFieldError extends Error {}

const FAKE_PN = (i: number) => `972500${String(i).padStart(6, '0')}`;
const FAKE_LID = (i: number) => `100000000${String(i).padStart(6, '0')}`;
const FAKE_GROUP = (i: number) => `120363${String(i).padStart(12, '0')}`;
/** Addresses WhatsApp itself uses, never a person's. */
const SERVICE_USERS = new Set(['0', '16505361212', '13135550002']);

const JID = /^(\d+(?:-\d+)?)((?:[:_]\d+)*)@(s\.whatsapp\.net|c\.us|hosted|lid|hosted\.lid|g\.us|broadcast|newsletter)$/;
const JID_ANYWHERE =
  /(\d+(?:-\d+)?)(?:[:_]\d+)*@(?:s\.whatsapp\.net|c\.us|hosted\.lid|hosted|lid|g\.us|broadcast|newsletter)/g;
const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);
const LID_SERVERS = new Set(['lid', 'hosted.lid']);

/** Key lists, one word per key. */
const words = (list: string) => new Set(list.trim().split(/\s+/));
const NAME_KEYS = words(`
  name notify verifiedName verifiedBizName pushName username subject profileName fullName
  firstName shortName displayName vname
`);
/** A username (remoteJidUsername, participantUsername...) is a name. */
const isNameKey = (key: string) => NAME_KEYS.has(key) || /Username$/.test(key);
const TEXT_KEYS = words(`
  conversation text caption desc description title body matchedText canonicalUrl fileName address
  contentText footerText headerText vcard selectedDisplayText optionName comment message msgCall
  messageStubParameters instanceId label directPath
`);
const ID_KEYS = words(`
  id stanzaId keyId messageId callId
`);

const isInstanceKey = (key: string) => key === 'instance' || key === 'instanceName';

/** A path segment that could itself be the personal part (an address or a number used as a key) is masked. */
const maskSegment = (segment: string) => (/\d{5,}|@/.test(segment) ? '<key>' : segment);
const pathOf = (path: string[]) => '$.' + path.map(maskSegment).join('.');

const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore ';

/** A disjoint set over "pn:<digits>" / "lid:<digits>", so one person's forms share a root. */
class People {
  private parent = new Map<string, string>();
  private index = new Map<string, number>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x);
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return;
    // Keep an indexed root (the owner, seeded first) as the root.
    if (this.index.has(rb) && !this.index.has(ra)) this.parent.set(ra, rb);
    else this.parent.set(rb, ra);
  }
  indexOf(x: string): number {
    const root = this.find(x);
    if (!this.index.has(root)) this.index.set(root, this.index.size);
    return this.index.get(root);
  }
  get count() {
    return this.index.size;
  }
}

type Line = Record<string, any>;

class Scrubber {
  readonly people = new People();
  private groups = new Map<string, number>();
  private names = new Map<string, string>();
  private texts = new Map<string, string>();
  private ids = new Map<string, string>();
  private bytes = new Map<string, string>();
  private urls = new Map<string, string>();
  private digits = new Map<string, string>();
  private decimals = new Map<string, string>();

  constructor(private readonly instanceName: string) {}

  /** Step 1: pair phone and @lid where one object names both. */
  collect(value: any) {
    if (Array.isArray(value)) return value.forEach((v) => this.collect(v));
    if (!value || typeof value !== 'object' || '$bytes' in value) return;
    const pns = new Set<string>();
    const lids = new Set<string>();
    for (const v of Object.values(value)) {
      const m = typeof v === 'string' ? JID.exec(v) : null;
      if (m && PN_SERVERS.has(m[3])) pns.add(m[1]);
      if (m && LID_SERVERS.has(m[3])) lids.add(m[1]);
    }
    if (pns.size === 1 && lids.size === 1) this.people.union(`pn:${[...pns][0]}`, `lid:${[...lids][0]}`);
    for (const v of Object.values(value)) this.collect(v);
  }

  seedOwner(owner: { id?: string; lid?: string; name?: string }) {
    const pn = owner.id && JID.exec(owner.id);
    const lid = owner.lid && JID.exec(owner.lid);
    if (pn) this.people.indexOf(`pn:${pn[1]}`);
    if (pn && lid) this.people.union(`pn:${pn[1]}`, `lid:${lid[1]}`);
    else if (lid) this.people.indexOf(`lid:${lid[1]}`);
    if (owner.name) this.names.set(owner.name, 'Owner');
  }

  /** Step 2. `path` is where the value sits, for the error when its field is unknown. */
  rewrite(value: any, key = '', path: string[] = []): any {
    if (typeof value === 'string') return this.string(value, key, path);
    if (typeof value === 'number') return this.number(value, key, path);
    if (Array.isArray(value)) return value.map((v, i) => this.rewrite(v, key, [...path, String(i)]));
    if (!value || typeof value !== 'object') return value;
    if ('$bytes' in value) return { $bytes: this.fakeBytes(value.$bytes), as: value.as, fake: 1 };
    if ('$long' in value) return { ...value, $long: this.digitString(value.$long, key) };
    if ('$big' in value) return { ...value, $big: this.digitString(value.$big, key) };
    if ('$u' in value || '$fn' in value || '$date' in value) return value;
    if ('$redacted' in value) {
      // A redacted creds.update keeps the names of the creds fields, and nothing else.
      const keys = Array.isArray(value.keys) ? value.keys : [];
      const known = value.$redacted === 'creds' && keys.every((k: any) => typeof k === 'string' && isCredsKey(k));
      if (!known || Object.keys(value).some((k) => k !== '$redacted' && k !== 'keys')) {
        throw new UnknownFieldError(`unknown field at ${pathOf(path)} (a redacted value): nothing written`);
      }
      return { $redacted: value.$redacted, keys };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = JID.test(k) || /^\d{7,15}$/.test(k) ? this.string(k, '', path) : k;
      out[newKey] = this.rewrite(v, k, [...path, k]);
    }
    return out;
  }

  /** An integer of 7+ digits is a person's unless it is an epoch, or a size or a time by its field; a decimal is a place. */
  private number(n: number, key: string, path: string[]): number {
    if (LOCATION_KEYS.has(key) || !Number.isInteger(n)) {
      // The tape's own clock: milliseconds since the recording started.
      if (key === 't' && path.length === 1) return n;
      return this.fakeDecimal(n);
    }
    if (Math.abs(n) < 1e6) return n;
    return Number(this.digitString(String(n), key));
  }

  private digitString(value: string, key: string): string {
    const digits = value.replace(/^-/, '');
    if (digits.length < 7 || !/^\d+$/.test(digits)) return value;
    if (this.digits.has(digits)) return value.replace(digits, this.digits.get(digits));
    if (isEpoch(digits) || NUMERIC_KEY.test(key)) return value;
    return value.replace(digits, this.fakeUser(digits, 's.whatsapp.net'));
  }

  private string(s: string, key: string, path: string[]): string {
    if (!s) return s;
    if (s === this.instanceName && isInstanceKey(key)) return REPLAY_INSTANCE;
    const jid = JID.exec(s);
    if (jid) return this.fakeJid(jid[1], jid[2], jid[3]);
    // A numeric message id (group notifications have them) is an id, not a person.
    if (ID_KEYS.has(key) && /^\d{7,}$/.test(s) && !this.digits.has(s)) return this.fakeId(s);
    if (/^\+?\d{7,15}$/.test(s)) {
      const plus = s.startsWith('+') ? '+' : '';
      const digits = s.slice(plus.length);
      if (this.digits.has(digits)) return plus + this.digits.get(digits);
      if (isEpoch(digits)) return s;
      return plus + this.fakeUser(digits, 's.whatsapp.net');
    }
    if (isNameKey(key)) return this.fakeName(s);
    if (TEXT_KEYS.has(key)) return this.lorem(s);
    if (this.bytes.has(s)) return this.bytes.get(s);
    if (s.length >= 8 && (ID_KEYS.has(key) || /^(?=.*\d)[0-9A-F]{12,64}$/.test(s))) return this.fakeId(s);
    if (/^https?:\/\//i.test(s)) return this.memo(this.urls, s, (n) => `https://example.invalid/${n}`);
    if (isStructural(key, s)) return s;
    throw new UnknownFieldError(
      `unknown field at ${pathOf(path)} (a string of ${s.length} characters): nothing written. ` +
        'Say what the field is in live-scrub.ts or live-fields.ts, then scrub again.',
    );
  }

  private fakeJid(user: string, suffix: string, server: string) {
    if (SERVICE_USERS.has(user)) return `${user}${suffix}@${server}`;
    return `${this.fakeUser(user, server)}${suffix}@${server}`;
  }

  private fakeUser(user: string, server: string): string {
    if (server === 'g.us' || server === 'broadcast' || server === 'newsletter') {
      const [first, ts] = user.split('-');
      if (ts) return `${this.fakeUser(first, 's.whatsapp.net')}-${ts}`; // an old group: creator phone and time
      if (!this.groups.has(user)) this.groups.set(user, this.groups.size + 1);
      return this.remember(user, FAKE_GROUP(this.groups.get(user)));
    }
    if (LID_SERVERS.has(server)) return this.remember(user, FAKE_LID(this.people.indexOf(`lid:${user}`)));
    return this.remember(user, FAKE_PN(this.people.indexOf(`pn:${user}`)));
  }

  private remember(original: string, fake: string) {
    this.digits.set(original, fake);
    return fake;
  }

  private fakeName(s: string) {
    if (s === OWNER_LABEL) return s;
    return this.memo(this.names, s, (n) => `Name ${n}`);
  }

  private fakeId(s: string) {
    return this.memo(this.ids, s, (n) => {
      if (/^\d+$/.test(s)) {
        const counter = String(n).padStart(s.length - 2, '0');
        return s.slice(0, 2) + counter.slice(2 - s.length);
      }
      const body = n
        .toString(16)
        .toUpperCase()
        .padStart(s.length - 2, 'F');
      const id = s.slice(0, 2) + body.slice(-(s.length - 2));
      return s === s.toLowerCase() ? id.toLowerCase() : id;
    });
  }

  private fakeDecimal(n: number) {
    return Number(this.memo(this.decimals, String(n), (i) => `0.${String(((i - 1) % 999) + 1).padStart(3, '0')}`));
  }

  private fakeBytes(b64: string) {
    return this.memo(this.bytes, b64, () => randomBytes(Buffer.from(b64, 'base64').length).toString('base64'));
  }

  private lorem(s: string) {
    return this.memo(this.texts, s, (n) => {
      const start = (n * 7) % LOREM.length;
      return LOREM.repeat(Math.ceil((s.length + start) / LOREM.length) + 1).slice(start, start + s.length);
    });
  }

  private memo(map: Map<string, string>, s: string, make: (n: number) => string) {
    if (!map.has(s)) map.set(s, make(map.size + 1));
    return map.get(s);
  }

  counts() {
    return {
      people: this.people.count,
      groups: this.groups.size,
      names: this.names.size,
      texts: this.texts.size,
      messageIds: this.ids.size,
      bytes: this.bytes.size,
      urls: this.urls.size,
      decimals: this.decimals.size,
    };
  }
}

/**
 * Step 3, the leak gate. It reads the raw tapes itself and decides on its own what in them could be
 * a person's: every string of 4+ characters that is not structure by its field (live-fields.ts),
 * the user part of every address, every run of 7+ digits that is not an epoch, every integer of
 * 7+ digits that is not an epoch or a size or a time by its field, every decimal but the tape's
 * clock, every byte string. Then it looks for each of them in every string, number and key of the
 * output. It never asks the scrubber what it replaced. Returns the hits, as file and line only.
 */
export function leakGate(
  raw: { events: Line[]; webhooks: Line[]; owner?: Record<string, any>; instanceName: string },
  files: Record<string, string>,
): string[] {
  const originals = new Set<string>();
  const addDigits = (digits: string, key = '') => {
    if (digits.length >= 7 && !isEpoch(digits) && !SERVICE_USERS.has(digits) && !NUMERIC_KEY.test(key)) {
      originals.add(digits);
    }
  };
  const addString = (s: string, key: string) => {
    if (!s || s === OWNER_LABEL || isStructural(key, s)) return;
    if (s === raw.instanceName && isInstanceKey(key)) return;
    for (const m of s.matchAll(JID_ANYWHERE)) for (const part of m[1].split('-')) addDigits(part);
    for (const run of s.match(/\d{7,}/g) ?? []) addDigits(run);
    if (s.length >= 4) originals.add(s);
  };
  const walk = (value: any, key: string, depth: number) => {
    if (typeof value === 'string') return addString(value, key);
    if (typeof value === 'number') {
      if (Number.isInteger(value) && !LOCATION_KEYS.has(key)) return addDigits(String(Math.abs(value)), key);
      if (key === 't' && depth === 1) return;
      return void originals.add(String(value));
    }
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key, depth + 1));
    if (!value || typeof value !== 'object') return;
    if (typeof value.$bytes === 'string') return void (value.$bytes.length >= 4 && originals.add(value.$bytes));
    if (typeof value.$long === 'string') return addDigits(value.$long.replace(/^-/, ''), key);
    if (typeof value.$big === 'string') return addDigits(value.$big.replace(/^-/, ''), key);
    if ('$u' in value || '$fn' in value || '$date' in value || '$redacted' in value) return;
    for (const [k, v] of Object.entries(value)) {
      if (JID.test(k) || /^\d{7,15}$/.test(k)) addString(k, '');
      walk(v, k, depth + 1);
    }
  };
  for (const line of [...raw.events, ...raw.webhooks]) walk(line, '', 0);
  const owner = raw.owner ?? {};
  for (const key of ['id', 'lid', 'name']) if (typeof owner[key] === 'string') addString(owner[key], key);
  const searched = [...originals];

  const hits: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const units = file.endsWith('.ndjson')
      ? text.split('\n').flatMap((l, i): [number, any][] => (l.trim() ? [[i + 1, JSON.parse(l)]] : []))
      : [[1, JSON.parse(text)] as [number, any]];
    for (const [line, unit] of units) {
      let hit = false;
      const check = (s: string) => {
        if (!hit && searched.some((o) => s.includes(o))) hit = true;
      };
      const scan = (value: any, key: string) => {
        if (hit) return;
        if (typeof value === 'string') return isStructural(key, value) ? undefined : check(value);
        if (typeof value === 'number') return check(String(value));
        if (Array.isArray(value)) return value.forEach((v) => scan(v, key));
        if (!value || typeof value !== 'object') return;
        for (const [k, v] of Object.entries(value)) {
          check(k);
          scan(v, k);
        }
      };
      scan(unit, '');
      if (hit) hits.push(`${file} line ${line}`);
    }
  }
  return hits;
}

const readLines = (file: string): Line[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

/** Scrub one raw session. Returns the fixture directory; throws LeakError (writing nothing) on a leak. */
export function scrubSession(rawDir: string, opts: ScrubOptions) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.checkId)) throw new Error(`check id must be kebab-case: ${opts.checkId}`);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const operator = opts.operator ?? {};
  if (operator.countryCode !== undefined && !/^\d{1,3}$/.test(operator.countryCode)) {
    throw new Error('country code only (1 to 3 digits), never a phone number');
  }

  const instanceName = basename(dirname(rawDir));
  const events = readLines(join(rawDir, 'events.ndjson'));
  const webhooks = readLines(join(rawDir, 'webhooks.ndjson'));
  const rawManifest = JSON.parse(readFileSync(join(rawDir, 'manifest.json'), 'utf8'));
  const ownerFile = join(rawDir, 'owner.json');
  const owner = existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : {};

  const scrubber = new Scrubber(instanceName);
  scrubber.seedOwner(owner);
  for (const line of [...events, ...webhooks]) scrubber.collect(line);

  const files: Record<string, string> = {};
  const tape = (lines: Line[]) => lines.map((l) => JSON.stringify(scrubber.rewrite(l)) + '\n').join('');
  files['events.ndjson'] = tape(events);
  files['webhooks.ndjson'] = tape(webhooks);
  const fakeOwner = scrubber.rewrite({ id: owner.id, lid: owner.lid, name: owner.name });
  const manifest = {
    ...rawManifest,
    checkId: opts.checkId,
    date,
    phoneModel: operator.phoneModel ?? null,
    osVersion: operator.osVersion ?? null,
    whatsappAppVersion: operator.whatsappAppVersion ?? null,
    countryCode: operator.countryCode ?? null,
    replay: { owner: fakeOwner },
  };
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';

  // Step 3, the leak gate: fail closed.
  const hits = leakGate({ events, webhooks, owner, instanceName }, files);
  if (hits.length) {
    throw new LeakError(
      `leak gate: an original survived in ${hits.length} place(s), nothing written:\n  ${hits.join('\n  ')}`,
    );
  }

  const report = { leakGate: 'pass', events: events.length, webhooks: webhooks.length, ...scrubber.counts() };
  files['scrub-report.json'] = JSON.stringify(report, null, 2) + '\n';

  const dir = join(opts.outRoot ?? join(process.cwd(), 'test', 'fixtures', 'live'), `${date}-${opts.checkId}`);
  if (existsSync(dir)) throw new Error(`${dir} exists: remove it or pick another check id`);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return { dir, report };
}
