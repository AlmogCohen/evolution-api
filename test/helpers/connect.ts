// Run Evolution's real connect (connectToWhatsapp -> createClient) with the
// socket factory replaced, so a test can read the socket config Evolution
// builds without opening a WebSocket. The test file mocks `baileys` so that
// makeWASocket is `socketSpy`, which returns fakeSocket().
import { EventEmitter } from 'node:events';

import { initAuthCreds, makeEventBuffer } from 'baileys';
import P from 'pino';

import { makeService } from './baileys-service';

export function fakeSocket() {
  return {
    ev: makeEventBuffer(P({ level: 'silent' }) as any),
    ws: new EventEmitter(),
    end: () => undefined,
  };
}

/** The auth state is files on disk under the instances directory; nothing about it touches the network. */
export function stubAuthState(service: any) {
  service.defineAuthState = async () => ({
    state: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => undefined } },
    saveCreds: async () => undefined,
    removeCreds: async () => undefined,
  });
}

export type ProxyProtocol = 'http' | 'socks5';

/** Set the proxy the way /proxy/set does, then connect the way Evolution does. Returns the socket config. */
export async function connectBehind(socketSpy: { mock: { calls: any[][] } }, proxy?: { protocol: ProxyProtocol; port: number }) {
  const { service } = await makeService();
  if (proxy) {
    await service.setProxy({
      enabled: true,
      host: '127.0.0.1',
      port: String(proxy.port),
      protocol: proxy.protocol,
      username: '',
      password: '',
    });
  }
  stubAuthState(service);
  const before = socketSpy.mock.calls.length;
  await service.connectToWhatsapp();
  const config = socketSpy.mock.calls[before]?.[0];
  if (!config) throw new Error('connectToWhatsapp did not create a socket');
  return { service, config };
}
