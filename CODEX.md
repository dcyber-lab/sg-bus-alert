# Codex Project Memory

Project path: `/home/minipc/sg-bus-alert`

Read [`README.md`](/home/minipc/sg-bus-alert/README.md) first.

## Quick context

- Single-file Node app in `index.mjs`
- No package manager, no dependencies
- Uses Telegram polling via `getUpdates`
- Uses `systemd --user` timer for 10-second polling
- Runtime state is in `state.json`
- Config is in `.env`

## Important behavior

- Morning proactive alerts only run on weekdays `08:30-09:30` Singapore time
- Morning alerts are merged into one message
- Query commands:
  - `状态`
  - `189`
  - `963`
  - `上车了`
  - `暂停`
  - `恢复`
- Same-day mute blocks proactive alerts only

## APIs

- Bus arrivals: `https://arrivelah2.busrouter.sg/?id=<stop_code>`
- Weather: `https://api.open-meteo.com/v1/forecast`
- Telegram: `getUpdates`, `sendMessage`

## Known operational detail

- Node `fetch()` to Open-Meteo may fail on this machine
- Weather fetch already falls back to `curl -fsSL`

## Editing guidance

- Keep the project dependency-free
- Keep Chinese user-facing text unless the user asks otherwise
- If changing Telegram behavior, update README too
