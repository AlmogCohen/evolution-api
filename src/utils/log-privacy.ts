import P from 'pino';

// What a log line may say about a message: its id, what kind of chat it is
// in, why something failed, and counts. Never its text, a phone number or JID,
// or a push name.

/** The kind of chat a JID names, without the number in it. */
export function jidKind(jid: unknown): string {
  if (typeof jid !== 'string' || !jid) return 'unknown';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) return 'lid';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@hosted')) return 'user';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  return 'other';
}

/**
 * Mask anything in a diagnostic string that looks like a URL, a JID or a phone
 * number. A URL goes first, and whole: a WhatsApp media link is signed per
 * message (`oh`, `oe` in its query), and whoever holds it can fetch the file.
 */
export function scrub(value: unknown): string {
  return String(value ?? '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[url]')
    .replace(/[^\s'"<>=,;:()[\]{}]+@[^\s'"<>=,;:()[\]{}]+/g, '[jid]')
    .replace(/\d{6,}/g, '[number]');
}

const PRIMITIVE_FIELDS = ['messageType', 'isSessionRecordError', 'opName', 'count', 'attempt', 'retryCount'];
const ERROR_FIELDS = ['err', 'error', 'ackErr'];

/**
 * The fields of a Baileys log object that are safe to print. Baileys logs
 * message keys, sender and author JIDs and whole stanzas (from, notify, body)
 * at level error, e.g. "failed to decrypt message" and "error in handling
 * message", so everything else is dropped.
 */
export function safeLogFields(obj: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof obj?.key?.id === 'string') out.messageId = obj.key.id;
  const chat = obj?.key?.remoteJid ?? obj?.jid ?? obj?.sender;
  if (chat) out.chatType = jidKind(chat);
  for (const field of PRIMITIVE_FIELDS) {
    const v = obj?.[field];
    if (typeof v === 'number' || typeof v === 'boolean') out[field] = v;
    else if (typeof v === 'string') out[field] = scrub(v).slice(0, 80);
  }
  // Under `error`, not `err`: pino's err serializer would rebuild the object.
  const e = ERROR_FIELDS.map((field) => obj?.[field]).find((v) => v && typeof v === 'object');
  if (e) out.error = { name: scrub(e.name ?? 'Error'), message: scrub(e.message).slice(0, 200) };
  return out;
}

/** The pino logger Evolution hands Baileys: the level asked for, and only bounded fields. */
export function makeBaileysLogger(level: string) {
  return P({
    level,
    formatters: { log: (obj) => safeLogFields(obj) },
    hooks: {
      logMethod(args, method) {
        return method.apply(this, args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as Parameters<typeof method>);
      },
    },
  });
}
