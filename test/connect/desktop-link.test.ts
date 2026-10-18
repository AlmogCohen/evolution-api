// What a new link tells WhatsApp it is.
//
// The phone decides how much history to send a newly linked device from what
// that device says it is (Baileys README, "Receive Full History": emulate a
// desktop with Browsers.macOS('Desktop') and syncFullHistory to receive more).
// Circles linked as "Chrome" and was sent one year (2026-10-18, both accounts
// cut at mid-October 2025). CONFIG_SESSION_PHONE_CLIENT / _NAME say what a link
// presents as.
//
// Evolution applied them only to a QR link: a link by phone number (pairing
// code) took Baileys' default, Browsers.macOS('Chrome'), whatever was
// configured. Code linking is the way people link, so the setting has to
// reach it.
//
// And it must not move a session already linked. What a reconnect sends
// (generateLoginNode) depends on the browser too: 'Mac OS' + 'Desktop' logs in
// as webSubPlatform DARWIN, anything else as WEB_BROWSER. So a session keeps
// presenting as what it linked as, remembered on its creds; one linked before
// this (no record) keeps the login it always had.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});
vi.mock('@utils/fetchLatestWaWebVersion', () => ({
  fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
}));

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Browsers, generateLoginNode, generateRegistrationNode, getPlatformId, initAuthCreds, proto } from 'baileys';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket } from '../helpers/connect';
import { loopbackOnly } from '../helpers/local-net';

socketSpy.mockImplementation(() => ({ ...fakeSocket(), requestPairingCode: vi.fn(async () => 'CODE0001') }));

let guard: ReturnType<typeof loopbackOnly>;
beforeAll(() => void (guard = loopbackOnly()));
afterAll(() => {
  expect(guard.refused).toEqual([]);
  guard.restore();
});

const saved = { client: process.env.CONFIG_SESSION_PHONE_CLIENT, name: process.env.CONFIG_SESSION_PHONE_NAME };
afterEach(() => {
  process.env.CONFIG_SESSION_PHONE_CLIENT = saved.client;
  process.env.CONFIG_SESSION_PHONE_NAME = saved.name;
});

const LOGIN_CONFIG = { version: [2, 3000, 1], syncFullHistory: true, countryCode: 'IL' };
const login = (browser: string[]) =>
  Buffer.from(
    proto.ClientPayload.encode(generateLoginNode('972500000000:3@s.whatsapp.net', { browser, ...LOGIN_CONFIG } as any)).finish(),
  ).toString('hex');

/** Connect with the setting Circles deploys, on the creds given; returns the browser handed to Baileys and the creds. */
async function connectWith(opts: { number?: string; creds?: any } = {}) {
  process.env.CONFIG_SESSION_PHONE_CLIENT = 'Mac OS';
  process.env.CONFIG_SESSION_PHONE_NAME = 'Desktop';
  const { service } = await makeService();
  const creds = opts.creds ?? initAuthCreds();
  service.defineAuthState = async () => ({
    state: { creds, keys: { get: async () => ({}), set: async () => undefined } },
    saveCreds: async () => undefined,
    removeCreds: async () => undefined,
  });
  const before = socketSpy.mock.calls.length;
  await service.connectToWhatsapp(opts.number);
  return { browser: socketSpy.mock.calls[before][0].browser as string[] | undefined, creds };
}
const browserOfLink = async (number?: string) => (await connectWith({ number })).browser;
const linked = (extra: Record<string, unknown> = {}) => ({ ...initAuthCreds(), me: { id: '972500000000:3@s.whatsapp.net' }, ...extra });

describe('what a new link presents as', () => {
  it('PROMISE: a QR link presents as the configured desktop', async () => {
    const browser = await browserOfLink();
    expect(browser?.slice(0, 2)).toEqual(['Mac OS', 'Desktop']);
  });

  it('PROMISE: a link by phone number (pairing code) presents as the configured desktop too', async () => {
    const browser = await browserOfLink('972500000009');
    expect(browser?.slice(0, 2)).toEqual(['Mac OS', 'Desktop']);
  });

  it('a desktop registers with WhatsApp as DESKTOP, asking for full history', () => {
    const config = { browser: Browsers.macOS('Desktop'), version: [2, 3000, 1], syncFullHistory: true } as any;
    const creds = initAuthCreds();
    const node = generateRegistrationNode(creds, config);
    const payload = proto.ClientPayload.decode(proto.ClientPayload.encode(node).finish());
    const props = proto.DeviceProps.decode(payload.devicePairingData!.deviceProps!);
    expect(props.platformType).toBe(proto.DeviceProps.PlatformType.DESKTOP);
    expect(props.requireFullSync).toBe(true);
    // The pairing code's companion_platform_id, from the same setting.
    expect(getPlatformId('Desktop')).toBe(String(proto.DeviceProps.PlatformType.DESKTOP));
  });
});

describe('a session already linked', () => {
  it('the browser changes the login: a desktop logs in as DARWIN, a browser as WEB_BROWSER', () => {
    expect(login(['Mac OS', 'Desktop', '6.1.0'])).not.toBe(login(['Evolution API', 'Chrome', '6.1.0']));
  });

  it('PROMISE: a session linked before this keeps exactly the login it always had', async () => {
    const { browser } = await connectWith({ creds: linked() });
    // Both ways it could have linked: a QR link (the configured 'Evolution API'/'Chrome'),
    // and a pairing-code link (Baileys' default, Browsers.macOS('Chrome')).
    expect(login(browser!)).toBe(login(['Evolution API', 'Chrome', '6.1.0']));
    expect(login(browser!)).toBe(login(Browsers.macOS('Chrome') as string[]));
  });

  it('PROMISE: a new link remembers what it linked as, and reconnects as that', async () => {
    const first = await connectWith({ number: '972500000009' });
    expect(first.browser?.slice(0, 2)).toEqual(['Mac OS', 'Desktop']);
    // WhatsApp accepted the link: the creds now name the account.
    first.creds.me = { id: '972500000009:5@s.whatsapp.net' };
    // A later deploy configures something else; this session still logs in as it linked.
    process.env.CONFIG_SESSION_PHONE_CLIENT = 'Evolution API';
    process.env.CONFIG_SESSION_PHONE_NAME = 'Chrome';
    const { service } = await makeService();
    service.defineAuthState = async () => ({
      state: { creds: first.creds, keys: { get: async () => ({}), set: async () => undefined } },
      saveCreds: async () => undefined,
      removeCreds: async () => undefined,
    });
    const before = socketSpy.mock.calls.length;
    await service.connectToWhatsapp();
    const again = socketSpy.mock.calls[before][0].browser;
    expect(login(again)).toBe(login(['Mac OS', 'Desktop', '6.1.0']));
  });

  it('the record survives being saved: it is plain JSON on the creds', async () => {
    const { creds } = await connectWith();
    const { BufferJSON } = await import('baileys');
    const back = JSON.parse(JSON.stringify(creds, BufferJSON.replacer), BufferJSON.reviver);
    expect(back.linkedAs).toEqual(creds.linkedAs);
    expect(back.linkedAs.slice(0, 2)).toEqual(['Mac OS', 'Desktop']);
  });
});
