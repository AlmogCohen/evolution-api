// Turns a raw live-check recording (LIVE_RECORD_DIR/<instance>/<start>/) into a
// fixture that can be committed: test/fixtures/live/<date>-<check-id>/.
//
// It works on the tapes as written (the tagged codec, never decoded), in three steps:
//   1. collect: pair each person's phone JID with their @lid wherever one object
//      names both, so one person keeps one fake index everywhere;
//   2. rewrite every string leaf, and every object key that is an address;
//   3. the leak gate: search the whole output for every original (numbers, names,
//      byte strings, and every raw string of 4+ characters the rewrite replaced).
//      One hit aborts, and nothing is written.
//
// What a string becomes:
//   phone JID / @lid / group        972500<6> / 100000000<6> / 120363<12>, device suffix kept; index 0 is the owner
//   a bare number of 7-15 digits    the same person's fake digits (epoch timestamps are kept)
//   a name (name, notify, pushName, subject...)  "Name <n>", one per distinct original ("Você" kept)
//   a message id                    same first two characters and length, the rest a counter
//   bytes ($bytes)                  random bytes of the same length and type, tagged fake
//   a URL                           https://example.invalid/<n>
//   structure (event names, enums, mimetypes, dates, 3 characters or fewer)   kept
//   anything else, text included    lorem of the same length
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type Operator = { phoneModel?: string; osVersion?: string; whatsappAppVersion?: string; countryCode?: string };
export type ScrubOptions = { checkId: string; date?: string; outRoot?: string; operator?: Operator };

export class LeakError extends Error {}

const FAKE_PN = (i: number) => `972500${String(i).padStart(6, '0')}`;
const FAKE_LID = (i: number) => `100000000${String(i).padStart(6, '0')}`;
const FAKE_GROUP = (i: number) => `120363${String(i).padStart(12, '0')}`;
/** Addresses WhatsApp itself uses, never a person's. */
const SERVICE_USERS = new Set(['0', '16505361212', '13135550002']);
/** The harness's instance name: a replay runs under it. */
const REPLAY_INSTANCE = 'test';

const JID = /^(\d+(?:-\d+)?)((?:[:_]\d+)*)@(s\.whatsapp\.net|c\.us|hosted|lid|hosted\.lid|g\.us|broadcast|newsletter)$/;
const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);
const LID_SERVERS = new Set(['lid', 'hosted.lid']);

const NAME_KEYS = new Set([
  'name', 'notify', 'verifiedName', 'verifiedBizName', 'pushName', 'username', 'subject', 'profileName',
  'fullName', 'firstName', 'shortName', 'displayName', 'vname',
]);
const TEXT_KEYS = new Set([
  'conversation', 'text', 'caption', 'desc', 'description', 'title', 'body', 'matchedText', 'canonicalUrl',
  'fileName', 'address', 'contentText', 'footerText', 'headerText', 'vcard', 'selectedDisplayText', 'optionName',
  'comment', 'message', 'msgCall',
]);
const ID_KEYS = new Set(['id', 'stanzaId', 'keyId', 'messageId', 'callId']);
const STRUCTURAL_KEYS = new Set([
  '$proto', '$redacted', 'as', 'event', 'type', 'messageType', 'mimetype', 'addressingMode', 'action', 'connection',
  'source', 'origin', 'state', 'status', 'platform', 'mediaType',
]);

const isEpoch = (digits: string) => /^1\d{9}$/.test(digits) || /^1\d{12}$/.test(digits);
const isStructural = (key: string, s: string) =>
  s.length <= 3 ||
  (STRUCTURAL_KEYS.has(key) && !/\s/.test(s) && s.length <= 64) ||
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s) || // enum names: SERVER_ACK
  /^[A-Z]{2,12}$/.test(s) || // single-word enums: READ, PLAYED
  /^[a-z][a-zA-Z0-9]*([._-][a-zA-Z0-9]+)*$/.test(s) || // identifiers: messages.upsert, imageMessage
  /^[a-z]+\/[\w.+-]+(;\s*[\w=.-]+)*$/.test(s) || // mimetypes
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(s); // ISO dates

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
  /** Raw strings the rewrite replaced, and raw strings it kept as structure. */
  readonly replaced = new Set<string>();
  readonly kept = new Set<string>();

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

  /** Step 2. */
  rewrite(value: any, key = ''): any {
    if (typeof value === 'string') return this.string(value, key);
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1e6) {
      const known = this.digits.get(String(value));
      return known ? Number(known) : value;
    }
    if (Array.isArray(value)) return value.map((v) => this.rewrite(v, key));
    if (!value || typeof value !== 'object') return value;
    if ('$bytes' in value) return { $bytes: this.fakeBytes(value.$bytes), as: value.as, fake: 1 };
    if ('$long' in value || '$date' in value || '$big' in value || '$u' in value || '$fn' in value) return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = JID.test(k) || /^\d{7,15}$/.test(k) ? this.string(k, '') : k;
      out[newKey] = this.rewrite(v, k);
    }
    return out;
  }

  private string(s: string, key: string): string {
    const out = this.stringOf(s, key);
    if (out === s) this.kept.add(s);
    else this.replaced.add(s);
    return out;
  }

  private stringOf(s: string, key: string): string {
    if (!s) return s;
    if (s === this.instanceName && (key === 'instance' || key === 'instanceName')) return REPLAY_INSTANCE;
    const jid = JID.exec(s);
    if (jid) return this.fakeJid(jid[1], jid[2], jid[3]);
    if (/^\+?\d{7,15}$/.test(s)) {
      const plus = s.startsWith('+') ? '+' : '';
      const digits = s.slice(plus.length);
      if (this.digits.has(digits)) return plus + this.digits.get(digits);
      if (isEpoch(digits)) return s;
      return plus + this.fakeUser(digits, 's.whatsapp.net');
    }
    if (NAME_KEYS.has(key)) return this.fakeName(s);
    if (TEXT_KEYS.has(key)) return this.lorem(s);
    if (this.bytes.has(s)) return this.bytes.get(s);
    if (s.length >= 8 && (ID_KEYS.has(key) || /^(?=.*\d)[0-9A-F]{12,64}$/.test(s))) return this.fakeId(s);
    if (/^https?:\/\//i.test(s)) return this.memo(this.urls, s, (n) => `https://example.invalid/${n}`);
    if (isStructural(key, s)) return s;
    return this.lorem(s);
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
    if (s === 'Você') return s;
    return this.memo(this.names, s, (n) => `Name ${n}`);
  }

  private fakeId(s: string) {
    return this.memo(this.ids, s, (n) => {
      const body = n.toString(16).toUpperCase().padStart(s.length - 2, 'F');
      const id = s.slice(0, 2) + body.slice(-(s.length - 2));
      return s === s.toLowerCase() ? id.toLowerCase() : id;
    });
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

  /** Every original the gate searches for: numbers, names, byte strings, and replaced strings of 4+ characters. */
  originals(): string[] {
    const all = new Set<string>();
    for (const d of this.digits.keys()) all.add(d);
    for (const n of this.names.keys()) if (n.length > 3 && n !== 'Você') all.add(n);
    for (const b of this.bytes.keys()) if (b.length > 3) all.add(b);
    for (const s of this.replaced) if (s.length > 3 && !this.kept.has(s)) all.add(s);
    return [...all];
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
    };
  }
}

const readLines = (file: string): Line[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const describeOriginal = (s: string) =>
  /^\d+$/.test(s) ? `a number of ${s.length} digits` : `a string of ${s.length} characters`;

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
  const hits: string[] = [];
  for (const original of scrubber.originals()) {
    const escaped = JSON.stringify(original).slice(1, -1);
    for (const [file, text] of Object.entries(files)) {
      const at = text.includes(original) ? text.indexOf(original) : text.indexOf(escaped);
      if (at >= 0) hits.push(`${file} line ${text.slice(0, at).split('\n').length}: ${describeOriginal(original)}`);
    }
  }
  if (hits.length) {
    throw new LeakError(`leak gate: ${hits.length} original(s) survived, nothing written:\n  ${hits.join('\n  ')}`);
  }

  const report = { leakGate: 'pass', events: events.length, webhooks: webhooks.length, ...scrubber.counts() };
  files['scrub-report.json'] = JSON.stringify(report, null, 2) + '\n';

  const dir = join(opts.outRoot ?? join(process.cwd(), 'test', 'fixtures', 'live'), `${date}-${opts.checkId}`);
  if (existsSync(dir)) throw new Error(`${dir} exists: remove it or pick another check id`);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return { dir, report };
}
