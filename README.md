# sg-bus-alert

Singapore weekday morning bus alerts for Telegram.

This project runs on `/home/minipc/sg-bus-alert` and uses a single Node.js script plus `systemd --user` timer scheduling.

## What it does

- Monitors selected Singapore bus stops and bus services.
- Sends proactive Telegram morning notifications on weekdays from `08:30` to `09:30` in `Asia/Singapore`.
- Morning notification is merged into a single message when multiple monitored services hit the threshold in the same run.
- Morning notification includes:
  - weather summary
  - the next 3 buses for each triggered service
  - current ETA, load, vehicle type, and arrival clock time
- Supports Telegram chat commands for on-demand status lookup.
- Supports same-day mute after boarding the bus.

## Current live configuration

- Bus stop `17379` -> `金文泰大牌304` -> service `189`
- Bus stop `17051` -> `丽晶园对面` -> service `963`
- Timezone: `Asia/Singapore`
- Alert window: `08:30-09:30`
- Threshold: `8` minutes
- Cooldown: `3` minutes
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
- `state.json`
  - runtime state
  - dedupe state for sent alerts
  - Telegram update offset
  - same-day mute state
- `~/.config/systemd/user/sg-bus-alert.service`
  - runs the script once
- `~/.config/systemd/user/sg-bus-alert.timer`
  - runs the service every 10 seconds

## Telegram behavior

### Proactive morning notification

During weekday morning window, if a monitored service has a next bus within the configured threshold, the bot sends one merged message like:

```text
⏰ 晨间通知

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

⚡ 可以准备出门了
更新时间：08:37:00
```

### Telegram commands

- `状态`
  - show weather summary
  - show current mute status
  - show monitored buses and next 3 arrivals
- `配置`
  - show current monitored stops, services, and effective thresholds
- `189`
  - show service `189` only
- `963`
  - show service `963` only
- `添加线路 190`
  - add a service into current monitored stop config
  - if there are multiple candidate stops, specify the stop explicitly
- `删除线路 963`
  - remove a monitored service
- `阈值 189 6`
  - set per-service proactive reminder threshold to 6 minutes
- `上车了`
  - mute proactive reminders for the rest of the current Singapore day
- `暂停`
  - same as `上车了`
- `恢复`
  - resume proactive reminders for the current day

### Mute behavior

- Mute is stored in `state.json` as `mutedUntilDateKey`
- Mute only affects proactive morning reminders
- Manual queries like `状态` still work while muted
- Mute resets automatically on the next Singapore date

## Runtime state file

`state.json` currently stores:

- `alerts`
  - dedupe state per `stop_id:service_no`
  - remembers `lastArrivalTime`
  - remembers `lastSentAt`
- `telegramUpdateOffset`
  - last consumed Telegram update id plus one
- `mutedUntilDateKey`
  - optional same-day mute marker in Singapore date format
- `monitoredStops`
  - optional runtime override of monitored stops/services
- `serviceThresholdMinutes`
  - optional per-service threshold overrides

Example:

```json
{
  "alerts": {
    "17379:189": {
      "lastArrivalTime": "2026-03-19T08:42:10+08:00",
      "lastSentAt": "2026-03-19T08:37:00.000Z"
    }
  },
  "telegramUpdateOffset": 858834610,
  "mutedUntilDateKey": "2026-03-19"
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

## Environment variables

Current config keys:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TIMEZONE`
- `ALERT_WINDOW_START`
- `ALERT_WINDOW_END`
- `ALERT_THRESHOLD_MINUTES`
- `COOLDOWN_MINUTES`
- `ARRIVAL_API_BASE`
- `WEATHER_LATITUDE`
- `WEATHER_LONGITUDE`
- `STATE_FILE`
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
- Preserve same-day mute semantics:
  - `上车了` and `暂停` mute proactive notifications only
  - `恢复` re-enables them
  - manual status queries still work
- Morning proactive notifications are merged into one message.
- Query responses and proactive responses use different headers but share the same 3-arrival layout.
- Weather is best-effort and should not break bus status replies if the weather API fails.
- This machine already has working user-level `systemd`.
- Polling is intentionally timer-based, not webhook-based.

## Security note

The current bot token was exposed during setup in chat history. Rotate it in `@BotFather` and update `.env` if you want to harden this deployment.
