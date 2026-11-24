# Health Check fork integration

Software: a guided MeshCore coverage check for people testing a radio message.
Use the existing blue, dark and light application palette, with readable type,
equal content edges and a single live result. Keep map and receipt controls.
Voice: technical and direct. Use code, channel, observer and receipt consistently.

## Provenance and boundaries

- Start at deployed c93af192ec7cc0ecdfb3e9d0ea163840202ccbfc.
- Merge gadgethd main 2738e2c8fffef0ff9aba3de5bd2fe9591954933c.
- Merge yellowcooln main 8d9e4d0c9bcc461271d304c3da90c345a8bb02af.
- Preserve deployed Turnstile API authorization, preview-only bot bypass,
  address-bound short-lived WebSocket tokens, exact path and origin validation,
  global/per-address/payload/buffer/idle limits, local tile proxy, atomic writes,
  receipt identity validation and retained version 1 results.
- Adopt upstream geographic selection, nearby selection, code options,
  per-receipt radio scopes, local MapLibre assets and GPL-3.0-only notices.

## Changes and acceptance

1. Resolve merges without restoring weak legacy packet decryption. Share the
   binary packet parser with the radio-scope feature instead.
2. Give authenticated WebSocket connections one owner for admission, heartbeat,
   broadcast and shutdown. Remove the duplicate fork heartbeat/cap definitions.
   Keep HTTP authorization and persisted session results independent.
3. Make app and share pages a compact guided workflow: select observers, copy
   the code into the configured channel, then read receipts. Keep diagnostics
   available as details, remove repeated hero content and decorative telemetry
   language. Preserve existing control IDs, selection, map, drawers and links.
4. Cover stricter deployed admission with real native sockets; update legacy
   tests to obtain their bootstrap cookie and exercise forbidden paths/origins,
   address binding, caps, payloads and read-only behavior.
5. Run syntax, complete native/API tests, browser journeys and responsive
   screenshots on isolated test servers. No original data or live MQTT. Root
   integration owns final Docker validation and publication.

The existing per-session expected-observer denominator, lifetime, code reuse,
sharing retention and historical receipt format remain the compatibility oracle.
No timeout, security or resource ceilings are raised for a test.

## Local validation and Docker inputs

Node 26.13.1: syntax checks and all 159 native/API tests passed without skips.
The guided desktop (1440px) and mobile (390px) Chromium journeys passed, including
clipboard, new code, observer selection, details, theme switching, share read-only
behavior and overflow. Copy lint reports zero failures and warnings on both pages.

Local browser validation uses the available Chromium build 1243 with Playwright
1.65, explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, and isolated native libraries.
CI should install Playwright's corresponding build 1254. Missing-browser, library
and ffmpeg attempts failed before product navigation and were not product proof.

Expected image contents: package.json and this fork's package-lock.json, decoder
postinstall script, server.js, lib/, public/, regions/, region-scopes.example.yml,
LICENSE and LICENSES/. Use Node 26 with the pinned Dockerfile base. Keep the root
integration's private data volume, process umask and configured logo mount.
No root overlay lockfile is needed with this dependency graph. No live MQTT,
original stores, Docker daemon actions or publication were used in this checkout.
