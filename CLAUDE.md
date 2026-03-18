# Claude Project Memory

Start with `README.md`.

This is a small local automation project for Singapore bus alerts on Telegram.

## Current scope

- Monitor:
  - `189` at `17379` `金文泰大牌304`
  - `963` at `17051` `丽晶园对面`
- Show weather in status and morning reminder
- Show next 3 arrivals
- Support same-day mute after the user boards

## Architecture

- `index.mjs`: all runtime logic
- `.env`: local config
- `state.json`: dedupe, Telegram offset, mute state
- `systemd --user` timer drives polling

## User expectations

- Telegram text should stay readable on mobile
- Morning reminder should be concise but complete
- Manual query should still work even when muted

## Risk areas

- Do not break `telegramUpdateOffset`
- Do not break `mutedUntilDateKey`
- Weather failures should not break bus replies
