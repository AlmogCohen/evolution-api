// What a live-check tape may keep as written, by field. Shared by the scrubber
// (test/tools/live-scrub.ts), its leak gate and the fixture guard
// (test/tools/fixture-guard.ts): a string is kept only under a field named here
// and only when its value is one this field is known to take. Anything else is
// a person's (a name, a username, a text, an address) until the list says
// otherwise, and a field the scrubber does not know makes it stop, writing
// nothing. Add a field or a value here when a new recording needs one, never a
// pattern that a name or a username could match.
const oneOf =
  (...values: string[]) =>
  (s: string) =>
    values.includes(s);

/** Every event Baileys emits and every webhook Evolution sends (Events in src/api/types/wa.types.ts). */
const EVENTS = new Set(
  `
  application.startup instance.create instance.delete qrcode.updated connection.update status.instance
  messages.set messages.upsert messages.edited messages.update messages.delete messages.media-update
  messages.reaction send.message send.message.update contacts.set contacts.upsert contacts.update
  presence.update chats.set chats.update chats.upsert chats.delete chats.lock groups.upsert groups.update
  group-participants.update group.join-request group.member-tag.update call typebot.start
  typebot.change-status labels.edit labels.association creds.update messaging-history.set
  messaging-history.status remove.instance logout.instance blocklist.set blocklist.update
  lid-mapping.update message-capping.update message-receipt.update newsletter-participants.update
  newsletter-settings.update newsletter.reaction newsletter.view settings.update
`
    .trim()
    .split(/\s+/),
);
const isEvent = (s: string) => EVENTS.has(s);

/** The harness's instance name: the scrubber names the instance this, and a replay runs under it. */
export const REPLAY_INSTANCE = 'test';

export const STRUCTURAL: Record<string, (s: string) => boolean> = {
  // The tape itself (recorder.ts, codec.ts).
  instance: oneOf(REPLAY_INSTANCE),
  instanceName: oneOf(REPLAY_INSTANCE),
  event: isEvent,
  batch: isEvent,
  origin: oneOf('app'),
  $proto: (s) => /^proto(\.[A-Z][A-Za-z0-9]*)+$/.test(s),
  as: oneOf('Buffer', 'Uint8Array'),
  $redacted: oneOf('creds'),
  $date: (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s),
  $fn: (s) => /^[A-Za-z_$][\w$]{0,40}$/.test(s),
  // Baileys' and Evolution's enums.
  connection: oneOf('open', 'connecting', 'close'),
  state: oneOf('open', 'connecting', 'close', 'refused'),
  addressingMode: oneOf('pn', 'lid'),
  type: oneOf('notify', 'append', 'add', 'remove'),
  messageType: (s) => s === 'conversation' || /^[a-z][A-Za-z]*Message$/.test(s),
  mimetype: (s) => /^[a-z]+\/[a-z0-9.+-]+(;\s*[a-z0-9-]+=[A-Za-z0-9.-]+)*$/.test(s),
  source: oneOf('ios', 'android', 'web', 'desktop', 'unknown'),
  status: oneOf(
    'ERROR',
    'PENDING',
    'SERVER_ACK',
    'DELIVERY_ACK',
    'READ',
    'PLAYED',
    'DELETED',
    'offer',
    'ringing',
    'timeout',
    'reject',
    'accept',
    'terminate',
  ),
  action: oneOf('add', 'remove', 'promote', 'demote', 'modify'),
  admin: oneOf('admin', 'superadmin'),
  owner_country_code: (s) => /^[A-Z]{2}$/.test(s),
};

/** Whether `value` under `key` is structure the tape keeps as written. */
export const isStructural = (key: string, value: string) => !!STRUCTURAL[key]?.(value);

/** The creds keys a creds.update carries once redacted ({$redacted:'creds', keys}): Baileys' field names. */
export const isCredsKey = (s: string) => /^[a-z][A-Za-z0-9]{1,40}$/.test(s);

/** Numbers under these keys are sizes, counts and times, not people. */
export const NUMERIC_KEY =
  /(length|size|seconds|duration|count|progress|timestamp|time|^t$|^seq$|at$|height|width|expiration|ttl)/i;

/** A place: always replaced, whole degrees included. */
export const LOCATION_KEYS = new Set(['degreesLatitude', 'degreesLongitude']);

export const isEpoch = (digits: string) => /^1\d{9}$/.test(digits) || /^1\d{12}$/.test(digits);

/** WhatsApp's own label for the owner ("You"), which it puts where a name goes. */
export const OWNER_LABEL = 'Você';
