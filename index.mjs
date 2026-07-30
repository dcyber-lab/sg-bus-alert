#!/usr/bin/env node

import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  acquireRunLock,
  buildAvailableCommandsHint,
  buildHelpMessage,
  buildTelegramButtons,
  parseAlertWindows,
  parseDateKeySet,
  parseServiceCallbackData,
  pickBoardedWindow,
  pickDepartureCandidate,
  releaseRunLock,
  stopsForPeriod,
  windowKeyFor,
  windowPeriodKey,
  windowPeriodLabel,
} from "./lib/runtime-helpers.mjs";
import {
  logAlertToHistory as logAlertToHistoryFromStore,
  readState as readStateFromStore,
  writeState as writeStateFromStore,
} from "./lib/state-store.mjs";

const ENV_PATH = path.join(process.cwd(), ".env");
const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 15 * 1000;
const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_RETRY_MS = 60 * 1000;
const PROACTIVE_TICK_MS = 9 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;

// MOM-announced Singapore public holidays; refresh once a year, extend via PUBLIC_HOLIDAYS env.
const DEFAULT_SG_PUBLIC_HOLIDAYS = [
  "2026-01-01",
  "2026-02-17",
  "2026-02-18",
  "2026-03-21",
  "2026-04-03",
  "2026-05-01",
  "2026-05-27",
  "2026-05-31",
  "2026-06-01",
  "2026-08-09",
  "2026-08-10",
  "2026-11-08",
  "2026-11-09",
  "2026-12-25",
];

const NOWCAST_LABELS = {
  "Fair (Day)": "晴好",
  "Fair (Night)": "晴好",
  "Fair & Warm": "晴热",
  "Partly Cloudy (Day)": "局部多云",
  "Partly Cloudy (Night)": "局部多云",
  Cloudy: "多云",
  Overcast: "阴",
  Drizzle: "毛毛雨",
  "Light Rain": "小雨",
  "Moderate Rain": "中雨",
  "Heavy Rain": "大雨",
  "Passing Showers": "短暂阵雨",
  "Light Showers": "小阵雨",
  Showers: "阵雨",
  "Heavy Showers": "强阵雨",
  "Thundery Showers": "雷阵雨",
  "Heavy Thundery Showers": "强雷阵雨",
  "Heavy Thundery Showers with Gusty Winds": "强雷阵雨伴阵风",
  Hazy: "有霾",
  "Slightly Hazy": "轻霾",
  Windy: "有风",
  Mist: "薄雾",
  Fog: "有雾",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logInfo(message) {
  console.log(`[sg-bus-alert] ${message}`);
}

function isIgnorableTelegramError(message) {
  return (
    message.includes("query is too old") ||
    message.includes("query ID is invalid") ||
    message.includes("message is not modified")
  );
}

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

function cloneStops(stops) {
  return JSON.parse(JSON.stringify(stops));
}

function loadEffectiveStops(state, defaultStops) {
  if (Array.isArray(state.monitoredStops)) {
    return cloneStops(state.monitoredStops);
  }
  return cloneStops(defaultStops);
}

function getServiceThresholdMinutes(state, envDefaultMinutes, serviceNo) {
  const overrides = state.serviceThresholdMinutes || {};
  const override = overrides[serviceNo];
  if (typeof override === "number" && Number.isFinite(override)) {
    return override;
  }
  return envDefaultMinutes;
}

function getMutedWindowKeys(state) {
  return Array.isArray(state.mutedWindowKeys) ? state.mutedWindowKeys : [];
}

function isDayMuted(state, dateKey) {
  return state.mutedUntilDateKey === dateKey;
}

function addMutedWindowKey(state, key) {
  state.mutedWindowKeys = Array.from(new Set([...getMutedWindowKeys(state), key])).sort();
}

function getWindowNotices(state) {
  if (
    !state.windowNotices ||
    typeof state.windowNotices !== "object" ||
    Array.isArray(state.windowNotices)
  ) {
    state.windowNotices = {};
  }
  return state.windowNotices;
}

function findActiveWindow(now, timeZone, windows) {
  return windows.find((window) => isWithinWindow(now, timeZone, window.start, window.end)) || null;
}

function isProactiveMutedNow(state, timeZone, windows) {
  const now = new Date();
  const dateKey = formatDateKey(now, timeZone);
  if (isDayMuted(state, dateKey)) {
    return true;
  }
  const activeWindow = findActiveWindow(now, timeZone, windows);
  return Boolean(
    activeWindow && getMutedWindowKeys(state).includes(windowKeyFor(dateKey, activeWindow)),
  );
}

function describeMuteStatus(state, todayKey, windows) {
  if (isDayMuted(state, todayKey)) {
    return "🔕 主动提醒：今天已全部暂停";
  }

  const mutedStarts = getMutedWindowKeys(state)
    .filter((key) => key.startsWith(`${todayKey}|`))
    .map((key) => key.slice(todayKey.length + 1));
  if (mutedStarts.length > 0) {
    const labels = mutedStarts.map((start) => {
      const window = windows.find((item) => item.start === start);
      return window ? `${window.start}-${window.end}` : start;
    });
    return `🔕 主动提醒：今天 ${labels.join("、")} 时段已静音`;
  }

  return "🔔 主动提醒：开启中";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidStopId(value) {
  return /^\d{5}$/.test(String(value || "").trim());
}

function isValidServiceNo(value) {
  return /^[A-Za-z0-9]{1,8}$/.test(String(value || "").trim());
}

function isValidStopName(value) {
  const normalized = String(value || "").trim();
  return normalized.length > 0 && normalized.length <= 80 && !/[\r\n]/.test(normalized);
}

function findStopByIdentifier(stops, identifier) {
  const query = normalizeText(identifier);
  return (
    stops.find((stop) => normalizeText(stop.stop_id) === query) ||
    stops.find((stop) => normalizeText(stop.stop_name) === query)
  );
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
    const { stdout } = await execFileAsync("curl", ["-fsSL", "-m", "10", url], {
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "sg-bus-alert/1.0",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchArrivals(apiBase, stopId) {
  return fetchJson(`${apiBase}/?id=${encodeURIComponent(stopId)}`);
}

async function fetchArrivalsCached(apiBase, stopId, runCache) {
  if (!runCache.arrivals.has(stopId)) {
    runCache.arrivals.set(stopId, fetchArrivals(apiBase, stopId));
  }
  return runCache.arrivals.get(stopId);
}

async function fetchNowcastLine(area) {
  const json = await fetchJson("https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast");
  const forecasts = json?.data?.items?.[0]?.forecasts || [];
  const match = forecasts.find((item) => item.area === area);
  if (!match?.forecast) {
    return null;
  }
  return `🌧 未来两小时（${area}）：${NOWCAST_LABELS[match.forecast] || match.forecast}`;
}

async function getWeatherSummaryCached(context, weatherConfig, nowcastArea) {
  const cache = context.weatherCache;
  const nowMs = Date.now();

  if (cache.summary !== null && nowMs - cache.fetchedAt < WEATHER_TTL_MS) {
    return cache.summary;
  }
  if (nowMs - cache.lastAttemptAt < WEATHER_RETRY_MS) {
    return cache.summary;
  }
  cache.lastAttemptAt = nowMs;

  try {
    const weather = await fetchWeather(weatherConfig);
    let summary = buildWeatherMessage(weather);
    let nowcastLine = null;
    try {
      nowcastLine = await fetchNowcastLine(nowcastArea);
    } catch {
      nowcastLine = null;
    }
    if (summary && nowcastLine) {
      summary = `${summary}\n${nowcastLine}`;
    } else if (nowcastLine) {
      summary = nowcastLine;
    }
    if (summary) {
      cache.summary = summary;
      cache.fetchedAt = nowMs;
    }
  } catch {
    // keep the stale summary; retry after WEATHER_RETRY_MS
  }

  return cache.summary;
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${response.statusText} ${body}`);
  }

  const json = await response.json().catch(() => null);
  return json?.result || null;
}

async function answerTelegramCallbackQuery(token, callbackQueryId, text = "") {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    const message = `Telegram answerCallbackQuery failed: ${response.status} ${response.statusText} ${body}`;
    if (isIgnorableTelegramError(message)) {
      logInfo(message);
      return;
    }
    throw new Error(message);
  }
}

async function editTelegramMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    const message = `Telegram editMessageReplyMarkup failed: ${response.status} ${response.statusText} ${body}`;
    if (isIgnorableTelegramError(message)) {
      logInfo(message);
      return;
    }
    throw new Error(message);
  }
}

async function editTelegramMessageText(token, chatId, messageId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    const message = `Telegram editMessageText failed: ${response.status} ${response.statusText} ${body}`;
    if (isIgnorableTelegramError(message)) {
      logInfo(message);
      return;
    }
    throw new Error(message);
  }
}

async function fetchTelegramUpdates(token, offset, timeoutSeconds = 0) {
  const params = new URLSearchParams({ timeout: String(timeoutSeconds) });
  if (typeof offset === "number") {
    params.set("offset", String(offset));
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`,
    { signal: AbortSignal.timeout(Math.max(FETCH_TIMEOUT_MS, (timeoutSeconds + 10) * 1000)) },
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

function buildStatusMessage(items, timeZone, stops, weatherSummary = null, muteStatus = null) {
  const lines = ["🚏 手动查询状态", ""];

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
  lines.push(buildAvailableCommandsHint(stops));
  return lines.join("\n");
}

function buildConfigMessage(stops, state, defaultThresholdMinutes) {
  const lines = ["⚙️ 当前配置", ""];
  const walkByStop = state.walkMinutesByStop || {};

  for (const stop of stops) {
    const periodSuffix =
      Array.isArray(stop.periods) && stop.periods.length > 0
        ? `｜仅${stop.periods.join("、")}高峰`
        : "";
    lines.push(`📍 ${stop.stop_name} (${stop.stop_id})${periodSuffix}`);
    if (Number.isFinite(walkByStop[stop.stop_id])) {
      lines.push(`   🚶 步行 ${walkByStop[stop.stop_id]} 分钟`);
    }
    if (!Array.isArray(stop.services) || stop.services.length === 0) {
      lines.push("   暂无监控线路");
    } else {
      for (const serviceNo of stop.services) {
        const threshold = getServiceThresholdMinutes(state, defaultThresholdMinutes, serviceNo);
        lines.push(`   🚌 ${serviceNo}｜提醒阈值 ${threshold} 分钟`);
      }
    }
    lines.push("");
  }

  if (Number.isFinite(state.walkMinutesDefault)) {
    lines.push(`🚶 默认步行时间：${state.walkMinutesDefault} 分钟（出门提醒已开启）`);
  } else if (Object.keys(walkByStop).length > 0) {
    lines.push("🚶 出门提醒：仅对已设置步行时间的站点开启");
  } else {
    lines.push("🚶 出门提醒未开启（发送：步行 <分钟>）");
  }
  lines.push("");

  lines.push("可用命令：");
  lines.push("添加站点 <ID> <名称>");
  lines.push("删除站点 <ID>");
  lines.push("添加线路 <线路号> <站点ID/名称>");
  lines.push("删除线路 <线路号> <站点ID/名称>");
  lines.push("阈值 <线路号> <分钟>");
  lines.push("步行 <分钟> / 步行 <站点ID> <分钟> / 步行 关");
  lines.push("设置时段 <站点ID> 早|晚|全部");
  return lines.join("\n");
}

function buildDeparturePingMessage(pings, timeZone) {
  const lines = ["🏃 现在出门，正好赶上", ""];

  pings.forEach((ping, index) => {
    lines.push(`🚌 ${ping.serviceNo}｜${minutesLabel(ping.arrival.duration_ms)}后到｜步行 ${ping.walkMinutes} 分钟`);
    lines.push(`📍 ${ping.stop.stop_name}`);
    lines.push(`🕒 到站 ${formatArrivalClock(ping.arrival.time, timeZone)}`);
    if (index !== pings.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

function buildWindowNoticeMessage(items, timeZone, weatherSummary, periodLabel, hasTriggered, footerLine) {
  const lines = [`⏰ ${periodLabel}出行提醒`, ""];

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
  lines.push(hasTriggered ? "⚡ 车快到了，可以准备出发了" : "⏳ 暂时没有临近的车");
  lines.push(footerLine);
  return lines.join("\n");
}

const NOTICE_FOOTER_PREFIXES = ["🔄 自动刷新中", "⏹ ", "🛑 已上车", "🔕 今天提醒已暂停"];

function swapNoticeFooter(text, footerLine) {
  return String(text || "")
    .split("\n")
    .map((line) =>
      NOTICE_FOOTER_PREFIXES.some((prefix) => line.startsWith(prefix)) ? footerLine : line,
    )
    .join("\n");
}

const MUTE_BANNER_LINES = new Set([
  "🔕 今天已暂停",
  "🔔 今天的主动提醒：开启中",
  "🛑 本时段已上车",
]);

const MUTE_BANNER_HEADERS = new Set([
  "🚏 当前公交状态",
  "🚏 手动查询状态",
  "⏰ 晨间通知",
  "⏰ 高峰时段主动提醒",
  "⏰ 晨间出行提醒",
  "⏰ 晚间出行提醒",
]);

function applyMuteBannerToMessageText(text, bannerLine) {
  const lines = String(text || "").split("\n");
  const filtered = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (MUTE_BANNER_LINES.has(lines[index])) {
      if (lines[index + 1] === "") {
        index += 1;
      }
      continue;
    }
    filtered.push(lines[index]);
  }

  if (bannerLine && filtered.length >= 2 && MUTE_BANNER_HEADERS.has(filtered[0]) && filtered[1] === "") {
    filtered.splice(2, 0, bannerLine, "");
  }

  return filtered.join("\n");
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

function cleanupState(state, nowIso, timeZone) {
  const now = new Date(nowIso);
  const todayKey = formatDateKey(now, timeZone);

  state.alerts = {};

  if (state.mutedUntilDateKey && state.mutedUntilDateKey < todayKey) {
    delete state.mutedUntilDateKey;
  }

  const mutedToday = getMutedWindowKeys(state).filter((key) => key.startsWith(`${todayKey}|`));
  if (mutedToday.length > 0) {
    state.mutedWindowKeys = mutedToday;
  } else {
    delete state.mutedWindowKeys;
  }

  const keepFromKey = formatDateKey(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), timeZone);
  const notices = getWindowNotices(state);
  for (const key of Object.keys(notices)) {
    const dateKey = key.split("|")[0];
    if (dateKey < keepFromKey || (dateKey < todayKey && notices[key]?.finalized)) {
      delete notices[key];
    }
  }

  const pings = state.departurePings;
  if (pings && typeof pings === "object" && !Array.isArray(pings)) {
    for (const key of Object.keys(pings)) {
      if (!key.startsWith(`${todayKey}|`)) {
        delete pings[key];
      }
    }
    if (Object.keys(pings).length === 0) {
      delete state.departurePings;
    }
  } else if (pings !== undefined) {
    delete state.departurePings;
  }
}

async function fetchCurrentStatuses(apiBase, stops, timeZone, runCache, requestedServices = null) {
  const rows = flattenStopServices(stops);
  const filteredRows = requestedServices
    ? rows.filter((row) => requestedServices.has(row.serviceNo))
    : rows;
  const cache = new Map();
  const items = [];

  for (const row of filteredRows) {
    if (!cache.has(row.stop.stop_id)) {
      cache.set(row.stop.stop_id, await fetchArrivalsCached(apiBase, row.stop.stop_id, runCache));
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

async function discoverServiceCandidateStops(apiBase, stops, serviceNo, runCache) {
  const candidates = [];

  for (const stop of stops) {
    const arrivalData = await fetchArrivalsCached(apiBase, stop.stop_id, runCache);
    const services = arrivalData.services || [];
    if (services.some((service) => service.no === serviceNo)) {
      candidates.push(stop);
    }
  }

  return candidates;
}

async function evaluateWindowServices(apiBase, stops, state, defaultThresholdMinutes, runCache) {
  const items = [];
  const triggered = [];

  for (const row of flattenStopServices(stops)) {
    const arrivalData = await fetchArrivalsCached(apiBase, row.stop.stop_id, runCache);
    const service = (arrivalData.services || []).find((item) => item.no === row.serviceNo);
    const arrivals = service
      ? [service.next, service.subsequent, service.next3].filter((arrival) => arrival || arrival === null)
      : [];
    items.push({ stop: row.stop, serviceNo: row.serviceNo, arrivals });

    if (!service) {
      continue;
    }

    const thresholdMinutes = getServiceThresholdMinutes(state, defaultThresholdMinutes, row.serviceNo);
    const selectedArrival = selectArrival(service, thresholdMinutes);
    if (selectedArrival?.time) {
      triggered.push({
        key: `${row.stop.stop_id}:${row.serviceNo}`,
        stopId: row.stop.stop_id,
        serviceNo: row.serviceNo,
        arrivalTime: selectedArrival.time,
      });
    }
  }

  return { items, triggered };
}

async function finalizeWindowNotice(token, chatId, notice, footerLine, replyMarkup) {
  notice.finalized = true;
  if (!notice.messageId || !notice.lastText) {
    return;
  }

  const text = swapNoticeFooter(notice.lastText, footerLine);
  try {
    await editTelegramMessageText(token, chatId, notice.messageId, text, replyMarkup);
    notice.lastText = text;
  } catch (error) {
    logInfo(`window notice finalize edit failed: ${error.message}`);
  }
}

async function proactiveTick(context, now) {
  const {
    token,
    chatId,
    state,
    apiBase,
    stops,
    timeZone,
    defaultThresholdMinutes,
    runCache,
    alertWindows,
    stateFile,
    holidays,
  } = context;

  const todayKey = formatDateKey(now, timeZone);
  const notices = getWindowNotices(state);
  const nowClock = formatArrivalClock(now.toISOString(), timeZone);

  for (const [key, notice] of Object.entries(notices)) {
    if (!notice || notice.finalized) {
      continue;
    }
    const [noticeDateKey, windowStart] = key.split("|");
    const window = alertWindows.find((item) => item.start === windowStart);
    const stillActive =
      noticeDateKey === todayKey &&
      window &&
      isWithinWindow(now, timeZone, window.start, window.end);
    if (stillActive) {
      continue;
    }
    await finalizeWindowNotice(
      token,
      chatId,
      notice,
      `⏹ 本时段提醒已结束｜最后更新：${nowClock}`,
      buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
    );
    logInfo(`window notice finalized for ${key}`);
  }

  let activeWindow = findActiveWindow(now, timeZone, alertWindows);
  if (activeWindow && holidays.has(todayKey)) {
    if (context.holidayLoggedFor !== todayKey) {
      logInfo(`public holiday ${todayKey}, proactive notifications skipped`);
      context.holidayLoggedFor = todayKey;
    }
    activeWindow = null;
  }
  if (!activeWindow) {
    return;
  }

  const windowKey = windowKeyFor(todayKey, activeWindow);
  const windowMuted = isDayMuted(state, todayKey) || getMutedWindowKeys(state).includes(windowKey);

  if (windowMuted) {
    const notice = notices[windowKey];
    if (notice && !notice.finalized) {
      await finalizeWindowNotice(
        token,
        chatId,
        notice,
        isDayMuted(state, todayKey) ? "🔕 今天提醒已暂停" : "🛑 已上车，本时段提醒结束",
        buildTelegramButtons(stops, true),
      );
    }
    return;
  }

  const windowStops = stopsForPeriod(stops, windowPeriodKey(activeWindow));
  if (windowStops.length === 0) {
    return;
  }

  const { items, triggered } = await evaluateWindowServices(
    apiBase,
    windowStops,
    state,
    defaultThresholdMinutes,
    runCache,
  );
  const periodLabel = windowPeriodLabel(activeWindow);
  const existingNotice = notices[windowKey];

  if (!existingNotice) {
    if (triggered.length > 0 && items.length > 0) {
      const weatherSummary = await context.getWeatherSummary();
      const text = buildWindowNoticeMessage(
        items,
        timeZone,
        weatherSummary,
        periodLabel,
        true,
        `🔄 自动刷新中｜更新时间：${nowClock}`,
      );
      const sent = await sendTelegramMessage(token, {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, false),
      });

      const notice = {
        messageId: sent?.message_id || null,
        lastText: text,
        loggedServices: [],
        finalized: !sent?.message_id,
      };
      notices[windowKey] = notice;

      for (const item of triggered) {
        notice.loggedServices.push(item.key);
        await logAlertToHistoryFromStore(stateFile, item.stopId, item.serviceNo, item.arrivalTime);
      }
      logInfo(
        `window notice sent for ${windowKey}${notice.messageId ? ` message_id=${notice.messageId}` : ""}`,
      );
    }
  } else if (!existingNotice.finalized) {
    const weatherSummary = await context.getWeatherSummary();
    const text = buildWindowNoticeMessage(
      items,
      timeZone,
      weatherSummary,
      periodLabel,
      triggered.length > 0,
      `🔄 自动刷新中｜更新时间：${nowClock}`,
    );

    if (text !== existingNotice.lastText && existingNotice.messageId) {
      try {
        await editTelegramMessageText(
          token,
          chatId,
          existingNotice.messageId,
          text,
          buildTelegramButtons(stops, false),
        );
        existingNotice.lastText = text;
        logInfo(`window notice refreshed for ${windowKey}`);
      } catch (error) {
        if (error.message.includes("message to edit not found")) {
          existingNotice.finalized = true;
          logInfo("window notice message was deleted, stopping refresh for this window");
        } else {
          throw error;
        }
      }
    }

    if (!Array.isArray(existingNotice.loggedServices)) {
      existingNotice.loggedServices = [];
    }
    for (const item of triggered) {
      if (existingNotice.loggedServices.includes(item.key)) {
        continue;
      }
      existingNotice.loggedServices.push(item.key);
      await logAlertToHistoryFromStore(stateFile, item.stopId, item.serviceNo, item.arrivalTime);
    }
  }

  const walkDefault = Number.isFinite(state.walkMinutesDefault) ? state.walkMinutesDefault : null;
  const walkByStop =
    state.walkMinutesByStop && typeof state.walkMinutesByStop === "object"
      ? state.walkMinutesByStop
      : {};
  const pings = [];
  for (const item of items) {
    const walkMinutes = Number.isFinite(walkByStop[item.stop.stop_id])
      ? walkByStop[item.stop.stop_id]
      : walkDefault;
    if (!Number.isFinite(walkMinutes) || walkMinutes <= 0) {
      continue;
    }
    const rowKey = `${item.stop.stop_id}:${item.serviceNo}`;
    if (state.departurePings?.[windowKey]?.includes(rowKey)) {
      continue;
    }
    const candidate = pickDepartureCandidate(item.arrivals, walkMinutes);
    if (!candidate) {
      continue;
    }
    pings.push({ stop: item.stop, serviceNo: item.serviceNo, arrival: candidate, walkMinutes, rowKey });
  }

  if (pings.length > 0) {
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: buildDeparturePingMessage(pings, timeZone),
      disable_web_page_preview: true,
      reply_markup: buildTelegramButtons(stops, false),
    });
    if (
      !state.departurePings ||
      typeof state.departurePings !== "object" ||
      Array.isArray(state.departurePings)
    ) {
      state.departurePings = {};
    }
    if (!Array.isArray(state.departurePings[windowKey])) {
      state.departurePings[windowKey] = [];
    }
    for (const ping of pings) {
      state.departurePings[windowKey].push(ping.rowKey);
      logInfo(`departure ping sent for ${ping.rowKey} (walk ${ping.walkMinutes}m)`);
    }
  }
}

async function processTelegramCommands(context, pollSeconds) {
  const {
    token,
    chatId,
    state,
    apiBase,
    stops,
    timeZone,
    defaultThresholdMinutes,
    runCache,
    alertWindows,
  } = context;
  const offset =
    typeof state.telegramUpdateOffset === "number" ? state.telegramUpdateOffset : undefined;
  const updates = await fetchTelegramUpdates(token, offset, pollSeconds);

  for (const update of updates) {
    state.telegramUpdateOffset = update.update_id + 1;

    const message = update.message || update.callback_query?.message;
    const callbackQuery = update.callback_query;
    if (!message || !message.chat || String(message.chat.id) !== String(chatId)) {
      continue;
    }

    let text = (message.text || "").trim();
    if (callbackQuery) {
      switch (callbackQuery.data) {
        case "status_all":
          text = "状态";
          break;
        case "boarded":
          text = "上车了";
          break;
        case "mute":
          text = "暂停";
          break;
        case "resume":
          text = "恢复";
          break;
        default:
          text = parseServiceCallbackData(callbackQuery.data) || "";
      }
    }
    if (!text) {
      continue;
    }

    let requestedServices = null;
    const todayKey = formatDateKey(new Date(), timeZone);

    if (text === "上车了") {
      const { hour, minute } = getLocalParts(new Date(), timeZone);
      const targetWindow = pickBoardedWindow(hour * 60 + minute, alertWindows);
      const targetKey = targetWindow ? windowKeyFor(todayKey, targetWindow) : null;
      if (targetKey) {
        addMutedWindowKey(state, targetKey);
      }

      const notices = getWindowNotices(state);
      const targetNotice = targetKey ? notices[targetKey] : null;
      if (targetNotice && !targetNotice.finalized) {
        await finalizeWindowNotice(
          token,
          chatId,
          targetNotice,
          "🛑 已上车，本时段提醒结束",
          buildTelegramButtons(stops, true),
        );
      }

      if (callbackQuery) {
        if (!targetNotice || targetNotice.messageId !== message.message_id) {
          await editTelegramMessageText(
            token,
            chatId,
            message.message_id,
            applyMuteBannerToMessageText(message.text, "🛑 本时段已上车"),
            buildTelegramButtons(stops, true),
          );
        }
        await answerTelegramCallbackQuery(token, callbackQuery.id, "已记录上车");
      } else {
        const scopeText = targetWindow
          ? `今天 ${targetWindow.start}-${targetWindow.end} 时段不再提醒，其他时段照常。`
          : "本时段不再提醒。";
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `🛑 已记录上车。${scopeText}\n如需恢复，请发送：恢复`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, true),
        });
      }
      continue;
    } else if (text === "暂停") {
      state.mutedUntilDateKey = todayKey;

      const notices = getWindowNotices(state);
      let editedCurrentMessage = false;
      for (const [key, notice] of Object.entries(notices)) {
        if (!key.startsWith(`${todayKey}|`) || !notice || notice.finalized) {
          continue;
        }
        await finalizeWindowNotice(
          token,
          chatId,
          notice,
          "🔕 今天提醒已暂停",
          buildTelegramButtons(stops, true),
        );
        if (notice.messageId === message.message_id) {
          editedCurrentMessage = true;
        }
      }

      if (callbackQuery) {
        if (!editedCurrentMessage) {
          await editTelegramMessageText(
            token,
            chatId,
            message.message_id,
            applyMuteBannerToMessageText(message.text, "🔕 今天已暂停"),
            buildTelegramButtons(stops, true),
          );
        }
        await answerTelegramCallbackQuery(token, callbackQuery.id, "今天已暂停");
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "🔕 今天的主动提醒已全部暂停。\n如需恢复，请发送：恢复",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, true),
        });
      }
      continue;
    } else if (text === "恢复") {
      delete state.mutedUntilDateKey;
      const remainingMutedKeys = getMutedWindowKeys(state).filter(
        (key) => !key.startsWith(`${todayKey}|`),
      );
      if (remainingMutedKeys.length > 0) {
        state.mutedWindowKeys = remainingMutedKeys;
      } else {
        delete state.mutedWindowKeys;
      }

      const notices = getWindowNotices(state);
      const nowForResume = new Date();
      for (const [key, notice] of Object.entries(notices)) {
        if (!key.startsWith(`${todayKey}|`) || !notice?.finalized || !notice.messageId) {
          continue;
        }
        const start = key.slice(todayKey.length + 1);
        const window = alertWindows.find((item) => item.start === start);
        if (window && isWithinWindow(nowForResume, timeZone, window.start, window.end)) {
          notice.finalized = false;
        }
      }

      if (callbackQuery) {
        await editTelegramMessageText(
          token,
          chatId,
          message.message_id,
          applyMuteBannerToMessageText(message.text, "🔔 今天的主动提醒：开启中"),
          buildTelegramButtons(stops, false),
        );
        await answerTelegramCallbackQuery(token, callbackQuery.id, "提醒已恢复");
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "🔔 今天的主动提醒已恢复。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, false),
        });
      }
      continue;
    } else if (text === "配置") {
      if (callbackQuery) {
        await editTelegramMessageText(
          token,
          chatId,
          message.message_id,
          buildConfigMessage(stops, state, defaultThresholdMinutes),
          buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        );
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: buildConfigMessage(stops, state, defaultThresholdMinutes),
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
      }
      if (callbackQuery) {
        await answerTelegramCallbackQuery(token, callbackQuery.id);
      }
      continue;
    } else if (text === "状态" || text.toLowerCase() === "status") {
      requestedServices = null;
    } else if (isValidServiceNo(text)) {
      requestedServices = new Set([text]);
    } else if (/^添加站点\s+\S+\s+\S+/.test(text)) {
      const match = /^添加站点\s+(\S+)\s+(.+)$/.exec(text);
      const stopId = match?.[1];
      const stopName = match?.[2]?.trim();

      if (!isValidStopId(stopId) || !isValidStopName(stopName)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "站点格式无效。请使用 5 位站点 ID，并避免名称里出现换行。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      if (stops.some((stop) => stop.stop_id === stopId)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `站点 ${stopId} 已在监控配置中。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      const newStop = { stop_id: stopId, stop_name: stopName, services: [] };
      stops.push(newStop);
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已添加站点：${stopName} (${stopId})\n现在可以添加线路到该站点。`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      continue;
    } else if (/^删除站点\s+\S+/.test(text)) {
      const match = /^删除站点\s+(\S+)$/.exec(text);
      const stopId = match?.[1];

      if (!isValidStopId(stopId)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "站点 ID 格式无效，请使用 5 位数字站点 ID。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      const stopIndex = stops.findIndex((stop) => stop.stop_id === stopId);

      if (stopIndex === -1) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `未找到站点 ID 为 ${stopId} 的配置。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      const removedStop = stops.splice(stopIndex, 1)[0];
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已删除站点：${removedStop.stop_name} (${removedStop.stop_id})`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      continue;
    } else if (/^添加线路\s+\S+/.test(text)) {
      const match = /^添加线路\s+(\S+)(?:\s+(.+))?$/.exec(text);
      const serviceNo = match?.[1];
      const stopIdentifier = match?.[2]?.trim();

      if (!isValidServiceNo(serviceNo)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "线路号格式无效，请使用字母和数字组成的线路号。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      if (stops.some((stop) => (stop.services || []).includes(serviceNo)) && !stopIdentifier) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `线路 ${serviceNo} 已在当前监控配置中。如果要添加到其他站点，请指定站点。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      let targetStop = null;
      if (stopIdentifier) {
        targetStop = findStopByIdentifier(stops, stopIdentifier);
      } else if (stops.length === 1) {
        targetStop = stops[0];
      } else {
        const candidates = await discoverServiceCandidateStops(apiBase, stops, serviceNo, runCache);
        if (candidates.length === 1) {
          targetStop = candidates[0];
        } else if (candidates.length === 0) {
          await sendTelegramMessage(token, {
            chat_id: chatId,
            text: `无法自动判断线路 ${serviceNo} 属于哪个站点，请这样发送：\n添加线路 ${serviceNo} 17379`,
            reply_to_message_id: message.message_id,
            disable_web_page_preview: true,
            reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
          });
          continue;
        } else {
          await sendTelegramMessage(token, {
            chat_id: chatId,
            text: `线路 ${serviceNo} 在多个已监控站点都可能存在，请指定站点。`,
            reply_to_message_id: message.message_id,
            disable_web_page_preview: true,
            reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
          });
          continue;
        }
      }

      if (!targetStop) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "没有找到你指定的站点，可用站点请先发送：配置",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      targetStop.services = Array.from(new Set([...(targetStop.services || []), serviceNo])).sort();
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已添加线路 ${serviceNo}\n站点：${targetStop.stop_name} (${targetStop.stop_id})`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      continue;
    } else if (/^删除线路\s+\S+/.test(text)) {
      const match = /^删除线路\s+(\S+)(?:\s+(.+))?$/.exec(text);
      const serviceNo = match?.[1];
      const stopIdentifier = match?.[2]?.trim();

      if (!isValidServiceNo(serviceNo)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "线路号格式无效，请使用字母和数字组成的线路号。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      const matchedStops = stops.filter((stop) => (stop.services || []).includes(serviceNo));

      if (matchedStops.length === 0) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `线路 ${serviceNo} 当前不在监控配置中。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      let targetStop = null;
      if (stopIdentifier) {
        targetStop = findStopByIdentifier(matchedStops, stopIdentifier);
      } else if (matchedStops.length === 1) {
        targetStop = matchedStops[0];
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `线路 ${serviceNo} 在多个站点中存在，请指定站点后再删除。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      if (!targetStop) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "没有找到你指定的站点，可用站点请先发送：配置",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      targetStop.services = (targetStop.services || []).filter((item) => item !== serviceNo);
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已删除线路 ${serviceNo}\n站点：${targetStop.stop_name} (${targetStop.stop_id})`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      continue;
    } else if (/^阈值\s+\S+\s+\d+$/.test(text)) {
      const match = /^阈值\s+(\S+)\s+(\d+)$/.exec(text);
      const serviceNo = match?.[1];
      const minutes = Number(match?.[2]);

      if (!isValidServiceNo(serviceNo)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "线路号格式无效，请使用字母和数字组成的线路号。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      state.serviceThresholdMinutes = {
        ...(state.serviceThresholdMinutes || {}),
        [serviceNo]: minutes,
      };
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已设置线路 ${serviceNo} 的提醒阈值为 ${minutes} 分钟。`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      continue;
    } else if (/^步行(\s|$)/.test(text)) {
      const parts = text.split(/\s+/);
      const replyMarkup = buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows));
      let replyText = null;

      if (parts.length === 1) {
        const byStop = state.walkMinutesByStop || {};
        const overrides = Object.entries(byStop)
          .map(([stopId, minutes]) => `${stopId} → ${minutes} 分钟`)
          .join("；");
        if (Number.isFinite(state.walkMinutesDefault)) {
          replyText = `🚶 默认步行 ${state.walkMinutesDefault} 分钟${overrides ? `；${overrides}` : ""}`;
        } else if (overrides) {
          replyText = `🚶 站点步行时间：${overrides}`;
        } else {
          replyText = "🚶 出门提醒未开启。";
        }
        replyText += "\n\n用法：\n步行 5（默认步行分钟）\n步行 17379 6（按站点）\n步行 关（关闭出门提醒）";
      } else if (parts[1] === "关") {
        delete state.walkMinutesDefault;
        delete state.walkMinutesByStop;
        replyText = "🚶 出门提醒已关闭。";
      } else if (parts.length === 2 && /^\d{1,3}$/.test(parts[1])) {
        const minutes = Number(parts[1]);
        if (minutes < 1 || minutes > 120) {
          replyText = "步行时间需要在 1-120 分钟之间。";
        } else {
          state.walkMinutesDefault = minutes;
          replyText = `🚶 已设置默认步行时间 ${minutes} 分钟。\n某班车 ETA 进入 ${minutes}-${minutes + 2} 分钟区间时，会提醒你出门。`;
        }
      } else if (parts.length === 3 && isValidStopId(parts[1]) && /^\d{1,3}$/.test(parts[2])) {
        const minutes = Number(parts[2]);
        const walkStop = stops.find((stop) => stop.stop_id === parts[1]);
        if (!walkStop) {
          replyText = `站点 ${parts[1]} 不在监控配置中。`;
        } else if (minutes < 1 || minutes > 120) {
          replyText = "步行时间需要在 1-120 分钟之间。";
        } else {
          state.walkMinutesByStop = { ...(state.walkMinutesByStop || {}), [parts[1]]: minutes };
          replyText = `🚶 已设置 ${walkStop.stop_name} (${parts[1]}) 步行时间 ${minutes} 分钟。`;
        }
      } else {
        replyText = "用法：\n步行 5（默认步行分钟）\n步行 17379 6（按站点）\n步行 关（关闭出门提醒）";
      }

      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: replyText,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      continue;
    } else if (/^设置时段(\s|$)/.test(text)) {
      const match = /^设置时段\s+(\S+)\s+(早|晚|全部)$/.exec(text);
      const replyMarkup = buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows));

      if (!match) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "用法：设置时段 <站点ID或名称> 早|晚|全部",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
        continue;
      }

      const periodStop = findStopByIdentifier(stops, match[1]);
      if (!periodStop) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "没有找到你指定的站点，可用站点请先发送：配置",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
        continue;
      }

      if (match[2] === "全部") {
        delete periodStop.periods;
      } else {
        periodStop.periods = [match[2]];
      }
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ ${periodStop.stop_name} (${periodStop.stop_id}) 现在${
          match[2] === "全部" ? "在所有时段提醒" : `只在${match[2]}高峰时段提醒`
        }。`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      continue;
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: buildHelpMessage(stops),
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
      if (callbackQuery) {
        await answerTelegramCallbackQuery(token, callbackQuery.id);
      }
      continue;
    }

    const statuses = await fetchCurrentStatuses(apiBase, stops, timeZone, runCache, requestedServices);
    if (statuses.length === 0) {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "没有匹配到你查询的线路。",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
      });
      continue;
    }

    const weatherSummary = await context.getWeatherSummary();

    const muteStatus = describeMuteStatus(state, todayKey, alertWindows);

    if (callbackQuery) {
      await editTelegramMessageText(
        token,
        chatId,
        message.message_id,
        buildStatusMessage(statuses, timeZone, stops, weatherSummary, muteStatus),
        buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      );
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: buildStatusMessage(statuses, timeZone, stops, weatherSummary, muteStatus),
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      });
    }
    if (callbackQuery) {
      await answerTelegramCallbackQuery(token, callbackQuery.id);
    }
  }
}

async function main() {
  const env = await loadEnv();
  const mode = process.argv[2] || "run";

  const timeZone = env.TIMEZONE || "Asia/Singapore";
  const alertWindows = parseAlertWindows(env);

  const parsedThreshold = Number(env.ALERT_THRESHOLD_MINUTES);
  const maxMinutes = Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : 8;
  const apiBase = env.ARRIVAL_API_BASE || "https://arrivelah2.busrouter.sg";
  const weatherConfig = {
    latitude: env.WEATHER_LATITUDE || "1.3179",
    longitude: env.WEATHER_LONGITUDE || "103.7631",
    timezone: timeZone,
  };
  const nowcastArea = env.WEATHER_NOWCAST_AREA || "Clementi";
  const holidays = parseDateKeySet(env.PUBLIC_HOLIDAYS);
  for (const key of DEFAULT_SG_PUBLIC_HOLIDAYS) {
    holidays.add(key);
  }
  const parsedFailureAlertAfter = Number(env.FAILURE_ALERT_AFTER);
  const failureAlertAfter =
    Number.isFinite(parsedFailureAlertAfter) && parsedFailureAlertAfter > 0
      ? parsedFailureAlertAfter
      : 30;
  const stateFile = path.resolve(process.cwd(), env.STATE_FILE || "./state.json");
  const lockFile = path.join(path.dirname(stateFile), ".sg-bus-alert.lock");
  const defaultStops = JSON.parse(required(env, "STOP_CONFIG_JSON"));

  if (!Array.isArray(defaultStops) || defaultStops.length === 0) {
    throw new Error("STOP_CONFIG_JSON must be a non-empty JSON array");
  }

  if (mode === "test") {
    const token = env.BUS_ALERT_TELEGRAM_BOT_TOKEN || required(env, "TELEGRAM_BOT_TOKEN");
    const chatId = required(env, "TELEGRAM_CHAT_ID");
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: "✅ 测试消息\nTelegram 机器人配置正常。",
      disable_web_page_preview: true,
      reply_markup: buildTelegramButtons(defaultStops, false),
    });
    console.log("Sent Telegram test message.");
    return;
  }

  const token = env.BUS_ALERT_TELEGRAM_BOT_TOKEN || required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_CHAT_ID");
  const lock = await acquireRunLock(lockFile);
  if (!lock.acquired) {
    const pid = lock.activeLock?.pid ? ` pid=${lock.activeLock.pid}` : "";
    logInfo(`another instance is active, exiting cleanly${pid}`);
    return;
  }

  if (lock.recoveredStaleLock) {
    logInfo(`recovered stale lock ${lockFile}`);
  }

  const releaseLockOnSignal = () => {
    try {
      unlinkSync(lockFile);
    } catch {
      // lock already gone
    }
    process.exit(0);
  };
  process.once("SIGTERM", releaseLockOnSignal);
  process.once("SIGINT", releaseLockOnSignal);

  try {
    const state = await readStateFromStore(stateFile);
    const context = {
      token,
      chatId,
      state,
      apiBase,
      timeZone,
      alertWindows,
      defaultThresholdMinutes: maxMinutes,
      stateFile,
      holidays,
      stops: [],
      runCache: null,
      weatherCache: { summary: null, fetchedAt: 0, lastAttemptAt: 0 },
      holidayLoggedFor: null,
      lastWindowLog: null,
    };
    context.getWeatherSummary = () => getWeatherSummaryCached(context, weatherConfig, nowcastArea);

    let lastPersisted = JSON.stringify(state);
    const persistIfDirty = async () => {
      const snapshot = JSON.stringify(state);
      if (snapshot !== lastPersisted) {
        await writeStateFromStore(stateFile, state);
        lastPersisted = snapshot;
      }
    };

    const singleCycle = mode === "once";
    let lastProactiveAt = 0;
    let lastHeartbeatAt = Date.now();

    logInfo(
      `daemon started, windows=${alertWindows.map((w) => `${w.start}-${w.end}`).join(",")}, timezone=${timeZone}`,
    );

    do {
      let cycleFailed = false;
      try {
        const now = new Date();
        context.stops = loadEffectiveStops(state, defaultStops);
        context.runCache = { arrivals: new Map() };
        cleanupState(state, now.toISOString(), timeZone);

        const activeWindow = findActiveWindow(now, timeZone, alertWindows);
        const windowLogValue = activeWindow
          ? `${activeWindow.start}-${activeWindow.end}`
          : "none";
        if (windowLogValue !== context.lastWindowLog) {
          logInfo(
            `window state: ${windowLogValue}, muted=${isProactiveMutedNow(state, timeZone, alertWindows) ? "yes" : "no"}`,
          );
          context.lastWindowLog = windowLogValue;
        }

        const pollSeconds = singleCycle ? 0 : activeWindow ? 5 : 20;
        await processTelegramCommands(context, pollSeconds);

        if (singleCycle || Date.now() - lastProactiveAt >= PROACTIVE_TICK_MS) {
          lastProactiveAt = Date.now();
          await proactiveTick(context, new Date());
        }

        if ((state.failureStreak || 0) >= failureAlertAfter) {
          try {
            await sendTelegramMessage(token, {
              chat_id: chatId,
              text: `✅ 已恢复正常（此前连续 ${state.failureStreak} 次循环失败）。`,
              disable_web_page_preview: true,
            });
          } catch {
            // best effort
          }
        }
        if (state.failureStreak) {
          delete state.failureStreak;
        }
      } catch (error) {
        cycleFailed = true;
        state.failureStreak = (Number.isFinite(state.failureStreak) ? state.failureStreak : 0) + 1;
        logInfo(`cycle failed (streak=${state.failureStreak}): ${error.message}`);
        if (state.failureStreak === failureAlertAfter) {
          try {
            await sendTelegramMessage(token, {
              chat_id: chatId,
              text: `⚠️ 机器人连续 ${failureAlertAfter} 次循环失败，请检查日志。\n最近错误：${error.message}`,
              disable_web_page_preview: true,
            });
          } catch {
            // Telegram itself may be down; stay silent
          }
        }
      }

      try {
        await persistIfDirty();
      } catch (writeError) {
        console.error(`State write failed: ${writeError.message}`);
      }

      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        logInfo(`heartbeat: alive, offset=${state.telegramUpdateOffset ?? "none"}`);
      }

      if (cycleFailed && !singleCycle) {
        await sleep(5000);
      }
    } while (!singleCycle);
  } finally {
    await releaseRunLock(lockFile);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
