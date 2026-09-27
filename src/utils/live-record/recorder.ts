// Records a live check, and does nothing unless LIVE_RECORD_DIR is set.
//
// LIVE_RECORD_DIR/<instance>/<session start>/
//   events.ndjson    every Baileys event the socket emitted (the input tape), and
//                    every batch the event buffer handed Evolution
//   webhooks.ndjson  every payload Evolution sent out (the golden output tape)
//   manifest.json    versions and conditions, never a number, a JID, a name or content
//   owner.json       the linked account (raw only: the scrubber reads it, never copies it)
//
// One line per record, one sequence across both tapes, values in the tagged
// codec (codec.ts) so a replay rebuilds identical ones. Everything is written
// synchronously, at the moment it happens: Evolution mutates payloads later.
// The raw files hold personal data. They stay on the machine that recorded them
// until scripts/live-scrub.ts turns them into a fixture (docs/LIVE-CHECKS.md).
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { performance } from 'perf_hooks';

import { encode } from './codec';

export type LinkMethod = 'qr' | 'code' | 'existing-session';

/** What Evolution knows about a socket when it builds one. */
export type SocketFacts = {
  waWebVersion: string;
  linkMethod: LinkMethod;
  /** The proxy's protocol, or null for none. Never its host or credentials. */
  proxyProtocol: string | null;
  /** The auth creds, read when the connection opens (creds.platform is set at pairing). */
  creds: () => any;
};

export type Manifest = {
  format: 'live-record/1';
  forkCommit: string | null;
  baileysVersion: string | null;
  nodeVersion: string;
  waWebVersion: string | null;
  /** creds.platform as WhatsApp reported it at pairing (smba, smbi, android, iphone...), when known. */
  phonePlatform: string | null;
  /** From the platform: WhatsApp Business apps report smb*. Null when unknown. */
  accountType: 'business' | 'personal' | null;
  linkMethod: LinkMethod | null;
  proxy: { used: boolean; protocol: string | null };
  sockets: number;
  startedAt: string;
  openedAt: string | null;
  endedAt: string | null;
};

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_') || 'instance';

function forkCommit(env: NodeJS.ProcessEnv): string | null {
  const file = join(process.cwd(), 'FORK_SHA');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim() || null;
  try {
    return execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=8', '--match=NONE'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return env.FORK_SHA || null;
  }
}

function baileysVersion(): string | null {
  try {
    const path = createRequire(join(process.cwd(), 'package.json')).resolve('baileys/package.json');
    return JSON.parse(readFileSync(path, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const accountType = (platform?: string | null): Manifest['accountType'] => {
  if (!platform) return null;
  return /^smb/i.test(platform) ? 'business' : 'personal';
};

export class LiveRecorder {
  private seq = 0;
  private sockets = 0;
  private readonly t0 = performance.now();
  private appDepth = 0;
  private broken = false;
  private readonly manifest: Manifest;

  private constructor(readonly dir: string) {
    this.manifest = {
      format: 'live-record/1',
      forkCommit: forkCommit(process.env),
      baileysVersion: baileysVersion(),
      nodeVersion: process.version,
      waWebVersion: null,
      phonePlatform: null,
      accountType: null,
      linkMethod: null,
      proxy: { used: false, protocol: null },
      sockets: 0,
      startedAt: new Date().toISOString(),
      openedAt: null,
      endedAt: null,
    };
    this.writeManifest();
  }

  /** A recorder for this instance's session, or undefined when LIVE_RECORD_DIR is not set. */
  static start(instanceName: string, env: NodeJS.ProcessEnv = process.env): LiveRecorder | undefined {
    const root = env.LIVE_RECORD_DIR;
    if (!root) return undefined;
    const stamp = new Date().toISOString().replace(/:/g, '-');
    const dir = join(root, safeName(instanceName), stamp);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new LiveRecorder(dir);
  }

  /** Record every event this socket emits, and every batch its buffer delivers. Call before eventHandler(). */
  attach(client: any, facts: SocketFacts) {
    const socket = ++this.sockets;
    this.manifest.sockets = socket;
    this.manifest.waWebVersion = facts.waWebVersion;
    // The method that linked the account is the one asked for before the first open.
    if (!this.manifest.openedAt) this.manifest.linkMethod = facts.linkMethod;
    this.manifest.proxy = { used: !!facts.proxyProtocol, protocol: facts.proxyProtocol };
    this.writeManifest();

    const ev = client.ev;
    const emit = ev.emit.bind(ev);
    ev.emit = (event: string, data: any) => {
      this.guard(() => {
        const line: Record<string, any> = { seq: ++this.seq, t: this.elapsed(), socket, event };
        line.buffered = typeof ev.isBuffering === 'function' ? ev.isBuffering() : false;
        if (this.appDepth) line.origin = 'app';
        line.data = encode(redact(event, data));
        this.append('events.ndjson', line);
        if (event === 'connection.update') this.connectionUpdate(client, facts, data);
      });
      return emit(event, data);
    };
    ev.process((events: Record<string, any>) => {
      this.guard(() =>
        this.append('events.ndjson', { seq: ++this.seq, t: this.elapsed(), socket, batch: Object.keys(events) }),
      );
    });
  }

  /** Evolution emitting into the socket's events itself: marked, so a replay does not emit it twice. */
  fromApp<T>(fn: () => T): T {
    this.appDepth++;
    try {
      return fn();
    } finally {
      this.appDepth--;
    }
  }

  /** A payload Evolution sends out (sendDataWebhook), as it was at that moment. */
  webhook(event: string, data: any, extra?: Record<string, any>) {
    this.guard(() => {
      const line: Record<string, any> = { seq: ++this.seq, t: this.elapsed(), event, data: encode(data) };
      if (extra !== undefined) line.extra = encode(extra);
      this.append('webhooks.ndjson', line);
    });
  }

  private connectionUpdate(client: any, facts: SocketFacts, update: any) {
    if (update?.connection === 'open') {
      const platform = facts.creds()?.platform ?? null;
      this.manifest.phonePlatform = platform;
      this.manifest.accountType = accountType(platform);
      this.manifest.openedAt ??= new Date().toISOString();
      this.manifest.endedAt = null;
      const user = client.user ?? {};
      writeFileSync(join(this.dir, 'owner.json'), JSON.stringify({ id: user.id, lid: user.lid, name: user.name }));
      this.writeManifest();
    }
    if (update?.connection === 'close') {
      this.manifest.endedAt = new Date().toISOString();
      this.writeManifest();
    }
  }

  private elapsed() {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  private append(file: string, line: object) {
    appendFileSync(join(this.dir, file), JSON.stringify(line) + '\n', { mode: 0o600 });
  }

  private writeManifest() {
    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify(this.manifest, null, 2) + '\n', { mode: 0o600 });
  }

  /** A recorder that fails stops recording; it never breaks the socket or the webhook it was watching. */
  private guard(fn: () => void) {
    if (this.broken) return;
    try {
      fn();
    } catch (error) {
      this.broken = true;
      console.warn(`[live-record] recording stopped: ${error?.message ?? error}`);
    }
  }
}

/** Secrets with no replay value never reach the tape: the auth creds and the QR payload. */
function redact(event: string, data: any) {
  if (event === 'creds.update') return { $redacted: 'creds', keys: Object.keys(data ?? {}) };
  if (event === 'connection.update' && data?.qr) return { ...data, qr: '$qr' };
  return data;
}
