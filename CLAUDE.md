# Claude Project Memory

Start with `README.md`.

This is a small local automation project for Singapore bus alerts on Telegram.

## Current scope

- Monitor:
  - `189` at `17379` `金文泰大牌304`
  - `963` at `17051` `丽晶园对面`
- Weekday alert windows: `08:30-09:30` and `18:30-19:30` (Asia/Singapore); Singapore public holidays skipped
- Windows are editable from the menu and stored as `alertWindowsOverride`, which wins over `.env` and applies next cycle without a restart
- One proactive message per window, then silent in-place edits (~10s) — no repeated pushes
- Stops with 3+ routes render compact (time-sorted list across routes); 🖥 显示方式 forces either layout
- Rain in the nowcast widens the threshold by `RAIN_EXTRA_MINUTES` and adds an umbrella line
- 🛑 我上车了 is logged to `boarding_log`; 📊 我的统计 turns it into habits + a window suggestion
- Active weekdays configurable (📅 生效星期); config mirrored to `config-backup.json`
- Window notices lead with an ETA line, not a title — it is the only thing a notification banner and the chat-list preview show. Keep it first.
- Ghost-bus alerts go out as SEPARATE messages; editing never notifies, so anything urgent must be a new message
- 🏖 休假模式 (`vacationUntil`) mutes a date range
- Optional walk-time departure pings (`步行 <分钟>`): max one "leave now" push per service per window
- Stops can be limited to 早/晚 windows via `设置时段`, renamed via `重命名`
- Adding a stop: share a Telegram location, paste a Google Maps link, or send `lat,lng`; the bot lists stops within 800m as buttons, then lists that stop's services as buttons
- Weather: Open-Meteo daily + data.gov.sg 2h nowcast, cached 10 min, best-effort
- Mute: `上车了` = current window only; `暂停` = whole day; `恢复` clears both

## Architecture

- Long-lived daemon (`systemd --user` service, `Restart=always`), Telegram long polling: 20s idle, 5s during windows; the old 10s timer is gone
- `index.mjs`: all runtime logic (daemon loop `main` + `proactiveTick` + command handling)
- `lib/runtime-helpers.mjs` + `lib/state-store.mjs` + `lib/location.mjs` + `lib/menu.mjs`: tested helpers, SQLite state store, map-link parsing, button menu screens
- Settings are button-driven (`m:*` callbacks), rendered into ONE message that is edited as the user navigates; `m:main` opens a new menu message, `m:back` re-renders in place
- Stop coordinates from data.busrouter.sg, cached in `stops-cache.json` (30-day TTL, gitignored)
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
- `callback_data` is capped at 64 bytes by Telegram; `test/menu.test.mjs` asserts every menu stays under it
- The ⚙️ button on a live-refreshing window notice must open a NEW message — editing that notice would fight the refresh loop
- Never run two pollers at once — Telegram `getUpdates` conflicts (409)
- Keep `dns.setDefaultResultOrder("ipv4first")`: Telegram's IPv6 address is unreachable on this network and Node's fetch will not fall back on its own
- Short-link resolution must stay restricted to Google hosts (`isResolvableShortLink`) and use manual redirects — a pasted link must never make the bot fetch an arbitrary address
- Weather failures should not break bus replies
- `DEFAULT_SG_PUBLIC_HOLIDAYS` in `index.mjs` needs a yearly refresh
