# UKMesh Health Check Fix Summary

Branch: `ukmesh-hc-fixes` (created from `origin/main` at `bcf9a54`)

## SC-06 WebSocket hardening — complete

Files: `server.js`, `.env.example`, `ENVIRONMENT.md`, `HOWTO.md`, `CHANGES.md`,
`test/websocket-hardening.test.js`

- Added configurable same-host/allowlist origin validation. Missing `Origin`
  passes by default (`WS_ALLOW_MISSING_ORIGIN=true`) and no User-Agent is
  required, preserving non-browser observer devices and scripts.
- Added configurable 1 MiB inbound message cap, global 512 and per-IP 128
  connection caps, and high-default per-IP connection/message rate limits.
  Only the excess connection or sender is logged and closed/rejected.
- Preserved the existing WebSocket endpoint, path, query parameters, and
  handshake requirements. Inbound client frames remain ignored and are never
  dispatched to session/observer mutation code.
- Preserved MQTT-over-WebSocket observer ingest configuration and behavior;
  no `MQTT_*` setting, subscription, packet format, firmware, or station config
  changed. Where a legacy dependency was uncertain, the default remains
  permissive.

## SC-10 Discord/session results store race — complete

Files: `server.js`, `test/api.test.js`, `CHANGES.md`, plus async-flush
teardown updates in `test/default-observer-bootstrap.test.js`,
`test/max-uses-alias.test.js`, `test/region-hierarchy.test.js`,
`test/site-url.test.js`, `test/storage-defaults.test.js`,
`test/trust-proxy-rate-limit.test.js`, `test/turnstile-validation.test.js`, and
`test/websocket-hardening.test.js`

- `data/session-results.json` scheduled writes remain nonblocking but run
  through one serialized/coalescing queue. Explicit flushes write synchronously
  only while that queue is idle; otherwise the newer snapshot queues behind the
  in-flight write so an older payload cannot overwrite it.
- Every write uses a unique same-directory temporary file followed by atomic
  rename.
- Removed the non-atomic direct-write fallback. A failed temp/rename operation
  preserves the last known-good file.
- Preserved the existing `{ "version": 1, "sessions": [...] }` file format,
  retention behavior, share links, and API semantics.

## Verification

`npm run check`:

```text
> mesh-health-check@1.3.7 check
> node --check scripts/check-syntax.js && node scripts/check-syntax.js

exit 0
```

`npm test`:

```text
> mesh-health-check@1.3.7 test
> node --test test/*.test.js

tests 59
pass 59
fail 0
cancelled 0
skipped 0
todo 0
exit 0
```

No deploys, service/container restarts, scanner tools, or default-branch merges
were performed. Only `ukmesh-hc-fixes` is intended to be pushed.
