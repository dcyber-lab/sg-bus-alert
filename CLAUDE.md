# Claude Project Memory

Start with `README.md`.

This is a small local automation project for Singapore bus alerts on Telegram.

## Current scope

- Monitor:
  - `189` at `17379` `金文泰大牌304`
  - `963` at `17051` `丽晶园对面`
- Weekday alert windows: `08:30-09:30` and `17:30-18:30` (Asia/Singapore)
- One proactive message per window, then silent in-place edits every cycle (no repeated pushes)
- Show weather in status and window notification
- Show next 3 arrivals
- Mute: `上车了` = current window only; `暂停` = whole day; `恢复` clears both

## Architecture

- `index.mjs`: all runtime logic
- `lib/runtime-helpers.mjs` + `lib/state-store.mjs`: tested helpers and SQLite state store
- `.env`: local config
- `state.db`: SQLite state (Telegram offset, mute state, window notices, overrides)
- `systemd --user` timer polls every 10s; service is killed after 90s (`TimeoutStartSec`)

## User expectations

- Telegram text should stay readable on mobile
- No notification storms: one push per window, updates happen by editing that message
- Manual query should still work even when muted

## Risk areas

- Do not break `telegramUpdateOffset` (state is persisted in a `finally`, even when a run fails)
- Do not break mute state (`mutedUntilDateKey`, `mutedWindowKeys`)
- Do not break `windowNotices` tracking — it is what prevents duplicate proactive sends
- Weather failures should not break bus replies
