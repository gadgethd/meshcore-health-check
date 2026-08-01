# Mesh Health Check Fix Summary

## Changes

- Kept the Active Code value on one line with `white-space: nowrap`; narrow layouts can scroll the code horizontally instead of splitting it.
- Added `public/design-tokens.css` as the shared source for dashboard and Turnstile landing-page colors, typography, backgrounds, radius, and shadow tokens. The three HTML shells load it before their page-specific stylesheets.
- Added a live transport status message to the dashboard. It now distinguishes `Broker offline — observer directory cannot update` from `Connected to MQTT — waiting for observer metadata or packets`, retained-but-idle observers, and active observer reporting. Shared result pages identify that live transport is not used.
- Added a smoke assertion for the offline transport state and included the token stylesheet in the service-worker core assets.

## Verification

- `npm run check` — passed
- `npm test` — passed, 27 tests
- `npm run test:smoke` — passed, 4 tests
- `git diff --check` — passed

The repository has no `npm run build` script; validation uses the existing check, unit, and Playwright smoke commands. No deployment or push was performed.
