// Run Evolution's real connect (connectToWhatsapp -> createClient) with the
// socket factory replaced, so a test can read the socket config Evolution
// builds without opening a WebSocket. The test file mocks `baileys` so that
// makeWASocket is `socketSpy`, which returns fakeSocket().
import { EventEmitter } from 'node:events';

import { initAuthCreds, makeEventBuffer } from 'baileys';
import P from 'pino';

import { makeService } from './baileys-service';

export function fakeSocket() {
  const ev = makeEventBuffer(P({ level: 'silent' }) as any);
  // ev.process subscriptions still attached: a socket Evolution has let go of should have none.
  let handlers = 0;
  const process = ev.process.bind(ev);
  ev.process = (handler: any) => {
    const off = process(handler);
    handlers++;
    let attached = true;
    return () => {
      if (attached) handlers--;
      attached = false;
      off();
    };
  };
  let closed = false;
  ev.on('connection.update', (update: any) => {
    if (update.connection === 'close') closed = true;
  });
  const sock = {
    ev,
    ws: Object.assign(new EventEmitter(), { close: () => undefined }),
    // connectionUpdate reads the account on 'open', and logoutInstance logs the socket out.
    user: { id: '972500000000:1@s.whatsapp.net' },
    profilePictureUrl: async () => undefined,
    logout: async () => undefined,
    /** Whether Evolution called end() on this socket. */
    ended: false,
    handlers: () => handlers,
    // As Baileys' end() (Socket/socket.js): once only, and it announces the close on the socket's own events.
    end: (error?: Error) => {
      sock.ended = true;
      if (closed) return;
      closed = true;
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
    },
  };
  return sock;
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
