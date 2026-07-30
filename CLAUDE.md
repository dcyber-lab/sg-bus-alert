# Claude Project Memory

Start with `README.md`.

This is a small local automation project for Singapore bus alerts on Telegram.

## Current scope

- Monitor:
  - `189` at `17379` `金文泰大牌304`
  - `963` at `17051` `丽晶园对面`
- Weekday alert windows: `08:30-09:30` and `17:30-18:30` (Asia/Singapore); Singapore public holidays skipped
- One proactive message per window, then silent in-place edits (~10s) — no repeated pushes
- Optional walk-time departure pings (`步行 <分钟>`): max one "leave now" push per service per window
- Stops can be limited to 早/晚 windows via `设置时段`
- Weather: Open-Meteo daily + data.gov.sg 2h nowcast, cached 10 min, best-effort
- Mute: `上车了` = current window only; `暂停` = whole day; `恢复` clears both

## Architecture

- Long-lived daemon (`systemd --user` service, `Restart=always`), Telegram long polling: 20s idle, 5s during windows; the old 10s timer is gone
- `index.mjs`: all runtime logic (daemon loop `main` + `proactiveTick` + command handling)
- `lib/runtime-helpers.mjs` + `lib/state-store.mjs`: tested helpers and SQLite state store
- `.env`: local config, read once at startup — restart service after edits
- `state.db`: SQLite state, persisted only when dirty
- Lock file makes a second instance exit cleanly (never double-poll `getUpdates`)
- Consecutive cycle failures (default 30) trigger a self-diagnosis Telegram warning

## User expectations

- Telegram text should stay readable on mobile
- No notification storms: one digest per window + at most one departure ping per service
- Manual query should still work even when muted

## Risk areas

- Do not break `telegramUpdateOffset` (persisted via dirty-check after every cycle)
- Do not break mute state (`mutedUntilDateKey`, `mutedWindowKeys`)
- Do not break `windowNotices` / `departurePings` tracking — they prevent duplicate pushes
- Never run two pollers at once — Telegram `getUpdates` conflicts (409)
- Weather failures should not break bus replies
- `DEFAULT_SG_PUBLIC_HOLIDAYS` in `index.mjs` needs a yearly refresh
