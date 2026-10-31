// libsignal (which Baileys encrypts with) prints whole SessionEntry objects
// with console.info and console.warn whenever a session closes, opens or is
// dropped: "Closing session:", "Removing old closed session:", "Session already
// closed". Node prints them in full, with the session's private ratchet key,
// root key, chain keys, base key and the contact's identity key as <Buffer ...>.
// LOG_LEVEL never sees them (they are not Evolution's logger), so on a busy
// account they reached stdout every few seconds and Fly's log store kept them.
//
// The sessions here are real: two libsignal parties, the way WhatsApp's
// contacts re-key in production. Alice starts a session from Bob's prekey
// bundle, then starts a new one from a fresh bundle (a reinstall, a re-link),
// and Bob, who still has the first session open, closes it in favour of the
// incoming prekey message.
import { format } from 'node:util';

import { quietSignalSessionLogs } from '@utils/quiet-signal-logs';
import { describe, expect, it } from 'vitest';

import { captureOutput } from '../helpers/capture-output';

const signal: any = await import('libsignal');
const { keyhelper, ProtocolAddress, SessionBuilder, SessionCipher } = signal;

function party() {
  const identity = keyhelper.generateIdentityKeyPair();
  const registrationId = keyhelper.generateRegistrationId();
  const signed = keyhelper.generateSignedPreKey(identity, 1);
  const preKeys = new Map<number, any>([1, 2].map((id) => [id, keyhelper.generatePreKey(id).keyPair]));
  const sessions = new Map<string, any>();
  const storage = {
    isTrustedIdentity: async () => true,
    getOurIdentity: async () => identity,
    getOurRegistrationId: async () => registrationId,
    loadSession: async (id: string) => sessions.get(id),
    storeSession: async (id: string, record: any) => void sessions.set(id, record),
    loadPreKey: async (id: number) => preKeys.get(id),
    removePreKey: async (id: number) => void preKeys.delete(id),
    loadSignedPreKey: async (id: number) => (id === 1 ? signed.keyPair : undefined),
  };
  const bundle = (preKeyId: number) => ({
    identityKey: identity.pubKey,
    registrationId,
    signedPreKey: { keyId: 1, publicKey: signed.keyPair.pubKey, signature: signed.signature },
    preKey: { keyId: preKeyId, publicKey: preKeys.get(preKeyId).pubKey },
  });
  return { identity, storage, sessions, bundle };
}

/** Every key byte both parties hold, as Node would print it in a dump. */
function keyDumps(...parties: ReturnType<typeof party>[]) {
  const found: string[] = [];
  const walk = (v: any) => {
    if (Buffer.isBuffer(v)) return void found.push(v.toString('hex'), v.toString('base64'));
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const p of parties) {
    walk(p.identity);
    for (const record of p.sessions.values()) walk(record.sessions);
  }
  return found;
}

/** Bob closes the session Alice abandoned, as WhatsApp contacts re-key. */
async function reKey() {
  const alice = party();
  const bob = party();
  const toBob = new ProtocolAddress('bob', 0);
  const toAlice = new ProtocolAddress('alice', 0);
  const exchange = async (preKeyId: number) => {
    await new SessionBuilder(alice.storage, toBob).initOutgoing(bob.bundle(preKeyId));
    const sent = await new SessionCipher(alice.storage, toBob).encrypt(Buffer.from('hi'));
    expect(sent.type).toBe(3);
    const got = await new SessionCipher(bob.storage, toAlice).decryptPreKeyWhisperMessage(
      Buffer.from(sent.body, 'binary'),
    );
    expect(Buffer.from(got).toString()).toBe('hi');
  };
  await exchange(1);
  await exchange(2);
  return { alice, bob };
}

/** What reKey prints under these log levels, formatted as Node prints it on stdout (util.format). */
async function printed(levels: string[], fn: () => Promise<any> = reKey) {
  let parties: any;
  const out = await captureOutput(async () => {
    for (const n of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const sink = console[n];
      console[n] = (...a: any[]) => sink(format(...a));
    }
    quietSignalSessionLogs(levels as any);
    parties = await fn();
  });
  return { out, parties };
}

describe('Signal session logs', () => {
  it('PROMISE: a session closing under LOG_LEVEL=ERROR,WARN prints no key, and no session dump', async () => {
    const { out, parties } = await printed(['ERROR', 'WARN']);

    for (const field of ['privKey', 'rootKey', 'baseKey', 'remoteIdentityKey', 'chainKey', '<Buffer', 'SessionEntry'])
      expect(out).not.toContain(field);
    for (const key of keyDumps(parties.alice, parties.bob)) expect(out).not.toContain(key);
    // INFO lines of libsignal follow LOG_LEVEL like Evolution's own.
    expect(out).not.toContain('Closing session');
  });

  it('PROMISE: the one-line warning that a contact re-keyed still prints', async () => {
    const { out } = await printed(['ERROR', 'WARN']);

    expect(out.split('\n').filter((l) => l === 'Closing open session in favor of incoming prekey bundle')).toHaveLength(
      1,
    );
  });

  it('PROMISE: with INFO on, a session change prints its line, never the session', async () => {
    const { out, parties } = await printed(['ERROR', 'WARN', 'INFO']);

    expect(out).toContain('Closing session: [signal session]');
    for (const field of ['privKey', 'rootKey', '<Buffer', 'SessionEntry']) expect(out).not.toContain(field);
    for (const key of keyDumps(parties.alice, parties.bob)) expect(out).not.toContain(key);
  });

  it("PROMISE: Evolution's own lines print as they were", async () => {
    const { out } = await printed(['ERROR', 'WARN'], async () => {
      console.log('[Evolution API]', 'WARN', { a: 1 });
      console.info('plain info');
    });

    expect(out).toBe('[Evolution API] WARN { a: 1 }\nplain info');
  });
});
