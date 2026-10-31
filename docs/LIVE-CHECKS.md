# Live checks

The unit and harness tests run Evolution's source against the real Baileys, but
the input is ours. A live check runs the fork against a real phone and records
what WhatsApp actually sent, so the behaviour can be replayed in a test from then
on. This file is the protocol, the catalogue of checks, and the log of results.

## The chain

1. **Record.** The fork records a session when `LIVE_RECORD_DIR` is set
   (`src/utils/live-record/recorder.ts`), and does nothing otherwise. Per
   instance and session start it writes:
   - `events.ndjson`: every Baileys event (name, payload, a sequence number,
     the socket it came from, whether the event buffer held it) and every batch
     the buffer delivered. This is the input tape.
   - `webhooks.ndjson`: every payload Evolution sent (`sendDataWebhook`). This is
     the golden output tape.
   - `manifest.json`: versions and conditions (below). No number, JID, name or
     content.
   - `owner.json`: the linked account, for the scrubber only. It is never copied
     into a fixture.

   Values are written in a tagged codec (`src/utils/live-record/codec.ts`) so a
   replay rebuilds identical ones: `$bytes` (Buffer or Uint8Array), `$long`,
   `$u` (undefined), `$proto` (the protobuf class), `$err`, `$date`. The auth
   creds are redacted when recorded, and so is whatever links a device, on both
   tapes: the QR payload (`$qr`) in `connection.update`, and the QR payload, its
   image and the pairing code (`$qr`, `$pairingCode`) in `qrcode.updated`.
2. **Scrub.** `scripts/live-scrub.ts` turns a raw session into
   `test/fixtures/live/<YYYY-MM-DD>-<check-id>/`, then runs a leak gate that
   takes every value of the raw tapes that is not structure and searches the
   output for it, and writes nothing if one survives.
3. **Replay.** `test/helpers/live-replay.ts` feeds the fixture's events through
   Baileys' real event buffer (buffered where they were) into the real
   `BaileysStartupService`, and `compareGolden` compares what Evolution sends
   with `webhooks.ndjson`.

### What the manifest records

| Field | Source |
| --- | --- |
| `forkCommit` | `/evolution/FORK_SHA` (the working directory's `FORK_SHA` file), else `git describe`, else the `FORK_SHA` variable |
| `baileysVersion` | the installed `baileys/package.json` |
| `nodeVersion` | the running Node |
| `waWebVersion` | the version the socket was built with |
| `phonePlatform` | `creds.platform`, which WhatsApp reports at pairing (`smba`, `smbi`, `android`, `iphone`...). Known after the connection opens; kept in the creds, so also known after a restart |
| `accountType` | derived from the platform: `smb*` is WhatsApp Business. Null when the platform is unknown |
| `linkMethod` | `qr`, `code` (a pairing code was asked for) or `existing-session` (the creds were already paired) |
| `proxy` | used or not, and the protocol. Never the host or the credentials |
| `sockets`, `startedAt`, `openedAt`, `endedAt` | the session's own bookkeeping |

The operator adds by hand, when scrubbing: **phone model, OS version, WhatsApp
app version, country code** (the code only, never a number). Nothing on the
socket reveals them. Record them every time: a result without them cannot be
compared with the next one.

## Protocol

**Who and what phone.** A maintainer, on a test account on a phone kept for it,
linked to nothing else that matters. Use a real account only when the check needs
a real history, and then only one whose contacts know it is used for testing.
Write down the phone model, the OS version and the WhatsApp app version before
you start.

**Run the rig with recording on.** Build the fork image and keep the raw
recordings outside the repository (or in `live-records/`, which is gitignored):

```bash
docker build -t evolution-fork:$(git rev-parse --short=8 HEAD) .
mkdir -p ~/live-records && chmod 700 ~/live-records
docker run --rm -p 127.0.0.1:8080:8080 --env-file .env \
  -e FORK_SHA=$(git rev-parse --short=8 HEAD) \
  -e LIVE_RECORD_DIR=/evolution/live-records \
  -v ~/live-records:/evolution/live-records \
  evolution-fork:$(git rev-parse --short=8 HEAD)
```

Or from the source, which reads the commit from git:

```bash
LIVE_RECORD_DIR=~/live-records npm run dev:server
```

Each process start is a new session directory,
`~/live-records/<instance>/<start>/`. Run one check per session where you can:
restart the container between checks.

**Scrub.**

```bash
npx tsx scripts/live-scrub.ts ~/live-records/<instance>/<start> <check-id> \
  --phone-model "Pixel 8" --os-version "Android 15" --wa-version 2.25.27.78 --country-code 972
npx tsx scripts/live-guard.ts
```

The scrubber prints the fixture directory and a report of counts. It exits 1
and writes nothing when it meets a string under a field it does not know (the
error names the field's path, never the value), or when its leak gate finds an
original in the output: say what the field is in `test/tools/live-scrub.ts` or
`test/tools/live-fields.ts`, never in the fixture, and scrub again. Delete the
raw session once the fixture is committed.

The leak gate does not ask the scrubber what it replaced. It reads the raw tapes
itself and searches every value and key of the output for each string of 4+
characters that is not structure, the user part of every address, every run of
7+ digits that is not an epoch, every decimal but the tape's clock, and every
byte string.

What the scrubber does: one person keeps one fake index across their phone JID,
@lid and device suffix (the owner is index 0, `972500000000`); names keep
equality (a saved name and a profile name stay different, the same name stays
the same); message ids keep their first two characters and length (Evolution
reads the device from them); bytes keep their length and type, with random
content, so a replay test must never depend on real crypto; text (a stub
parameter included) becomes lorem of the same length; a username becomes a fake
name; URLs become `https://example.invalid/<n>`; a location, and any decimal but
the tape's clock, becomes `0.<nnn>`. A string is kept as written only under a
field `test/tools/live-fields.ts` lists, and only with a value that field is
known to take (event names, Baileys' and Evolution's enums), never because it
looks like an identifier.

**Add the fixture and its replay test.** Put the test next to the behaviour it
covers, and assert the exact thing the check is about, then the whole output:

```ts
import { compareGolden, loadFixture, replayFixture } from '../helpers/live-replay';

const FIXTURE = 'test/fixtures/live/2026-10-01-archive-toggle';

it('archiving on the phone reaches chats.update with archived: true', async () => {
  const { webhooks } = await replayFixture(FIXTURE);
  const updates = webhooks.filter((w) => w.event === 'chats.update').flatMap((w) => w.data);
  expect(updates).toContainEqual(expect.objectContaining({ remoteJid: '972500000001@s.whatsapp.net', archived: true }));
  expect(compareGolden(webhooks, loadFixture(FIXTURE).webhooks, { events: ['chats.update'] })).toEqual([]);
});
```

Socket queries (profile pictures, group metadata, LID lookups) were not
recorded: they answer as the harness does, and `replayFixture(dir, { client })`
takes answers a test needs. Fields Evolution fills from the clock, the database
or those queries are left out of the comparison (`VOLATILE` in
`live-replay.ts`).

**The rule: a fixture test must fail when the behaviour is broken.** A fixture
recorded on fixed code carries the fix in its golden output. Prove the test sees
it once: run it against the code before the fix (check out the parent of the
fix, or revert it locally) and see it fail for the reason the check is about.
Say so in the commit. A fixture test that passes either way proves nothing.

## Before you commit a recording (checklist)

Nothing personal may reach the repository. Before any commit or push that
touches `test/fixtures/live/`:

- [ ] Nothing from `LIVE_RECORD_DIR` (or `live-records/`) is staged. Only the
      scrubber's output is committed; `owner.json` never is.
- [ ] `npx tsx scripts/live-guard.ts` says clean, and `scrub-report.json` says
      `"leakGate": "pass"` with counts that make sense for the check.
- [ ] You opened every new fixture file and skimmed it yourself.
- [ ] Nothing in it looks like a phone number, the user part of an
      `@lid` / `@s.whatsapp.net` address that is not a fake (`972500......`,
      `100000000......`, `120363............`), a name, a message text, a signed
      media URL (`mmg.whatsapp.net`, `oh=` / `oe=` parameters), an email, a
      token or a key.
- [ ] If anything does: stop, fix the scrubber, and scrub again. Never edit a
      fixture by hand.
- [ ] No raw recording is pasted into a commit message, an issue, a pull
      request or a chat.

`test/live/fixture-guard.test.ts` runs the same guard over
`test/fixtures/live/` in CI on every commit, and lint-staged runs it on staged
fixture files. In a tape it accepts only the scrubber's fakes and the values
`live-fields.ts` lists by field, and flags any other string and any decimal
number. It still cannot tell a name the scrubber mistook for structure from
structure, which is why the skim is not optional.

## Check catalogue

Each check says what it proves and the steps. "Fixture" means the session is
worth scrubbing into a replay test.

| Check id | Proves | Steps | Fixture |
| --- | --- | --- | --- |
| `stock-to-fork-switch` | a session linked on the stock image keeps working on the fork | link on the stock 2.3.7 image; stop it; start the fork on the same volume and database; send and receive one message | no |
| `app-state-after-restart` | saved names, labels, mutes and archives keep syncing after a restart | link; wait for history; restart the container; on the phone rename a contact and archive a chat; watch `contacts.upsert` and `chats.update` | yes |
| `saved-vs-profile-names` | `saved` is true only for the name the owner saved | save contact A under a name that differs from A's profile name; leave B unsaved; both send a message | yes |
| `archive-toggle` | archive and unarchive on the phone reach `chats.update` with `archived` | archive a chat on the phone, wait, unarchive it | yes |
| `group-rename-participants` | group updates and participant changes reach their webhooks | create a group with two test numbers; rename it; add, promote, demote and remove a participant | yes |
| `live-lid-message-key` | a DM WhatsApp addresses by @lid shows the phone as `remoteJid` and keeps the @lid in `remoteJidAlt` | from a number that is not a saved contact, send a message to the account | yes |
| `history-lid-keys` | history arrives with the original @lid keys | link a fresh device on an account with @lid chats; wait for history to finish | yes (history is large: scrub a short account) |
| `pairing-code-over-45s` | one pairing code per connect attempt, still valid after the 45s QR window | connect with a number; wait more than 45s before typing the code on the phone | no |
| `logout-reaches-phone` | a logout takes the device off the phone's Linked devices | log out through the API; check Linked devices on the phone | no |
| `logout-while-offline` | a logout with the socket down is delivered when it reconnects | cut the container's network; log out through the API (expect `202 PENDING`); restore the network; check Linked devices | no |
| `reconnect-backoff-one-socket` | reconnects back off 1s to 60s, never give up, and one socket at a time | cut the container's network for 3 minutes; read the reconnect log lines; restore; count sockets in the manifest and the log | yes (the close and reopen) |
| `proxy-per-number` | each instance leaves through its own proxy (socket, version fetch, media) | two instances behind two proxies; check each proxy's log for its instance's traffic and none of the other's | no |
| `clean-logs` | no message text, number, JID or push name in logs at `LOG_LEVEL=ERROR,WARN` | run a session with restarts, reconnects and group listings; count digit runs of 8+, addresses and media URLs in the log | no |
| `bounded-queries` | profile pictures and group metadata are queried within their bounds | on an account in several groups, link and list groups; count the queries per contact and group | yes |
| `media-reupload-expired` | a download asks the phone to re-upload an expired file, and a 403 counts as expired only when the link has expired | download media 30 to 180 days old through `getBase64FromMediaMessage`; compare SHA-256 with the phone's copy | no |

## Results log

Outcomes are counts. "Not recorded" means the operator did not write it down;
it is not a guess.

| Date | Check id | Fork commit | Baileys | WA Web | Phone (platform / model / app) | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-27 | `stock-to-fork-switch` | not recorded | 7.0.0-rc14 | not recorded | not recorded / not recorded / not recorded | the session survived the switch from the stock image to the fork |
| 2026-09-27 | `logout-reaches-phone` | not recorded | 7.0.0-rc14 | not recorded | not recorded / not recorded / not recorded | 2 of 2 logouts reached WhatsApp; the device left Linked devices both times |
| 2026-09-27 | `history-lid-keys` | not recorded | 7.0.0-rc14 | not recorded | not recorded / not recorded / not recorded | history arrived with the original @lid keys |
| 2026-09-27 | `media-reupload-expired` (403 rule) | bb269777 | 7.0.0-rc14 | not recorded | not recorded / not recorded / not recorded | 84-file sample: a 403 answered 34 of 34 expired links and 0 of 50 valid ones |
| 2026-09-27 | `media-reupload-expired` | 3fc63a62 | 7.0.0-rc14 | not recorded | not recorded / not recorded / not recorded | 7 of 8 expired files recovered (30 to 180 days old), SHA-256 verified; 1 refused `NOT_FOUND` |
| 2026-09-27 | `clean-logs` | 3fc63a62 | 7.0.0-rc14 | not recorded | business, platform not recorded / not recorded / not recorded; linked earlier by QR; no proxy | at `LOG_LEVEL=ERROR,WARN`, `LOG_BAILEYS=error`: 48 lines across a restart, 2 sessions reconnecting and 2 group listings held 0 digit runs of 8+, 0 WhatsApp addresses, 0 media URLs. 1 finding: an earlier ERROR-level media download failure printed the signed media URL (fixed separately). At full verbosity (INFO to WEBHOOKS, Baileys debug) addresses appear by design |
| 2026-09-27 | `reconnect-backoff-one-socket` | 3fc63a62 | 7.0.0-rc14 | not recorded | business, platform not recorded / not recorded / not recorded; linked earlier by QR; no proxy | network cut for 180s: attempts 1, 2, 4, 8, 16, 32, 60s apart (status 408), capped at 60s, never gave up; reopened on the first attempt after the network returned. 1 finding: the failure line logged `[object Object]` (fixed separately). Sockets not counted |
| 2026-09-27 | `bounded-queries` | 3fc63a62 | 7.0.0-rc14 | not recorded | business, platform not recorded / not recorded / not recorded | not measurable: the account is in no groups. Moved to a later session |
| 2026-09-27 | `app-state-after-restart` | bc522750 | 7.0.0-rc14 | 2.3000.1048596303 | smbi (WhatsApp Business) / iPhone 16, iOS 18.6 / WhatsApp Business 25.24 | PASS: after a restart, a contact renamed on the phone reached `contacts.upsert` with `saved: true` and a mapping item (`lid`, `phoneNumber`), then `contacts.update`. Replayed from `2026-09-27-rig-session` in `test/live/app-state-rename.test.ts` |
| 2026-09-27 | `archive-toggle` | bc522750 | 7.0.0-rc14 | 2.3000.1048596303 | smbi (WhatsApp Business) / iPhone 16, iOS 18.6 / WhatsApp Business 25.24 | PASS: archive, then unarchive, reached `chats.update` with `archived: true` (with `pinned: null`), then `archived: false`. Replayed in `test/live/archive-toggle.test.ts` |
| 2026-09-27 | `group-rename-participants` | bc522750 | 7.0.0-rc14 | 2.3000.1048596303 | smbi (WhatsApp Business) / iPhone 16, iOS 18.6 / WhatsApp Business 25.24 | PASS: the rename reached `groups.update` with the new subject. PASS: a member removed and added back reached `group-participants.update` with `participantsData` holding the @lid as `jid` and the phone JID as `phoneNumber`. Promote and demote not run. Replayed in `test/live/group-rename-participants.test.ts` |
| 2026-09-27 | `live-lid-message-key` | bc522750 | 7.0.0-rc14 | 2.3000.1048596303 | smbi (WhatsApp Business) / iPhone 16, iOS 18.6 / WhatsApp Business 25.24 | PASS: a text and an image in a DM addressed by @lid reached `messages.upsert` with the phone JID as `remoteJid`, the @lid kept in `remoteJidAlt`, `addressingMode: 'pn'`. Replayed in `test/live/live-lid-message-key.test.ts` |
| 2026-09-27 | `clean-logs` | bc522750 | 7.0.0-rc14 | 2.3000.1048596303 | smbi (WhatsApp Business) / iPhone 16, iOS 18.6 / WhatsApp Business 25.24 | PASS: production-level logs over the session, 49 lines: 0 digit runs of 8+, 0 WhatsApp addresses, 0 media URLs |
| 2026-09-29 | `logout-reaches-phone` | 95c844b3 | 7.0.0-rc14 | not recorded | smbi (WhatsApp Business) / iPhone 16 / not recorded | PASS in part: a logout through the API with the socket open was not left pending, and WhatsApp closed the session with 401 (logged out) in the same second. Linked devices on the phone was not checked this time |
| 2026-09-29 | `pairing-code-over-45s` | 95c844b3 | 7.0.0-rc14 | not recorded | smbi (WhatsApp Business) / iPhone 16 / not recorded | PARTIAL, not the check itself: linked by pairing code 33s after the code was requested, the code typed within seconds, so the 45s window was not tested. One phone notification per code request, although `qrcode.updated` carried the code five times in an earlier attempt: consistent with one code per connect attempt. That earlier attempt failed on the phone ("Couldn't link device") and its window closed with 401 after 216s; cause not found (logs at WARN, no recorder). The phone's prompt named the device `Chrome (Mac OS)`, Baileys' default, since number mode sends no configured browser (a custom label there is rejected by WhatsApp: WhiskeySockets/Baileys#2560) |

The phone platform and model were not recorded for the earlier runs: the
recorder did not exist yet, and the operator did not write them down. The rig
session (the rows at fork bc522750) ran on a different phone, recorded, and one
fixture (`test/fixtures/live/2026-09-27-rig-session`) covers its four checks.
