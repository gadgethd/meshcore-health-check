# Changes

## v1.0

- initial standalone release of Mesh Health Check
- Docker-first deployment with `docker compose up`
- local `.env` runtime configuration only
- MQTT ingest and MeshCore packet parsing with `meshcore-decoder-multibyte-patch`
- channel message matching by generated code and message hash
- per-observer receipt tracking with path and radio metrics
- browser-session-only previous check history
- 10-minute code expiration and configurable max uses per code
- public browser UI with internal JSON endpoints for app state
- rate limiting for session creation
- optional Cloudflare Turnstile gate for new code generation
- dedicated Turnstile landing page with redirect into `/app`
- proxy-friendly deployment for Nginx and Cloudflare
- persistent `observer.json` mapping for observer names across restarts
- browser-side custom observer selection for the next generated code
- deployment-wide default observer target set via `KNOWN_OBSERVERS`
- decode scope limited to the configured test channel only
- `LOG_LEVEL=info|debug` runtime logging control
- Node unit tests and GitHub Actions CI for shared helper logic
- fixture-driven packet ingest tests and Playwright smoke tests
