# sg-bus-alert

Singapore weekday morning bus alerts for Telegram.

This project runs on `/home/minipc/sg-bus-alert` and uses a single Node.js script plus `systemd --user` timer scheduling.

## What it does

- Monitors selected Singapore bus stops and bus services.
- Runs as a long-lived daemon with Telegram long polling, so chat commands are answered almost instantly.
- Sends proactive Telegram notifications on weekdays during configured windows (currently `08:30-09:30` and `17:30-18:30` in `Asia/Singapore`); Singapore public holidays are skipped.
- Each window sends exactly one notification message; afterwards the bot edits that same message in place (roughly every 10s), so ETAs stay fresh without repeated pushes.
- Optional walk-time departure pings: after `步行 <分钟>` is configured, the bot sends at most one extra "leave now" push per service per window when a catchable bus enters the walk-time band.
- Stops can be limited to the morning or evening window via `设置时段` (e.g. home stops in the morning, office stops in the evening).
- The window notification includes:
  - weather summary (Open-Meteo daily + data.gov.sg 2-hour nowcast)
  - the next 3 buses for every monitored service in that window
  - current ETA, load, vehicle type, and arrival clock time
- A stop with 3+ monitored routes switches to a compact layout: one time-sorted list of the soonest buses across all its routes (a 4-route stop goes from ~77 lines to ~7). Forceable either way from 🖥 显示方式.
- When the nowcast says rain, the alert threshold widens by `RAIN_EXTRA_MINUTES` (default 3) and the message carries an umbrella reminder.
- Pressing 🛑 我上车了 is recorded in `boarding_log`; 📊 我的统计 reports the average, earliest and latest boarding time per window and suggests a better window once there are 5+ records.
- Departure pings carry a "⏰ 5 分钟后再提醒" snooze button.
- Active weekdays are configurable (📅 生效星期); the default stays Mon–Fri.
- Config (stops, routes, thresholds, windows, walk time, weekdays, display mode) is mirrored to `config-backup.json` on boot and on every change, so a corrupt `state.db` is recoverable.
- Supports Telegram chat commands for on-demand status lookup.
- Supports boarding mute (`上车了`, current window only) and whole-day mute (`暂停`).
- Uses a lock file so a second instance exits cleanly instead of double-polling Telegram.
- All outbound HTTP calls carry timeouts; if cycles keep failing, the bot sends a self-diagnosis warning to Telegram once the failure streak reaches the configured threshold.

## Current live configuration

- Bus stop `17379` -> `金文泰大牌304` -> service `189`
- Bus stop `17051` -> `丽晶园对面` -> service `963`
- Timezone: `Asia/Singapore`
- Alert windows: `08:30-09:30` and `18:30-19:30` (editable from the settings menu; the stored value overrides `.env`)
- Threshold: `8` minutes
- Telegram bot: `@sg_bus_alert_bot`

## Main files

- `index.mjs`
  - all runtime logic
  - Telegram command handling
  - bus arrival fetching
  - weather fetching
- `lib/location.mjs`
  - Google Maps link / coordinate parsing and nearest-stop ranking
- `lib/render.mjs`
  - arrival formatting, compact vs detailed stop sections, rain detection
- `lib/menu.mjs`
  - button-menu screens
  - morning merged notification logic
  - same-day mute logic
- `.env`
  - live local configuration including bot token and chat id
- `.env.example`
  - template config
- `state.db`
  - primary runtime state store in SQLite
  - stores Telegram update offset, mute state (whole-day and per-window), window notice tracking, monitored stops, and thresholds
- `~/.config/systemd/user/sg-bus-alert.service`
  - long-running daemon (`Type=simple`, `Restart=always`); the old 10-second timer no longer exists
- `.sg-bus-alert.lock`
  - runtime lock file in the project directory
  - stale lock is recovered automatically when the owning process is gone

## Telegram behavior

### Proactive window notification

During a weekday alert window, when any monitored service has a bus within its threshold, the bot sends one message like:

```text
⏰ 晨间出行提醒

🌦️ 今天天气：阵雨
🌡️ 现在 27°C
📈 最高 32°C / 最低 24°C
☔ 降雨概率 78%

────────

🚌 189
📍 金文泰大牌304

第 1 趟：5 分钟
   👥 有座位
   🚍 单层
   🕒 08:42:10

第 2 趟：14 分钟
   👥 可站立
   🚍 双层
   🕒 08:51:02

第 3 趟：26 分钟
   👥 有座位
   🚍 单层
   🕒 09:03:18

⚡ 车快到了，可以准备出发了
🔄 自动刷新中｜更新时间：08:37:00
```

After the first send, no further messages are pushed for that window. The bot silently edits the same message every polling cycle so the ETAs stay current. When the window ends, the footer flips to `⏹ 本时段提醒已结束`. Evening windows use the `⏰ 晚间出行提醒` header. `alert_history` records one row per service per window.

### Settings menu (button-driven)

Configuration is done by tapping buttons, not by typing commands. `⚙️ 设置` (on every status/alert message), the text `设置` / `配置` / `菜单`, or `/settings` opens a menu that is edited in place as you navigate:

```text
⚙️ 设置 ──┬─ 📍 <stop> ──┬─ 🚌 管理线路   → ➕/➖ button per service at that stop
          │              ├─ ⏱ 提醒时间   → pick service → 3/5/6/8/10/12 分钟
          │              ├─ 🕐 提醒时段   → 🌅 只早高峰 / 🌆 只晚高峰 / 🔄 早晚都要
          │              ├─ ✏️ 改名字     → force_reply, just type the new name
          │              └─ 🗑 删除站点   → confirmation step
          ├─ ➕ 添加站点  → share a location / paste a Maps link
          ├─ 🚶 出门提醒  → 2/3/4/5/6/8/10 分钟 or off
          ├─ 🕐 提醒时间段 → pick a window → move its start or end on a
          │                  half-hour grid centred on the current value
          ├─ 📅 生效星期  → toggle each weekday
          ├─ 📊 我的统计  → boarding habits per window + window suggestion
          ├─ 🖥 显示方式  → 自动 / 总是紧凑 / 总是详细
          └─ ❌ 关闭
```

The whole menu lives in one message, so navigating never leaves a trail. Renaming uses `force_reply` and recovers the target stop id from the quoted prompt, so no pending-operation state has to survive a restart.

`/status`, `/settings`, `/boarded`, `/mute` and `/resume` are registered via `setMyCommands`, so they show up in Telegram's command menu.

### Telegram commands

- `状态`
  - show weather summary
  - show current mute status
  - show monitored buses and next 3 arrivals
- `<线路号>`
  - show that monitored service only
- `配置` / `设置` / `菜单`
  - open the button-driven settings menu described above

The text commands below still work, but everything they do is also reachable from the menu:
- `添加线路 190`
  - add a service into current monitored stop config
  - if there are multiple candidate stops, specify the stop explicitly
- `删除线路 963`
  - remove a monitored service
- `阈值 189 6`
  - set per-service proactive reminder threshold to 6 minutes
- `步行 5` / `步行 17379 6` / `步行 关`
  - configure walk-to-stop minutes (default / per stop / off); enables one "leave now" push per service per window when a bus ETA enters the `[walk, walk+2]` minute band
- `设置时段 17051 晚`
  - limit a stop to the morning (`早`) or evening (`晚`) window; `全部` resets it
- `重命名 17379 家门口`
  - rename a monitored stop (stops added from a map get their English dataset name)

### Adding a stop from a map

Looking up a five-digit stop code is the annoying part, so the bot accepts a place instead:

- a native Telegram location share (📎 → Location) — the most reliable route
- a pasted Google Maps link (`maps.app.goo.gl` short links are resolved by following redirects; only Google's own hosts are ever fetched)
- raw `lat,lng` text, e.g. `1.32049,103.76389`

The bot answers with the bus stops within 800m, ranked by distance, each with an inline button. Tapping one adds the stop and immediately lists the services currently calling there, each with its own button — so a stop and its routes can be added without typing a single ID.

Stop coordinates come from `https://data.busrouter.sg/v1/stops.min.json` (5205 stops), cached in `stops-cache.json` for 30 days.
- `上车了`
  - mute the current (or next upcoming) alert window for today; other windows still fire
- `暂停`
  - mute all proactive reminders for the rest of the current Singapore day
- `恢复`
  - clear today's mutes (both kinds); a still-active window notice resumes refreshing

Inline buttons keep the existing quick actions, while service buttons are generated from the current monitored services.

### Mute behavior

- `暂停` stores `mutedUntilDateKey` (whole-day mute)
- `上车了` stores a `mutedWindowKeys` entry like `2026-07-29|08:30` (single-window mute)
- Mute only affects proactive window notifications
- Manual queries like `状态` still work while muted
- Both mute kinds reset automatically on the next Singapore date

## Runtime state store

Primary runtime state is stored in `state.db`.

Stored fields include:

- `telegramUpdateOffset`
  - last consumed Telegram update id plus one
- `mutedUntilDateKey`
  - optional whole-day mute marker in Singapore date format
- `mutedWindowKeys`
  - optional list of muted window occurrences, e.g. `["2026-07-29|08:30"]`
- `windowNotices`
  - per-window notice tracking: Telegram `messageId`, `lastText`, cached `weatherSummary`, `loggedServices`, `finalized`
  - this is what guarantees at most one proactive message per window
- `monitoredStops`
  - optional runtime override of monitored stops/services; each stop may carry a `periods` array (`["早"]` / `["晚"]`) restricting it to one window
- `serviceThresholdMinutes`
  - optional per-service threshold overrides
- `walkMinutesDefault` / `walkMinutesByStop`
  - walk-time config driving the departure pings
- `departurePings`
  - per-window record of services already pinged (max one push per service per window)
- `failureStreak`
  - consecutive failed daemon cycles, used for the self-diagnosis alert
- `alertWindowsOverride`
  - alert windows edited from the menu; takes precedence over the `.env` values and applies on the next cycle without a restart
- `activeWeekdays`
  - which weekdays the windows run on, default Mon–Fri
- `displayMode`
  - `compact` / `detailed`; absent means auto
- `departureSnooze`
  - per-service snooze deadlines for departure pings

Two extra SQLite tables: `alert_history` (one row per service per window) and `boarding_log` (one row per 🛑 我上车了 press, feeding 📊 我的统计).

Example:

```json
{
  "telegramUpdateOffset": 858834610,
  "mutedWindowKeys": ["2026-07-29|08:30"],
  "windowNotices": {
    "2026-07-29|08:30": {
      "messageId": 2210,
      "finalized": true
    }
  }
}
```

## API usage

### 1. Bus stop metadata

Used to identify bus stop codes and names.

Source:

- `https://data.busrouter.sg/v1/stops.min.json`

Example:

```bash
curl -fsSL 'https://data.busrouter.sg/v1/stops.min.json'
```

Relevant entries used in this project:

- `17379` = `Blk 304`, road `Clementi Ave 6`
- `17051` = `Opp Regent Pk`, road `Clementi Ave 6`

This dataset now backs the "add a stop from a map" flow: it is downloaded on first use, cached in `stops-cache.json` for 30 days, and searched locally to rank stops by distance. Runtime status queries still do not depend on it.

### 2. Live bus arrivals

Primary runtime source for bus arrivals.

Source:

- `https://arrivelah2.busrouter.sg/?id=<BUS_STOP_CODE>`

Examples:

```bash
curl -fsSL 'https://arrivelah2.busrouter.sg/?id=17379'
curl -fsSL 'https://arrivelah2.busrouter.sg/?id=17051'
```

Important response fields:

- `services[].no`
  - bus service number
- `services[].next`
  - next bus
- `services[].subsequent`
  - second bus
- `services[].next3`
  - third bus
- `duration_ms`
  - milliseconds until arrival
- `time`
  - ISO timestamp for arrival
- `load`
  - `SEA`, `SDA`, `LSD`
- `type`
  - `SD`, `DD`, `BD`

Runtime interpretation in this project:

- Proactive alert trigger checks `next` and `subsequent` against threshold minutes
- Status queries display `next`, `subsequent`, and `next3`

### 3. Weather

Weather summary for current day.

Source:

- `https://api.open-meteo.com/v1/forecast`

Requested params:

- `latitude`
- `longitude`
- `timezone`
- `current=temperature_2m,weather_code`
- `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
- `forecast_days=1`

Example:

```bash
curl -fsSL 'https://api.open-meteo.com/v1/forecast?latitude=1.3179&longitude=103.7631&timezone=Asia%2FSingapore&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1'
```

Additionally, a 2-hour nowcast for the configured area comes from data.gov.sg:

```bash
curl -fsSL 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'
```

Important implementation details:

- Node `fetch()` to Open-Meteo failed on this machine in some cases
- the script now falls back to `curl -fsSL` for weather if `fetch()` fails
- both weather sources are cached for 10 minutes and are strictly best-effort

### 4. Telegram Bot API

Used for bot commands and message sending.

Endpoints used:

- `getUpdates`
- `sendMessage`

Examples:

```bash
curl -fsSL "https://api.telegram.org/bot<token>/getUpdates"
curl -fsSL -X POST "https://api.telegram.org/bot<token>/sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<chat_id>","text":"hello"}'
```

Important implementation detail:

- `api.telegram.org` publishes an AAAA record that this network cannot reach; Node's `fetch` does not fall back to IPv4 the way `curl` does, which showed up as recurring `fetch failed (ETIMEDOUT)` cycles. `index.mjs` calls `dns.setDefaultResultOrder("ipv4first")` at startup to avoid it — keep that line.
- this project uses long polling via `getUpdates` (20s idle, 5s during alert windows)
- no webhook is configured
- proactive checks tick roughly every 10 seconds during alert windows
- a second instance exits cleanly thanks to the lock file, so `getUpdates` is never polled twice

## Environment variables

Current config keys:

- `BUS_ALERT_TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TIMEZONE`
- `ALERT_WINDOWS`
  - comma-separated windows, e.g. `08:30-09:30,17:30-18:30`
- `ALERT_WINDOW_START` / `ALERT_WINDOW_END`
  - legacy single-window keys, merged into the window list
- `EVENING_WINDOW_START` / `EVENING_WINDOW_END`
  - legacy evening-window keys, merged into the window list
- `ALERT_THRESHOLD_MINUTES`
- `COOLDOWN_MINUTES`
  - obsolete since the one-message-per-window redesign; ignored
- `ARRIVAL_API_BASE`
- `WEATHER_LATITUDE`
- `WEATHER_LONGITUDE`
- `WEATHER_NOWCAST_AREA`
  - data.gov.sg forecast area name, default `Clementi`
- `PUBLIC_HOLIDAYS`
  - optional comma-separated `YYYY-MM-DD` dates appended to the built-in Singapore holiday table (`DEFAULT_SG_PUBLIC_HOLIDAYS` in `index.mjs`, refresh yearly)
- `FAILURE_ALERT_AFTER`
  - consecutive failed cycles before the self-diagnosis warning, default `30`
- `RAIN_EXTRA_MINUTES`
  - extra alert threshold when the nowcast says rain, default `3`
- `STATE_FILE`
  - legacy JSON migration source path; corresponding `.db` path is used as the primary runtime store
- `STOP_CONFIG_JSON`

Example monitored stop config:

```json
[
  {
    "stop_id": "17379",
    "stop_name": "金文泰大牌304",
    "services": ["189"]
  },
  {
    "stop_id": "17051",
    "stop_name": "丽晶园对面",
    "services": ["963"]
  }
]
```

## Commands for local operation

Check the daemon:

```bash
systemctl --user status sg-bus-alert.service --no-pager
```

Check logs:

```bash
journalctl --user -u sg-bus-alert.service -n 50 --no-pager
```

Restart the daemon (required after editing `.env`):

```bash
systemctl --user restart sg-bus-alert.service
```

Run a single debug cycle (stop the daemon first, otherwise the lock makes this exit immediately):

```bash
node index.mjs once
```

Send test message:

```bash
node index.mjs test
```

## Implementation notes for future AI agents

- This project is intentionally dependency-free.
- Do not introduce npm packages unless there is a strong reason.
- Preserve the current Telegram command set unless the user asks to change it.
- Preserve mute semantics:
  - `上车了` mutes only the current/upcoming window today
  - `暂停` mutes the whole day
  - `恢复` clears both; manual status queries always work
- Each alert window sends exactly one proactive message and then edits it in place; do not reintroduce repeated sends.
- Query responses and proactive responses use different headers but share the same 3-arrival layout.
- Weather is best-effort and should not break bus status replies if the weather API fails.
- This machine already has working user-level `systemd` with lingering enabled.
- The bot is a long-lived daemon using Telegram long polling; webhooks and the old 10-second timer are both intentionally not used.
- `.env` is read once at startup — restart the service after config changes.
- The runtime lock guarantees a second instance (e.g. a manual `node index.mjs`) exits cleanly instead of double-polling Telegram.
- State is persisted only when it changes, so the SQLite file is not rewritten on idle cycles.

## Security note

The current bot token was exposed during setup in chat history. Rotate it in `@BotFather` and update `.env` if you want to harden this deployment.
