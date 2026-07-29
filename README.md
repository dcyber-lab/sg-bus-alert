# sg-bus-alert

Singapore weekday morning bus alerts for Telegram.

This project runs on `/home/minipc/sg-bus-alert` and uses a single Node.js script plus `systemd --user` timer scheduling.

## What it does

- Monitors selected Singapore bus stops and bus services.
- Sends proactive Telegram notifications on weekdays during configured windows (currently `08:30-09:30` and `17:30-18:30` in `Asia/Singapore`).
- Each window sends exactly one notification message; afterwards the bot edits that same message in place on every polling cycle, so ETAs stay fresh without repeated pushes.
- The window notification includes:
  - weather summary
  - the next 3 buses for every monitored service
  - current ETA, load, vehicle type, and arrival clock time
- Supports Telegram chat commands for on-demand status lookup.
- Supports boarding mute (`上车了`, current window only) and whole-day mute (`暂停`).
- Uses a lock file so overlapping timer runs do not process state concurrently.
- All outbound HTTP calls carry a 15s timeout; a hung run is killed by systemd after 90s (`TimeoutStartSec`).
- Reuses bus-arrival and weather data within a single execution cycle.

## Current live configuration

- Bus stop `17379` -> `金文泰大牌304` -> service `189`
- Bus stop `17051` -> `丽晶园对面` -> service `963`
- Timezone: `Asia/Singapore`
- Alert windows: `08:30-09:30` and `17:30-18:30`
- Threshold: `8` minutes
- Telegram bot: `@sg_bus_alert_bot`

## Main files

- `index.mjs`
  - all runtime logic
  - Telegram command handling
  - bus arrival fetching
  - weather fetching
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
  - runs the script once, killed after 90s if it hangs
- `~/.config/systemd/user/sg-bus-alert.timer`
  - runs the service every 10 seconds
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

### Telegram commands

- `状态`
  - show weather summary
  - show current mute status
  - show monitored buses and next 3 arrivals
- `<线路号>`
  - show that monitored service only
- `配置`
  - show current monitored stops, services, and effective thresholds
- `添加线路 190`
  - add a service into current monitored stop config
  - if there are multiple candidate stops, specify the stop explicitly
- `删除线路 963`
  - remove a monitored service
- `阈值 189 6`
  - set per-service proactive reminder threshold to 6 minutes
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
  - optional runtime override of monitored stops/services
- `serviceThresholdMinutes`
  - optional per-service threshold overrides

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

This dataset was used as reference during setup. Runtime status queries do not depend on it.

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

Important implementation detail:

- Node `fetch()` to Open-Meteo failed on this machine in some cases
- the script now falls back to `curl -fsSL` for weather if `fetch()` fails

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

- this project uses polling via `getUpdates`
- no webhook is configured
- polling frequency is controlled by the `systemd` timer, currently every 10 seconds
- overlapping timer runs are skipped cleanly by the lock file

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

Run one cycle:

```bash
cd /home/minipc/sg-bus-alert
node index.mjs
```

Send test message:

```bash
cd /home/minipc/sg-bus-alert
node index.mjs test
```

Check timer:

```bash
systemctl --user status sg-bus-alert.timer --no-pager
```

Check service:

```bash
systemctl --user status sg-bus-alert.service --no-pager
```

Check logs:

```bash
journalctl --user -u sg-bus-alert.service -n 50 --no-pager
```

Restart timer:

```bash
systemctl --user daemon-reload
systemctl --user restart sg-bus-alert.timer
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
- This machine already has working user-level `systemd`.
- Polling is intentionally timer-based, not webhook-based.
- Overlapping timer invocations should be prevented with the runtime lock rather than by assuming the timer never overlaps.

## Security note

The current bot token was exposed during setup in chat history. Rotate it in `@BotFather` and update `.env` if you want to harden this deployment.
