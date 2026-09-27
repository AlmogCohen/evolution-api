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

The list grows with each red and green pair. `git log 2.3.7..` is the source of
truth, and `git diff 2.3.7 --stat` lists every file modified from the original.

## Licence

Evolution API is licensed under the Apache License 2.0 with additional
conditions (`LICENSE`), which this fork keeps unchanged. `NOTICE` carries
Evolution Foundation's attribution and states the modifications.
