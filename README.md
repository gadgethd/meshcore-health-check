# Mesh Health Check

Mesh Health Check is a self-hosted web app that measures MeshCore message
coverage across your MQTT-connected observer network. It gives the user a short
code, waits for that code to appear in the configured MeshCore group channel,
then scores the result based on how many selected observers reported the same
message hash.

The idea for this app came from Nick D from Boston.

## Features

- short-lived reusable test codes with expiry and per-code use limits
- observer-by-observer receipt tracking with path, RSSI, SNR, and duration data
- default observer target sets plus browser-side custom observer selection
- persistent observer naming through
  [observer.json](/home/yellowcooln/mesh-health-check/observer.json)
- Cloudflare Turnstile landing page for bot protection
- Docker-first deployment behind Nginx or Cloudflare
- fixture, API, and smoke-test coverage in CI

## How It Works

1. A visitor opens the site and gets a code such as `MHC-AB12CD`.
2. The user sends that code to the configured MeshCore channel.
3. The backend watches the MQTT observer feed for that channel only.
4. When the matching `GroupText` message appears, the app ties all receipts for
   the same message hash to that code.
5. The UI computes coverage against either the default observer set or the
   user’s custom selection for that code.

Each code:
- expires after `SESSION_TTL_SECONDS`
- can be used up to `MAX_USES_PER_CODE` times
- keeps previous results only in the current browser session

## Project Layout

- [server.js](/home/yellowcooln/mesh-health-check/server.js): Express app,
  MQTT ingest, session matching, observer persistence, Turnstile verification,
  WebSocket updates
- [public/](/home/yellowcooln/mesh-health-check/public): dashboard, landing
  page, browser logic, and styles
- [observer.json](/home/yellowcooln/mesh-health-check/observer.json):
  persistent observer public-key to display-name map
- [`.env.example`](/home/yellowcooln/mesh-health-check/.env.example): deployment
  config template
- [HOWTO.md](/home/yellowcooln/mesh-health-check/HOWTO.md): setup and operator
  guide

This repo is container-first. `docker compose up -d --build` is the intended
runtime path.

## Environment

Copy [`.env.example`](/home/yellowcooln/mesh-health-check/.env.example) to
[`.env`](/home/yellowcooln/mesh-health-check/.env) and fill in the values you
actually need.

Key groups:

- App:
  `PORT`, `APP_TITLE`, `APP_EYEBROW`, `APP_HEADLINE`, `APP_DESCRIPTION`,
  `LOG_LEVEL`, `TRUST_PROXY`
- MQTT:
  `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TOPIC`,
  `MQTT_TRANSPORT`, `MQTT_WS_PATH`, `MQTT_TLS`, optional `MQTT_URL`
- Channel:
  `TEST_CHANNEL_NAME`, `TEST_CHANNEL_SECRET`, optional `TEST_CHANNEL_HASH`
- Sessions:
  `SESSION_TTL_SECONDS`, `MAX_USES_PER_CODE`, `SESSION_RATE_WINDOW_SECONDS`,
  `SESSION_RATE_MAX`
- Observers:
  `OBSERVERS_FILE`, `KNOWN_OBSERVERS`, `OBSERVER_ACTIVE_WINDOW_SECONDS`
- Turnstile:
  `TURNSTILE_ENABLED`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
  `TURNSTILE_API_URL`, `TURNSTILE_COOKIE_NAME`,
  `TURNSTILE_TOKEN_TTL_SECONDS`, `TURNSTILE_BOT_BYPASS`,
  `TURNSTILE_BOT_ALLOWLIST`, `TURNSTILE_VERIFY_RATE_WINDOW_SECONDS`,
  `TURNSTILE_VERIFY_RATE_MAX`

Important behavior:

- If `KNOWN_OBSERVERS` is set, new codes use that configured observer set by
  default.
- If `KNOWN_OBSERVERS` is blank, the default target falls back to observers
  active in the configured time window.
- Users can override the default target in the browser for each new code.
- `observer.json` is loaded at boot and updated when new observer names are
  learned from MQTT metadata.

## Run It

```bash
docker compose up -d --build
```

Default local URL: `http://localhost:3090`

If Turnstile is enabled:
- `/` serves the verification page
- `/app` serves the dashboard after a successful challenge

## Security Notes

- Keep port `3090` private to your reverse proxy or internal network.
- Session creation and Turnstile verification are rate-limited.
- Leave `TRUST_PROXY=1` when running behind Nginx or Cloudflare.
- The app only decodes the configured test channel and ignores all other
  channel traffic on the same MQTT topic.

## Decoder Note

The app now uses `meshcore-decoder-multibyte-patch` for runtime MeshCore packet
decoding. That package handles the multibyte path-hop format seen on the live
observer stack and is a better fit than the older single-byte assumptions that
were causing valid packets to be misread.
