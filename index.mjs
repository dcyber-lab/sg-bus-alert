#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const ENV_PATH = path.join(process.cwd(), ".env");
const execFileAsync = promisify(execFile);

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }
  return env;
}

async function loadEnv() {
  let fileEnv = {};
  try {
    const text = await fs.readFile(ENV_PATH, "utf8");
    fileEnv = parseEnvFile(text);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    ...fileEnv,
    ...process.env,
  };
}

function required(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}

function getMinuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid HH:MM time: ${value}`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function getLocalParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function isWithinWindow(date, timeZone, start, end) {
  const { weekday, hour, minute } = getLocalParts(date, timeZone);
  const weekdays = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  if (!weekdays.has(weekday)) {
    return false;
  }

  const currentMinute = hour * 60 + minute;
  return currentMinute >= getMinuteOfDay(start) && currentMinute <= getMinuteOfDay(end);
}

function loadLabel(code) {
  switch (code) {
    case "SEA":
      return "有座位";
    case "SDA":
      return "可站立";
    case "LSD":
      return "较拥挤";
    default:
      return code || "Unknown";
  }
}

function vehicleTypeLabel(code) {
  switch (code) {
    case "SD":
      return "单层";
    case "DD":
      return "双层";
    case "BD":
      return "铰接巴士";
    default:
      return code || "Unknown";
  }
}

function minutesLabel(durationMs) {
  const minutes = Math.max(0, Math.ceil(durationMs / 60000));
  if (minutes === 0) {
    return "即将到站";
  }
  if (minutes === 1) {
    return "1 分钟";
  }
  return `${minutes} 分钟`;
}

function formatArrivalClock(isoString, timeZone) {
  if (!isoString) {
    return "";
  }

  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return formatter.format(new Date(isoString));
}

function formatDateKey(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

function weatherCodeLabel(code) {
  const mapping = {
    0: "晴",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴",
    45: "有雾",
    48: "浓雾",
    51: "毛毛雨",
    53: "小雨",
    55: "中雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴冰雹",
    99: "强雷暴伴冰雹",
  };

  return mapping[code] || "天气未知";
}

async function fetchWeather(weatherConfig) {
  const params = new URLSearchParams({
    latitude: weatherConfig.latitude,
    longitude: weatherConfig.longitude,
    timezone: weatherConfig.timezone,
    current: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "1",
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  try {
    return await fetchJson(url);
  } catch (error) {
    const { stdout } = await execFileAsync("curl", ["-fsSL", url], {
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  }
}

function buildWeatherMessage(weather) {
  if (!weather || !weather.current || !weather.daily) {
    return null;
  }

  const current = weather.current;
  const daily = weather.daily;
  const maxTemp = daily.temperature_2m_max?.[0];
  const minTemp = daily.temperature_2m_min?.[0];
  const rainChance = daily.precipitation_probability_max?.[0];
  const code = current.weather_code ?? daily.weather_code?.[0];

  return [
    `🌦️ 今天天气：${weatherCodeLabel(code)}`,
    `🌡️ 现在 ${Math.round(current.temperature_2m)}°C`,
    `📈 最高 ${Math.round(maxTemp)}°C / 最低 ${Math.round(minTemp)}°C`,
    `☔ 降雨概率 ${rainChance}%`,
  ].join("\n");
}

async function readState(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed) {
      return parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return { alerts: {} };
}

async function writeState(filePath, state) {
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "sg-bus-alert/1.0",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchArrivals(apiBase, stopId) {
  return fetchJson(`${apiBase}/?id=${encodeURIComponent(stopId)}`);
}

async function sendTelegram(token, chatId, text) {
  return sendTelegramMessage(token, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendTelegramMessage(token, payload) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${response.statusText} ${body}`);
  }
}

async function fetchTelegramUpdates(token, offset) {
  const params = new URLSearchParams({ timeout: "0" });
  if (typeof offset === "number") {
    params.set("offset", String(offset));
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram getUpdates failed: ${response.status} ${response.statusText} ${body}`);
  }

  const json = await response.json();
  return json.result || [];
}

function flattenStopServices(stops) {
  const rows = [];
  for (const stop of stops) {
    for (const serviceNo of stop.services || []) {
      rows.push({ stop, serviceNo });
    }
  }
  return rows;
}

function buildArrivalSlot(label, arrival, timeZone) {
  if (!arrival || typeof arrival.duration_ms !== "number" || !arrival.time) {
    return `${label}：暂无数据`;
  }

  return [
    `${label}：${minutesLabel(arrival.duration_ms)}`,
    `   👥 ${loadLabel(arrival.load)}`,
    `   🚍 ${vehicleTypeLabel(arrival.type)}`,
    `   🕒 ${formatArrivalClock(arrival.time, timeZone)}`,
  ].join("\n");
}

function buildStatusLine(stopName, serviceNo, arrivals, timeZone) {
  const lines = [
    `🚌 ${serviceNo}`,
    `📍 ${stopName}`,
    ``,
    buildArrivalSlot("第 1 趟", arrivals[0], timeZone),
    ``,
    buildArrivalSlot("第 2 趟", arrivals[1], timeZone),
    ``,
    buildArrivalSlot("第 3 趟", arrivals[2], timeZone),
  ];

  return lines.join("\n");
}

function buildStatusMessage(items, timeZone, weatherSummary = null, muteStatus = null) {
  const lines = ["🚏 当前公交状态", ""];

  if (muteStatus) {
    lines.push(muteStatus);
    lines.push("");
    lines.push("────────");
    lines.push("");
  }

  if (weatherSummary) {
    lines.push(weatherSummary);
    lines.push("");
    lines.push("────────");
    lines.push("");
  }

  items.forEach((item, index) => {
    lines.push(buildStatusLine(item.stop.stop_name, item.serviceNo, item.arrivals, timeZone));
    if (index !== items.length - 1) {
      lines.push("");
      lines.push("────────");
      lines.push("");
    }
  });

  lines.push("");
  lines.push(`更新时间：${formatArrivalClock(new Date().toISOString(), timeZone)}`);
  lines.push(`可发送：状态 / 189 / 963 / 上车了 / 暂停 / 恢复`);
  return lines.join("\n");
}

function buildMorningAlertMessage(items, timeZone, weatherSummary = null) {
  const lines = ["⏰ 晨间通知", ""];

  if (weatherSummary) {
    lines.push(weatherSummary);
    lines.push("");
    lines.push("────────");
    lines.push("");
  }

  items.forEach((item, index) => {
    lines.push(buildStatusLine(item.stop.stop_name, item.serviceNo, item.arrivals, timeZone));
    if (index !== items.length - 1) {
      lines.push("");
      lines.push("────────");
      lines.push("");
    }
  });

  lines.push("");
  lines.push("⚡ 可以准备出门了");
  lines.push(`更新时间：${formatArrivalClock(new Date().toISOString(), timeZone)}`);
  return lines.join("\n");
}

function selectArrival(service, maxMinutes) {
  const candidates = [service.next, service.subsequent].filter(Boolean);
  if (candidates.length === 0) {
    return null;
  }

  const eligible = candidates
    .filter((arrival) => typeof arrival.duration_ms === "number")
    .filter((arrival) => arrival.duration_ms <= maxMinutes * 60 * 1000)
    .sort((a, b) => a.duration_ms - b.duration_ms);

  return eligible[0] || null;
}

function cleanupState(state, nowIso) {
  const cutoff = new Date(nowIso).getTime() - 12 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(state.alerts || {})) {
    if (!value.lastSentAt) {
      delete state.alerts[key];
      continue;
    }

    if (new Date(value.lastSentAt).getTime() < cutoff) {
      delete state.alerts[key];
    }
  }

  if (state.mutedUntilDateKey && state.mutedUntilDateKey < formatDateKey(new Date(nowIso), "Asia/Singapore")) {
    delete state.mutedUntilDateKey;
  }
}

async function fetchCurrentStatuses(apiBase, stops, timeZone, requestedServices = null) {
  const rows = flattenStopServices(stops);
  const filteredRows = requestedServices
    ? rows.filter((row) => requestedServices.has(row.serviceNo))
    : rows;
  const cache = new Map();
  const items = [];

  for (const row of filteredRows) {
    if (!cache.has(row.stop.stop_id)) {
      cache.set(row.stop.stop_id, await fetchArrivals(apiBase, row.stop.stop_id));
    }

    const arrivalData = cache.get(row.stop.stop_id);
    const services = arrivalData.services || [];
    const service = services.find((item) => item.no === row.serviceNo);
    const arrivals = service
      ? [service.next, service.subsequent, service.next3].filter((arrival) => arrival || arrival === null)
      : [];

    items.push({
      stop: row.stop,
      serviceNo: row.serviceNo,
      arrivals,
    });
  }

  return items;
}

async function processTelegramCommands(token, chatId, state, apiBase, stops, timeZone, weatherConfig) {
  const offset =
    typeof state.telegramUpdateOffset === "number" ? state.telegramUpdateOffset : undefined;
  const updates = await fetchTelegramUpdates(token, offset);

  for (const update of updates) {
    state.telegramUpdateOffset = update.update_id + 1;

    const message = update.message;
    if (!message || !message.chat || String(message.chat.id) !== String(chatId)) {
      continue;
    }

    const text = (message.text || "").trim();
    if (!text) {
      continue;
    }

    let requestedServices = null;
    const todayKey = formatDateKey(new Date(), timeZone);

    if (text === "上车了" || text === "暂停") {
      state.mutedUntilDateKey = todayKey;
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "🔕 今天的主动提醒已暂停。\n如需恢复，请发送：恢复",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
      });
      continue;
    } else if (text === "恢复") {
      delete state.mutedUntilDateKey;
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "🔔 今天的主动提醒已恢复。",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
      });
      continue;
    } else if (text === "状态" || text.toLowerCase() === "status") {
      requestedServices = null;
    } else if (/^\d+$/.test(text)) {
      requestedServices = new Set([text]);
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "可用命令：\n状态\n189\n963",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
      });
      continue;
    }

    const statuses = await fetchCurrentStatuses(apiBase, stops, timeZone, requestedServices);
    if (statuses.length === 0) {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "没有匹配到你查询的线路。",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
      });
      continue;
    }

    let weatherSummary = null;
    try {
      const weather = await fetchWeather(weatherConfig);
      weatherSummary = buildWeatherMessage(weather);
    } catch (error) {
      weatherSummary = null;
    }

    const muteStatus =
      state.mutedUntilDateKey === todayKey
        ? "🔕 今天的主动提醒：已暂停"
        : "🔔 今天的主动提醒：开启中";

    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: buildStatusMessage(statuses, timeZone, weatherSummary, muteStatus),
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    });
  }
}

async function main() {
  const env = await loadEnv();
  const mode = process.argv[2] || "run";

  const timeZone = env.TIMEZONE || "Asia/Singapore";
  const windowStart = env.ALERT_WINDOW_START || "08:30";
  const windowEnd = env.ALERT_WINDOW_END || "09:30";
  const maxMinutes = Number(env.ALERT_THRESHOLD_MINUTES || "8");
  const cooldownMinutes = Number(env.COOLDOWN_MINUTES || "3");
  const apiBase = env.ARRIVAL_API_BASE || "https://arrivelah2.busrouter.sg";
  const weatherConfig = {
    latitude: env.WEATHER_LATITUDE || "1.3179",
    longitude: env.WEATHER_LONGITUDE || "103.7631",
    timezone: timeZone,
  };
  const stateFile = path.resolve(process.cwd(), env.STATE_FILE || "./state.json");
  const stops = JSON.parse(required(env, "STOP_CONFIG_JSON"));

  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("STOP_CONFIG_JSON must be a non-empty JSON array");
  }

  if (mode === "test") {
    const token = required(env, "TELEGRAM_BOT_TOKEN");
    const chatId = required(env, "TELEGRAM_CHAT_ID");
    await sendTelegram(token, chatId, "✅ 测试消息\nTelegram 机器人配置正常。");
    console.log("Sent Telegram test message.");
    return;
  }

  const now = new Date();
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_CHAT_ID");
  const state = await readState(stateFile);
  cleanupState(state, now.toISOString());
  await processTelegramCommands(token, chatId, state, apiBase, stops, timeZone, weatherConfig);
  const todayKey = formatDateKey(now, timeZone);

  if (!isWithinWindow(now, timeZone, windowStart, windowEnd)) {
    await writeState(stateFile, state);
    console.log("Outside configured alert window.");
    return;
  }

  const pendingAlerts = [];

  for (const stop of stops) {
    const arrivalData = await fetchArrivals(apiBase, stop.stop_id);
    const services = arrivalData.services || [];

    for (const serviceNo of stop.services || []) {
      const service = services.find((item) => item.no === serviceNo);
      if (!service) {
        continue;
      }

      const selectedArrival = selectArrival(service, maxMinutes);
      if (!selectedArrival || !selectedArrival.time) {
        continue;
      }

      const key = `${stop.stop_id}:${serviceNo}`;
      const record = state.alerts[key] || {};
      const cooldownMs = cooldownMinutes * 60 * 1000;
      const sentRecently =
        record.lastSentAt &&
        now.getTime() - new Date(record.lastSentAt).getTime() < cooldownMs;
      const sameArrival = record.lastArrivalTime === selectedArrival.time;

      if (sameArrival || sentRecently) {
        continue;
      }

      pendingAlerts.push({
        stop,
        serviceNo,
        arrivals: [service.next, service.subsequent, service.next3],
        selectedArrival,
        stateKey: key,
      });
    }
  }

  if (pendingAlerts.length > 0 && state.mutedUntilDateKey !== todayKey) {
    let weatherSummary = null;
    try {
      const weather = await fetchWeather(weatherConfig);
      weatherSummary = buildWeatherMessage(weather);
    } catch (error) {
      weatherSummary = null;
    }

    await sendTelegram(
      token,
      chatId,
      buildMorningAlertMessage(pendingAlerts, timeZone, weatherSummary),
    );

    for (const alert of pendingAlerts) {
      state.alerts[alert.stateKey] = {
        lastArrivalTime: alert.selectedArrival.time,
        lastSentAt: now.toISOString(),
      };
      console.log(`Alert sent for stop ${alert.stop.stop_id} service ${alert.serviceNo}.`);
    }
  }

  await writeState(stateFile, state);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
