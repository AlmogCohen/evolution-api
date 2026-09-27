# This fork

An unofficial fork of [Evolution API](https://github.com/evolution-foundation/evolution-api)
2.3.7. It is not endorsed by Evolution Foundation, and
the image it builds is not an official Evolution API build: it carries its own
name of its own, not Evolution's.

## Why it exists

Evolution API has no test suite. Every bug below shipped because nothing could
catch it, and a consumer that needed a fix could only patch the minified bundle
with string replacements. This fork shows the other way: the same code, a test
harness that runs Evolution's own TypeScript source against the real Baileys,
and every change made test first.

## The rule: red, then green

Every change in this fork is two commits, in this order:

1. `test: ...`, a test that reproduces the bug and **fails** on the code as it
   is. CI runs on that commit, so its red run is the proof that the test sees
   the bug.
2. `fix: ...` (or `feat:`), the smallest change that makes that test pass,
   with the rest of the suite still green.

A fix without a failing test first is not merged here. See `AGENTS.md`.

## Base

- Source: the `2.3.7` tag (`cd800f29`). Upstream `main` has the same code.
  Upstream `develop` (2.4.0) is not used: it requires licence activation
  against Evolution Foundation's server and breaks `POST /instance/create`.
- Baileys pinned to `7.0.0-rc14` (2.3.7 ships rc.9, which is inside the range
  of CVE-2026-48063).

## Changes from 2.3.7

Each line is a pair of commits: the test that failed on 2.3.7, then the fix.
`git log 2.3.7..` is the source of truth, and `git diff 2.3.7 --stat` lists
every file modified from the original. Upstream issues and pull requests are
named where one exists.

**Contacts, names and groups**
- App-state sync keys are reloaded with `fromObject` in all three auth stores, so saved names, labels, mutes and archives keep syncing after a restart (#2576, #2384; fixes also offered in #2685 and #2610).
- Every @lid to phone mapping Baileys learns is forwarded on `contacts.upsert`, captured before Baileys' event buffer drops it.
- Every `contacts.upsert` item says whether its name is the one the owner saved (`saved`), and only when that is certain.
- Group updates reach subscriptions stored as `GROUP_UPDATE`, in all seven transports and in the global configurations (#2652).
- Group metadata is filled from `groups.update` instead of queried again for every group on every listing.
- `chats.update`, `chats.set` and `chats.upsert` items carry the chat's archive, pin and mute state (`archived`, `pinned`, `muteEndTime`) when Baileys has it, and omit a field it does not have rather than guess.

**Messages and privacy**
- A `getMessage` miss or failed lookup answers nothing, so Baileys no longer relays an empty message on a retry and uses it up (#2705, and #2706 for groups; fixes also offered in #2728 and #2623).
- No message text, phone number, JID or push name reaches the logs at `LOG_LEVEL=ERROR,WARN`, including Baileys' own error logs.
- The `messages.upsert` webhook key of a DM WhatsApp addresses by @lid shows the phone JID as `remoteJid`, as 2.3.7 does, but keeps the original @lid in `remoteJidAlt` (2.3.7 copied the phone there too and lost it), with `addressingMode: 'pn'`: upstream develop's swap.
- A media re-upload request names the message by the address the phone stores it under: the @lid from `remoteJidAlt` or `participantAlt` when the key shows the phone, or, for a key stored from 2.3.7 (the phone twice, `addressingMode: 'lid'`), the @lid Baileys' LID mapping has for the phone. The phone refuses a request that names an @lid chat by its phone JID.
- A media download records whether it asked the phone to re-upload an expired file and how that ended (a bounded log line, and `reupload` on the download's error), and when the phone refused, why (`reason=` on the log line, `reuploadReason` on the error and the HTTP answer: the phone's result such as `NOT_FOUND`, `error_<code>`, `missing_ciphertext`, or `no_answer`). Baileys 7.0.0-rc14 never asks on a CDN 404 or 410 (its check misses the status), so Evolution asks the phone itself, once per download, for at most 60s. A CDN 403 counts as expired only when the link that actually failed (the one on Baileys' error, which is the directPath when the message has one, else the url) carries exactly one `oe` query parameter, in hex unix seconds, that has passed by the local clock. This is a conservative heuristic: on 84 history-sync attachments, 403 answered 34 of 34 expired links and 0 of 50 valid ones, where a valid link to a dropped file answered 404 or 410.
- A media download turns the media key back into bytes (from a base64 string, or the object JSON makes of a Uint8Array or a Buffer) before it asks the phone to re-upload, since Baileys 7.0.0-rc14 derives the re-upload's key from the value as given and then cannot decrypt the phone's answer (Baileys #2729 proposed the same fix there).
- `POST /chat/getBase64FromMediaMessage` takes an optional `reupload` (boolean, default true). With `false` the phone is never asked to re-upload, and a file gone from the CDN (404, 410, or 403 on an expired link) fails at once with a 400 that says so; the HTTP error carries `reupload` for any failed download.

**Proxy**
- Media downloads, media uploads and the WhatsApp Web version fetch leave through the instance's proxy (uploads failed outright on a proxied instance).
- A connect waits for the instance's proxy and stored settings, so it never starts from the server's own address or with default settings.

**Sessions and connections**
- A database error never replaces a linked session's credentials with fresh ones, and a failed settings read no longer drops an event batch.
- A logout or delete while the socket is down keeps the session until WhatsApp is told, so the device leaves the phone's Linked devices; it answers `202 PENDING` meanwhile and forwards nothing (#2520, #2508 in part). The pending logout is recorded on the instance's row (`disconnectionObject.logoutPending`) as well as in a file next to the session keys, so a restart that lost the instances volume still finishes it; when it cannot be recorded, the logout or delete answers 500 instead of 202. A deleted instance keeps its database row until then (Session and Proxy cascade from it), out of the API, its name taken and its token cleared.
- Reconnects back off from 1s to 60s instead of spinning, the version fetch times out after 10s, and an instance never runs two sockets (#2134, #2184, #2430; ideas from #2732).
- Profile pictures are looked up once per contact per hour, at most four at a time, and history never waits on them (#1883).
- One pairing code per connect attempt, and a fresh QR budget per attempt (#2100, #2696).

**Live checks**
- A live check against a real phone can be recorded (`LIVE_RECORD_DIR`), scrubbed into a fixture behind a fail-closed leak gate, and replayed through the real event buffer and service in a test. The protocol, the check catalogue and the results log are in `docs/LIVE-CHECKS.md`.

## Licence

Evolution API is licensed under the Apache License 2.0 with additional
conditions (`LICENSE`), which this fork keeps unchanged. `NOTICE` carries
Evolution Foundation's attribution and states the modifications.
