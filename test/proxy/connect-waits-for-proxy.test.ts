// connectToWhatsapp loads the instance's proxy from the database and then
// builds the socket. If the socket is built before the Proxy row has been read,
// the whole account connects from the server's own IP. A real database round
// trip takes time, so the fake one here does too.
//
// Every way an instance connects goes through connectToWhatsapp: the boot
// auto-connect (monitor), /instance/create, /instance/connect, /instance/restart
// and the reconnect after a closed connection. The first connect of a fresh
// service is the boot; the second connect of the same service is a restart or
// a reconnect, where the proxy is already loaded and must stay in force.
import { vi } from 'vitest';

const { socketSpy } = vi.hoisted(() => ({ socketSpy: vi.fn() }));

vi.mock('@api/server.module', () => import('../helpers/fake-server-module'));
vi.mock('baileys', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return { ...orig, default: socketSpy, makeWASocket: socketSpy };
});

import https from 'node:https';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { fakeSocket, stubAuthState } from '../helpers/connect';
import {
  type Listening,
  loopbackOnly,
  startHttpProxy,
  startHttpsServer,
  trustTestCertificate,
} from '../helpers/local-net';

socketSpy.mockImplementation(fakeSocket);

const PROXY_READ_MS = 50;

let guard: ReturnType<typeof loopbackOnly>;
let untrust: () => void;
let web: Listening;
let proxy: Listening;

beforeAll(async () => {
  guard = loopbackOnly();
  untrust = trustTestCertificate();
  web = await startHttpsServer((req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end('self.__swData=JSON.parse("{\\"client_revision\\":1027654321}");');
  });
  proxy = await startHttpProxy({ remap: { 'web.whatsapp.com:443': `127.0.0.1:${web.port}` } });
});

afterAll(async () => {
  await proxy.close();
  await web.close();
  untrust();
  guard.restore();
});

beforeEach(() => {
  guard.refused.splice(0);
  proxy.log.splice(0);
});

/** A service as the monitor builds it on boot: the Proxy row is in the database, nothing is in memory yet. */
async function bootedService() {
  const { service, prisma } = await makeService();
  await prisma.proxy.create({
    data: {
      instanceId: 'inst-1',
      enabled: true,
      host: '127.0.0.1',
      port: String(proxy.port),
      protocol: 'http',
      username: '',
      password: '',
    },
  });
  const read = prisma.proxy.findUnique;
  prisma.proxy.findUnique = async (args: any) => {
    await new Promise((r) => setTimeout(r, PROXY_READ_MS));
    return read(args);
  };
  stubAuthState(service);
  return service;
}

/** Connect, and return what the socket would do with the config Evolution gave it. */
async function connect(service: any) {
  const before = socketSpy.mock.calls.length;
  await service.connectToWhatsapp();
  const config = socketSpy.mock.calls[before][0];
  // The WebSocket opens its connection with config.agent (Baileys passes it to ws); open one the same way.
  const probe = await new Promise<string>((resolve, reject) =>
    https
      .get('https://web.whatsapp.com/sw.js', { agent: config.agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(`${res.statusCode}`));
      })
      .on('error', reject),
  ).catch((e) => `error: ${e.message}`);
  return { config, probe };
}

describe('a connect never starts before the instance proxy is loaded', () => {
  it('on boot: the socket and the version fetch leave through the proxy', async () => {
    const service = await bootedService();
    const { config, probe } = await connect(service);
    expect(guard.refused).toEqual([]);
    expect(proxy.log).toEqual(['CONNECT web.whatsapp.com:443', 'CONNECT web.whatsapp.com:443']);
    expect(probe).toBe('200');
    expect(config.version).toEqual([2, 3000, 1027654321]);
  });

  it('on a restart or reconnect of a connected instance: still through the proxy', async () => {
    const service = await bootedService();
    await connect(service);
    guard.refused.splice(0);
    proxy.log.splice(0);
    const { probe } = await connect(service);
    expect(guard.refused).toEqual([]);
    expect(proxy.log).toEqual(['CONNECT web.whatsapp.com:443', 'CONNECT web.whatsapp.com:443']);
    expect(probe).toBe('200');
  });
});
