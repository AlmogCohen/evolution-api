// A local "WhatsApp" for the pairing stage, and the phone on the other side of it.
//
// The companion is the real Baileys socket, pointed at a WebSocket server on
// 127.0.0.1 that accepts the upgrade and never answers the Noise handshake.
// Until that handshake finishes Baileys writes its frames unencrypted, so the
// server reads every stanza the companion sends (`sent`). What WhatsApp sends
// is handed to the socket with `deliver()`, the dispatch Baileys' own
// onMessageReceived performs once a frame is decrypted (rc14 lib/Socket/socket.js):
// the one step skipped is the decryption itself, which needs WhatsApp's
// certificate. Stanzas are written by hand: Baileys has no builder for the
// server's side.
//
// The phone's side (`scanQr`, `startCodeLink`) uses the same primitives Baileys
// verifies with, so a pair-success is accepted only when it was built on the
// adv secret the companion holds.
import { randomBytes } from 'node:crypto';
import net from 'node:net';

import {
  aesDecryptCTR,
  aesDecryptGCM,
  aesEncryptCTR,
  type BinaryNode,
  Curve,
  DEF_CALLBACK_PREFIX,
  DEF_TAG_PREFIX,
  decodeBinaryNode,
  derivePairingCodeKey,
  getBinaryNodeChild,
  getBinaryNodeChildBuffer,
  hkdf,
  hmacSign,
  proto,
  S_WHATSAPP_NET,
  WA_ADV_ACCOUNT_SIG_PREFIX,
} from 'baileys';
import { WebSocketServer } from 'ws';

export async function startFakeWhatsapp() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', () => r()));
  /** Every stanza a companion wrote, decoded, in order. The ClientHello (not a stanza) is left out. */
  const sent: BinaryNode[] = [];
  server.on('connection', (ws) => {
    let first = true;
    ws.on('message', async (data: Buffer) => {
      // The first frame is the intro header and the ClientHello; each later one is a 3-byte length and a stanza.
      if (first) return void (first = false);
      sent.push(await decodeBinaryNode(data.subarray(3)));
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/ws/chat`,
    sent,
    close: () => new Promise<void>((r) => (server.clients.forEach((c) => c.terminate()), server.close(() => r()))),
  };
}

/**
 * Hand a stanza from WhatsApp to the socket, as Baileys' onMessageReceived dispatches a decrypted frame.
 * Its raw 'frame' event is left out: only the handshake listens to it (awaitNextMessage), and this
 * socket's handshake is still waiting for a server hello that never comes.
 */
export function deliver(sock: any, frame: BinaryNode) {
  const ws = sock.ws;
  ws.emit(`${DEF_TAG_PREFIX}${frame.attrs.id}`, frame);
  const l0 = frame.tag;
  const l1 = frame.attrs || {};
  const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : '';
  for (const key of Object.keys(l1)) {
    ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame);
    ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame);
    ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame);
  }
  ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame);
  ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame);
}

let seq = 1000;
const stanzaId = () => String(++seq);
const now = () => String(Math.floor(Date.now() / 1000));

/** WhatsApp's pair-device IQ: the refs a QR may advertise, one after another. */
export const pairDevice = (refs: string[]): BinaryNode => ({
  tag: 'iq',
  attrs: { from: S_WHATSAPP_NET, type: 'set', id: stanzaId(), xmlns: 'md' },
  content: [{ tag: 'pair-device', attrs: {}, content: refs.map((ref) => ({ tag: 'ref', attrs: {}, content: Buffer.from(ref) })) }],
});

/** The notification WhatsApp sends during pairing since 2026-07-28, as captured in Baileys #2737. */
export const companionRegRefresh = (): BinaryNode => ({
  tag: 'notification',
  attrs: { from: S_WHATSAPP_NET, type: 'companion_reg_refresh', id: stanzaId(), t: now() },
  content: [{ tag: 'companion_reg_refresh', attrs: {} }],
});

/** A link_code_companion_reg notification with no pairing data, as captured in Baileys #2600. */
export const bareLinkCodeNotification = (): BinaryNode => ({
  tag: 'notification',
  attrs: { from: S_WHATSAPP_NET, type: 'link_code_companion_reg', id: stanzaId(), t: now() },
});

/** WhatsApp's answer to an IQ the companion sent. */
export const iqResult = (id: string, content?: BinaryNode[]): BinaryNode => ({
  tag: 'iq',
  attrs: { from: S_WHATSAPP_NET, type: 'result', id },
  ...(content ? { content } : {}),
});

/** The ack Baileys owes for a stanza, as WA Web builds it. */
export const ackFor = (node: BinaryNode) => ({
  tag: 'ack',
  attrs: { id: node.attrs.id, to: node.attrs.from, class: node.tag, type: node.attrs.type },
});

/** The fields of a pairing QR: https://wa.me/settings/linked_devices#ref,noise,identity,adv,platform */
export function qrFields(code: string) {
  const [ref, noise, identity, adv, platform] = code.slice(code.indexOf('#') + 1).split(',');
  return { ref, noise, identity, adv, platform };
}

/**
 * The pair-success the primary sends once it has verified the link: the account
 * signs the new device's identity, and the whole is authenticated with the adv
 * secret, which only the two sides of the link know.
 */
function pairSuccess(opts: { advSecret: string; companionIdentity: Buffer; account: { public: Buffer; private: Buffer } }) {
  const device = { jid: '972500000000:7@s.whatsapp.net', lid: '999999999999999:7@lid' };
  const deviceDetails = Buffer.from(
    proto.ADVDeviceIdentity.encode({ rawId: 7, timestamp: Math.floor(Date.now() / 1000), keyIndex: 3 }).finish(),
  );
  const accountSignature = Curve.sign(
    opts.account.private,
    Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, opts.companionIdentity]),
  );
  const details = Buffer.from(
    proto.ADVSignedDeviceIdentity.encode({
      details: deviceDetails,
      accountSignatureKey: opts.account.public,
      accountSignature,
    }).finish(),
  );
  const hmac = hmacSign(details, Buffer.from(opts.advSecret, 'base64'));
  const node: BinaryNode = {
    tag: 'iq',
    attrs: { from: S_WHATSAPP_NET, type: 'set', id: stanzaId(), xmlns: 'md' },
    content: [
      {
        tag: 'pair-success',
        attrs: {},
        content: [
          {
            tag: 'device-identity',
            attrs: {},
            content: Buffer.from(proto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish()),
          },
          { tag: 'platform', attrs: { name: 'android' } },
          { tag: 'device', attrs: device },
        ],
      },
    ],
  };
  return { node, device };
}

/**
 * The phone scans a QR. WhatsApp has retired every adv secret in `retired`
 * (the ones a companion_reg_refresh asked the companion to drop): a QR that
 * advertises one of them fails on the phone ("Couldn't link device"), and no
 * pair-success is ever sent.
 */
export function scanQr(code: string, retired: string[]) {
  const qr = qrFields(code);
  if (retired.includes(qr.adv)) throw new Error("phone: Couldn't link device (the QR advertises a retired adv secret)");
  return pairSuccess({
    advSecret: qr.adv,
    companionIdentity: Buffer.from(qr.identity, 'base64'),
    account: Curve.generateKeyPair(),
  });
}

/**
 * The phone's half of linking with a code (WA Web's alt device linking): the
 * person types `code`; the primary answers the companion_hello with a
 * primary_hello; after the companion's companion_finish both sides derive the
 * same adv secret, and the pair-success is authenticated with it.
 */
export async function startCodeLink(companionHello: BinaryNode, code: string, ref: Buffer) {
  const reg = getBinaryNodeChild(companionHello, 'link_code_companion_reg')!;
  const wrapped = getBinaryNodeChildBuffer(reg, 'link_code_pairing_wrapped_companion_ephemeral_pub')!;
  const companionEphemeral = aesDecryptCTR(
    wrapped.subarray(48, 80),
    await derivePairingCodeKey(code, wrapped.subarray(0, 32)),
    wrapped.subarray(32, 48),
  );
  const ephemeral = Curve.generateKeyPair();
  const identity = Curve.generateKeyPair();
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const wrappedPrimary = Buffer.concat([salt, iv, aesEncryptCTR(ephemeral.public, await derivePairingCodeKey(code, salt), iv)]);
  const primaryHello: BinaryNode = {
    tag: 'notification',
    attrs: { from: S_WHATSAPP_NET, type: 'link_code_companion_reg', id: stanzaId(), t: now() },
    content: [
      {
        tag: 'link_code_companion_reg',
        attrs: { stage: 'primary_hello' },
        content: [
          { tag: 'link_code_pairing_ref', attrs: {}, content: ref },
          { tag: 'primary_identity_pub', attrs: {}, content: identity.public },
          { tag: 'link_code_pairing_wrapped_primary_ephemeral_pub', attrs: {}, content: wrappedPrimary },
        ],
      },
    ],
  };
  /** Read the companion_finish, derive the adv secret as the companion did, and answer with a pair-success. */
  const finish = (companionFinish: BinaryNode) => {
    const reg = getBinaryNodeChild(companionFinish, 'link_code_companion_reg')!;
    const bundle = getBinaryNodeChildBuffer(reg, 'link_code_pairing_wrapped_key_bundle')!;
    const companionShared = Curve.sharedKey(ephemeral.private, companionEphemeral);
    const key = hkdf(companionShared, 32, {
      salt: bundle.subarray(0, 32),
      info: 'link_code_pairing_key_bundle_encryption_key',
    });
    const plain = aesDecryptGCM(bundle.subarray(44), Buffer.from(key), bundle.subarray(32, 44), Buffer.alloc(0));
    const companionIdentity = plain.subarray(0, 32);
    const random = plain.subarray(64, 96);
    const identityShared = Curve.sharedKey(identity.private, companionIdentity);
    const advSecret = Buffer.from(
      hkdf(Buffer.concat([companionShared, identityShared, random]), 32, { info: 'adv_secret' }),
    ).toString('base64');
    return { advSecret, ...pairSuccess({ advSecret, companionIdentity, account: identity }) };
  };
  return { primaryHello, finish };
}
