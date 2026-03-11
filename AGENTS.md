# Repository Guidelines

## Project Structure & Module Organization

- `server.js`: Express API, MQTT client, MeshCore packet parsing, session
  matching, rate limiting, Turnstile handling, observer persistence, and
  WebSocket broadcast.
- `public/`: standalone frontend assets.
  - `index.html`: dashboard shell
  - `app.js`: dashboard state, observer selection, API calls, WebSocket updates,
    rendering
  - `styles.css`: dashboard layout and responsive styling
  - `landing.html`, `landing.css`, `turnstile-landing.js`: Turnstile landing flow
- `.env` and `.env.example`: the only runtime configuration source for this
  repo.
- `observer.json`: persistent observer public-key to node-name map, mounted
  into the container and updated by the server.
- `README.md`: architecture and flow overview.
- `HOWTO.md`: deployment and operator guide.
- `CHANGES.md`: versioned project change log.

## Build, Test, and Development Commands

- `docker compose up -d --build`: build and start the app.
- `docker compose logs -f`: follow startup, MQTT, and runtime logs.
- `docker compose down`: stop the service.
- `npm run check`: syntax-check backend and frontend JS used in CI.
- `npm test`: run Node unit and API tests.
- `npm run test:smoke`: run Playwright browser smoke tests.
- `node --check server.js`
- `node --check public/app.js`

Use Docker for runtime validation. Host `npm start` is not a supported workflow,
but `npm test` and `npm run check` are valid for local CI-style verification.

## Coding Style & Naming Conventions

- Use ASCII and 2-space indentation in JS, HTML, CSS, and Markdown.
- Use `camelCase` for functions and variables.
- Use `UPPER_SNAKE_CASE` for env vars and constants.
- Keep new dependencies to a minimum; prefer small local helpers for auth,
  parsing, rate limiting, and Turnstile verification.
- Keep MQTT packet handling scoped to the configured test channel only.
- Keep UI changes consistent with the existing single-page flow.

## Testing Guidelines

- Minimum validation for app changes:
- run `docker compose up -d --build`
- run `npm run check`
- run `npm test`
- run `npm run test:smoke` when UI or routing changes
- confirm `curl -s http://localhost:3090/api/bootstrap`
- confirm observer names resolve from `observer.json` before fresh MQTT metadata
  arrives
- confirm session creation still works, including default and custom observer
  sets
- confirm session creation is still rate-limited
- if Turnstile is enabled, confirm `/api/verify-turnstile` and landing flow
- review `docker compose logs --tail=50`

## Commit & Pull Request Guidelines

- Use short imperative commit messages, for example: `Add cookie auth flow`.
- PRs should include:
  - behavior summary
  - config changes
  - manual verification steps
  - screenshots for UI changes

## Security & Configuration Tips

- Do not commit real MQTT credentials or production tokens unless explicitly
  intended for the deployment repo.
- Keep `TRUST_PROXY=1` behind Nginx or Cloudflare.
- Keep Turnstile keys only in local deployment config.
- Keep port `3090` private to the proxy or internal network.
- Do not add runtime dependencies on sibling repositories.
- Keep `KNOWN_OBSERVERS` values as full pubkeys, not display names.
