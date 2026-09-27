// The Prisma auth store (creds in the session table) is opened
// on every connect and reconnect. It used to turn a failed session read into
// "no session": keyExists and getAuthKey swallowed the error and returned
// false/null, so the store started a fresh, unlinked session (initAuthCreds)
// and wrote it over the linked one as soon as the database answered again. A
// database blip during a reconnect therefore unlinked the account for good.
//
// A failed read must fail the open (so the connect fails and can be retried)
// and must leave the stored creds exactly as they were. A session that is
// genuinely absent still starts fresh: that is how a new instance links.
import { rmSync } from 'node:fs';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prismaRepository } from '../helpers/fake-server-module';

// Creds live in the fake Prisma's session table; with Redis off, keys go to files
// under INSTANCE_DIR (a temp dir here, not the repo).
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'evo-auth-dberr-'));
});
vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('@config/path.config', async (importOriginal) => ({ ...(await importOriginal<object>()), INSTANCE_DIR: tmp }));

const SESSION = 'linked-session';
const ME = { id: '972500000000:7@s.whatsapp.net', name: 'Linked account' };

const open = async (sessionId = SESSION) => {
  const { default: useMultiFileAuthStatePrisma } = await import('@utils/use-multi-file-auth-state-prisma');
  return useMultiFileAuthStatePrisma(sessionId, null as any);
};

const storedRow = (sessionId = SESSION) => prismaRepository.session.rows.find((r: any) => r.sessionId === sessionId);

/** Make the session table's next read fail the way a dropped connection does; later reads succeed. */
function failNextSessionRead() {
  const read = prismaRepository.session.findUnique;
  let failed = false;
  prismaRepository.session.findUnique = async (args: any) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("Can't reach database server at `127.0.0.1:5432`"), { code: 'P1001' });
    }
    return read(args);
  };
  return () => void (prismaRepository.session.findUnique = read);
}

beforeEach(() => void prismaRepository.session.rows.splice(0));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the prisma auth store on a database error', () => {
  it('a failed session read fails the open and never replaces a linked session', async () => {
    // A linked session: creds that carry the account (`me`) and are registered.
    const linked = await open();
    Object.assign(linked.state.creds, { me: ME, registered: true });
    await linked.saveCreds();
    const before = storedRow()!.creds;

    const restore = failNextSessionRead();
    let outcome: { opened: boolean; error?: string; me?: unknown };
    try {
      outcome = await open().then(
        (s) => ({ opened: true, me: s.state.creds.me ?? null }),
        (e) => ({ opened: false, error: e?.message }),
      );
    } finally {
      restore();
    }
    // Give any write the store left behind time to land once the database answers again.
    await new Promise((r) => setTimeout(r, 10));

    // The open failed, and nothing was written over the linked creds.
    expect({
      ...outcome,
      rows: prismaRepository.session.rows.filter((r: any) => r.sessionId === SESSION).length,
      credsUnchanged: storedRow()?.creds === before,
    }).toEqual({ opened: false, error: "Can't reach database server at `127.0.0.1:5432`", rows: 1, credsUnchanged: true });

    // The retried connect opens the linked session.
    const retried = await open();
    expect(retried.state.creds.me).toEqual(ME);
    expect(retried.state.creds.registered).toBe(true);
    expect(retried.state.creds.noiseKey).toEqual(linked.state.creds.noiseKey);
  });

  it('a session that is genuinely absent still starts fresh and is stored (control)', async () => {
    const fresh = await open('new-session');
    expect(fresh.state.creds.me).toBeUndefined();
    expect(fresh.state.creds.registered).toBe(false);
    expect(storedRow('new-session')).toBeDefined();
  });
});
