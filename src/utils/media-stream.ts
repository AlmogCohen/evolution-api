// A media download as a stream, for POST /chat/streamMediaMessage.
//
// Baileys' own stream (downloadMediaMessage(message, 'stream')) cannot be handed
// on: downloadEncryptedContent joins the CDN's body to its decryption with
// `.pipe()`, which does not forward errors, so a download that breaks off midway
// leaves the decrypted stream waiting for good and the CDN's error unhandled
// (7.0.0-rc14, lib/Utils/messages-media.js). This is the same download, the
// whole file only (no byte ranges), joined with pipeline(), and it checks the
// MAC WhatsApp appends, so a stream ends only when the file is whole.
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { pipeline, Readable, Transform } from 'node:stream';

import { Boom } from '@hapi/boom';
import {
  DEFAULT_ORIGIN,
  extractMessageContent,
  getContentType,
  getHttpStream,
  getMediaKeys,
  getUrlFromDirectPath,
  type WAMessage,
} from 'baileys';

const AES_BLOCK = 16;
const MAC_LENGTH = 10;

const hostOf = (url?: string | null) => {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Decrypts WhatsApp's media encryption (AES-256-CBC, then the first 10 bytes of
 * HMAC-SHA256 over the IV and the ciphertext) as the bytes arrive, holding back
 * only what cannot be decrypted yet. Fails at the end when the MAC does not
 * match, which is also what a file cut short at a block boundary looks like.
 */
function decryptMedia(keys: { iv: Uint8Array; cipherKey: Uint8Array; macKey?: Uint8Array }) {
  const decipher = createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  if (!keys.macKey) throw new Error('no MAC key for this media');
  const hmac = createHmac('sha256', keys.macKey).update(keys.iv);
  let held: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        held = held.length ? Buffer.concat([held, chunk]) : chunk;
        // The last MAC_LENGTH bytes may be the MAC: never decrypted until more arrive.
        const ready = Math.floor(Math.max(held.length - MAC_LENGTH, 0) / AES_BLOCK) * AES_BLOCK;
        const cipher = held.subarray(0, ready);
        held = held.subarray(ready);
        hmac.update(cipher);
        callback(null, decipher.update(cipher));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (held.length < MAC_LENGTH || (held.length - MAC_LENGTH) % AES_BLOCK !== 0) {
          throw new Error('the media ended before its last block');
        }
        const cipher = held.subarray(0, held.length - MAC_LENGTH);
        const mac = held.subarray(held.length - MAC_LENGTH);
        hmac.update(cipher);
        if (!timingSafeEqual(hmac.digest().subarray(0, MAC_LENGTH), mac)) {
          throw new Error('the media did not match its MAC');
        }
        callback(null, Buffer.concat([decipher.update(cipher), decipher.final()]));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/**
 * The file a media message holds, decrypted as it arrives. Resolves once the CDN
 * has answered, so its refusal (a Boom with the status and the link, as Baileys
 * throws it) is thrown here, before any byte; an error after that ends the
 * stream with it.
 */
export async function streamMediaDownload(
  message: WAMessage,
  options: { options?: RequestInit } = {},
): Promise<Readable> {
  const content = extractMessageContent(message.message);
  if (!content) throw new Boom('No message present', { statusCode: 400 });
  const contentType = getContentType(content);
  const media = content[contentType] as { url?: string; directPath?: string; mediaKey?: Uint8Array } | undefined;
  if (!media || typeof media !== 'object' || !('url' in media)) {
    throw new Boom(`"${contentType}" message is not a media message`);
  }
  // As Baileys' downloadContentFromMessage picks it.
  const url = media.directPath ? getUrlFromDirectPath(media.directPath, hostOf(media.url)) : media.url;
  if (!url) throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 });
  const keys = await getMediaKeys(media.mediaKey, contentType.replace('Message', '') as any);
  const fetched = await getHttpStream(url, { ...(options.options ?? {}), headers: { Origin: DEFAULT_ORIGIN } } as any);
  return pipeline(fetched, decryptMedia(keys), () => {
    // The error, if any, ends the returned stream; whoever reads it decides what it means.
  });
}
