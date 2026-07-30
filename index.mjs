#!/usr/bin/env node

import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import dns from "node:dns";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

// api.telegram.org publishes AAAA records that this network cannot reach, and
// undici does not fall back to IPv4 the way curl does.
dns.setDefaultResultOrder("ipv4first");
import {
  acquireRunLock,
  buildAvailableCommandsHint,
  buildHelpMessage,
  buildTelegramButtons,
  DEFAULT_ACTIVE_WEEKDAYS,
  describeActiveWeekdays,
  detectEtaAnomaly,
  normalizeActiveWeekdays,
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
  buildLeadLine,
  buildStopSections,
  formatArrivalClock,
  isRainyForecast,
  loadLabel,
  minutesLabel,
} from "./lib/render.mjs";
import {
  logAlertToHistory as logAlertToHistoryFromStore,
  logBoarding as logBoardingToStore,
  pruneHistory as pruneHistoryFromStore,
  readBoardingStats as readBoardingStatsFromStore,
  readState as readStateFromStore,
  writeState as writeStateFromStore,
} from "./lib/state-store.mjs";
import {
  extractCoordinate,
  findNearestStops,
  findUrl,
  formatDistance,
  isPlausibleSingaporeCoordinate,
  isResolvableShortLink,
  looksLikeLocationInput,
  parseStopsDataset,
} from "./lib/location.mjs";
import {
  applyWindowTime,
  buildAddStopMenu,
  buildDeleteConfirmMenu,
  buildMainMenu,
  buildPeriodMenu,
  buildRenamePrompt,
  buildRoutesMenu,
  buildStopMenu,
  buildThresholdServiceMenu,
  buildThresholdValueMenu,
  buildWalkMenu,
  addDaysToDateKey,
  buildDisplayMenu,
  buildStatsMenu,
  buildVacationMenu,
  buildWeekdaysMenu,
  buildWindowEditMenu,
  buildWindowsMenu,
  buildWindowTimeMenu,
  getStopThresholdLines,
  parseMenuCallback,
  parseRenamePrompt,
} from "./lib/menu.mjs";

const ENV_PATH = path.join(process.cwd(), ".env");
const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 15 * 1000;
const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_RETRY_MS = 60 * 1000;
const PROACTIVE_TICK_MS = 9 * 1000;
const HEARTBEAT_MS = 60 * 60 * 1000;
const STOPS_DATASET_URL = "https://data.busrouter.sg/v1/stops.min.json";
const STOPS_CACHE_FILE = "stops-cache.json";
const STOPS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEARBY_STOP_LIMIT = 5;
const NEARBY_RADIUS_METERS = 800;
const SNOOZE_MINUTES = 5;
const CONFIG_BACKUP_FILE = "config-backup.json";
const CONFIG_BACKUP_KEYS = [
  "monitoredStops",
  "serviceThresholdMinutes",
  "alertWindowsOverride",
  "walkMinutesDefault",
  "walkMinutesByStop",
  "activeWeekdays",
  "displayMode",
];

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

function describeError(error) {
  const cause = error?.cause?.code || error?.cause?.message;
  return cause ? `${error.message} (${cause})` : String(error?.message || error);
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

function isWithinWindow(date, timeZone, start, end, activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS) {
  const { weekday, hour, minute } = getLocalParts(date, timeZone);
  if (!normalizeActiveWeekdays(activeWeekdays).includes(weekday)) {
    return false;
  }

  const currentMinute = hour * 60 + minute;
  return currentMinute >= getMinuteOfDay(start) && currentMinute <= getMinuteOfDay(end);
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

// Windows edited from the menu live in SQLite and win over .env, so a change
// takes effect on the next cycle instead of needing a restart.
function loadEffectiveWindows(state, defaultWindows) {
  const override = state.alertWindowsOverride;
  if (Array.isArray(override) && override.length > 0) {
    return override.map((window) => ({ start: window.start, end: window.end }));
  }
  return defaultWindows.map((window) => ({ start: window.start, end: window.end }));
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

function isOnVacation(state, dateKey) {
  return Boolean(state.vacationUntil && state.vacationUntil >= dateKey);
}

function isDayMuted(state, dateKey) {
  return state.mutedUntilDateKey === dateKey || isOnVacation(state, dateKey);
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

function findActiveWindow(now, timeZone, windows, activeWeekdays) {
  return (
    windows.find((window) =>
      isWithinWindow(now, timeZone, window.start, window.end, activeWeekdays),
    ) || null
  );
}

function getActiveWeekdays(state) {
  return normalizeActiveWeekdays(state.activeWeekdays);
}

function isProactiveMutedNow(state, timeZone, windows) {
  const now = new Date();
  const dateKey = formatDateKey(now, timeZone);
  if (isDayMuted(state, dateKey)) {
    return true;
  }
  const activeWindow = findActiveWindow(now, timeZone, windows, getActiveWeekdays(state));
  return Boolean(
    activeWindow && getMutedWindowKeys(state).includes(windowKeyFor(dateKey, activeWindow)),
  );
}

function describeMuteStatus(state, todayKey, windows) {
  if (isOnVacation(state, todayKey)) {
    return `🏖 休假中（到 ${state.vacationUntil}），主动提醒已停`;
  }
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

async function loadStopsDataset(context) {
  if (context.stopsDataset) {
    return context.stopsDataset;
  }

  const cachePath = path.join(path.dirname(context.stateFile), STOPS_CACHE_FILE);
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (cached?.fetchedAt && Date.now() - cached.fetchedAt < STOPS_CACHE_TTL_MS) {
      context.stopsDataset = parseStopsDataset(cached.stops);
      return context.stopsDataset;
    }
  } catch {
    // no usable cache; fall through to a fresh download
  }

  const json = await fetchJson(STOPS_DATASET_URL);
  context.stopsDataset = parseStopsDataset(json);
  try {
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), stops: json }), "utf8");
  } catch (error) {
    logInfo(`stops cache write failed: ${error.message}`);
  }
  logInfo(`stops dataset loaded (${context.stopsDataset.length} stops)`);
  return context.stopsDataset;
}

// Only ever follows Google's own short-link hosts, so a pasted link cannot be
// used to make the bot fetch an arbitrary address.
async function resolveShortLink(url) {
  let current = url;

  for (let hop = 0; hop < 5; hop += 1) {
    if (!isResolvableShortLink(current)) {
      return null;
    }

    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; sg-bus-alert/1.0)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const location = response.headers.get("location");
    if (location) {
      current = new URL(location, current).toString();
      const fromUrl = extractCoordinate(current);
      if (fromUrl) {
        return fromUrl;
      }
      continue;
    }

    if (response.ok) {
      const body = await response.text();
      return extractCoordinate(body);
    }

    return null;
  }

  return null;
}

async function resolveCoordinateFromText(text) {
  const direct = extractCoordinate(text);
  if (direct) {
    return direct;
  }

  const url = findUrl(text);
  if (url && isResolvableShortLink(url)) {
    return resolveShortLink(url);
  }

  return null;
}

function buildNearbyStopsMessage(candidates, monitoredStops) {
  const lines = ["📍 附近的公交站", ""];

  candidates.forEach((candidate, index) => {
    const already = monitoredStops.some((stop) => stop.stop_id === candidate.stop_id);
    lines.push(
      `${index + 1}. ${candidate.name}${candidate.road ? `（${candidate.road}）` : ""}`,
    );
    lines.push(
      `   ${candidate.stop_id}｜${formatDistance(candidate.distanceMeters)}${already ? "｜已在监控中" : ""}`,
    );
  });

  lines.push("");
  lines.push("点下面的按钮把站点加入监控，加完会列出该站的线路。");
  return lines.join("\n");
}

function buildNearbyStopsKeyboard(candidates, monitoredStops) {
  const rows = candidates
    .filter((candidate) => !monitoredStops.some((stop) => stop.stop_id === candidate.stop_id))
    .map((candidate) => [
      {
        text: `➕ ${candidate.name} · ${formatDistance(candidate.distanceMeters)}`,
        callback_data: `addstop:${candidate.stop_id}`,
      },
    ]);

  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

function buildStopServicesKeyboard(stopId, serviceNumbers, monitoredServices) {
  const rows = [];
  const pending = serviceNumbers.filter((serviceNo) => !monitoredServices.includes(serviceNo));

  for (let index = 0; index < pending.length; index += 3) {
    rows.push(
      pending.slice(index, index + 3).map((serviceNo) => ({
        text: `➕ ${serviceNo}`,
        callback_data: `addsvc:${stopId}:${serviceNo}`,
      })),
    );
  }

  return rows.length > 0 ? { inline_keyboard: rows } : null;
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

const SLASH_COMMAND_ALIASES = {
  "/start": "帮助",
  "/help": "帮助",
  "/status": "状态",
  "/settings": "设置",
  "/boarded": "上车了",
  "/mute": "暂停",
  "/resume": "恢复",
};

function normalizeSlashCommand(text) {
  if (!text.startsWith("/")) {
    return text;
  }
  const bare = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  return SLASH_COMMAND_ALIASES[bare] || text;
}

async function registerBotCommands(token) {
  const commands = [
    { command: "status", description: "🚏 查看当前到站情况" },
    { command: "settings", description: "⚙️ 设置站点、线路、提醒时间" },
    { command: "boarded", description: "🛑 我上车了（本时段不再提醒）" },
    { command: "mute", description: "🔕 今天暂停提醒" },
    { command: "resume", description: "🔔 恢复提醒" },
  ];

  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`setMyCommands failed: ${response.status} ${response.statusText}`);
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

function joinStopSections(items, timeZone, displayMode) {
  return buildStopSections(items, timeZone, displayMode).join("\n\n────────\n\n");
}

function buildStatusMessage(
  items,
  timeZone,
  stops,
  weatherSummary = null,
  muteStatus = null,
  displayMode = "auto",
) {
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

  lines.push(joinStopSections(items, timeZone, displayMode));
  lines.push("");
  lines.push(`更新时间：${formatArrivalClock(new Date().toISOString(), timeZone)}`);
  lines.push(buildAvailableCommandsHint(stops));
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

function buildDeparturePingKeyboard(pings, windowKey) {
  const [dateKey, windowStart] = windowKey.split("|");
  return {
    inline_keyboard: [
      pings.slice(0, 2).map((ping) => ({
        text: `⏰ ${SNOOZE_MINUTES} 分钟后再提醒 ${ping.serviceNo}`,
        callback_data: `m:snooze:${dateKey}:${windowStart}:${ping.stop.stop_id}:${ping.serviceNo}`,
      })),
      [{ text: "🛑 我上车了", callback_data: "boarded" }],
    ],
  };
}

async function writeConfigBackup(stateFile, state) {
  const backup = {};
  for (const key of CONFIG_BACKUP_KEYS) {
    if (state[key] !== undefined) {
      backup[key] = state[key];
    }
  }

  const snapshot = JSON.stringify(backup);
  const backupPath = path.join(path.dirname(stateFile), CONFIG_BACKUP_FILE);
  try {
    const existing = JSON.parse(await fs.readFile(backupPath, "utf8"));
    if (JSON.stringify(existing.config) === snapshot) {
      return false;
    }
  } catch {
    // no readable backup yet; write a fresh one
  }

  await fs.writeFile(
    backupPath,
    `${JSON.stringify({ savedAt: new Date().toISOString(), config: backup }, null, 2)}\n`,
    "utf8",
  );
  logInfo("config backup updated");
  return true;
}

function buildWindowNoticeMessage(
  items,
  timeZone,
  weatherSummary,
  periodLabel,
  hasTriggered,
  footerLine,
  { displayMode = "auto", rainy = false, leadLine = null } = {},
) {
  const lines = [];

  if (leadLine) {
    lines.push(leadLine);
  }
  lines.push(`⏰ ${periodLabel}出行提醒`, "");

  if (rainy) {
    lines.push("☔ 有雨，记得带伞（已提前提醒）");
    lines.push("");
  }

  if (weatherSummary) {
    lines.push(weatherSummary);
    lines.push("");
    lines.push("────────");
    lines.push("");
  }

  lines.push(joinStopSections(items, timeZone, displayMode));
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

  // Window notices lead with an ETA summary, so the header may be the second line.
  const headerIndex = filtered.findIndex((line) => MUTE_BANNER_HEADERS.has(line));
  if (bannerLine && headerIndex !== -1 && filtered[headerIndex + 1] === "") {
    filtered.splice(headerIndex + 2, 0, bannerLine, "");
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

  if (state.vacationUntil && state.vacationUntil < todayKey) {
    delete state.vacationUntil;
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

  const snoozes = state.departureSnooze;
  if (snoozes && typeof snoozes === "object" && !Array.isArray(snoozes)) {
    for (const key of Object.keys(snoozes)) {
      if (!key.startsWith(`${todayKey}|`)) {
        delete snoozes[key];
      }
    }
    if (Object.keys(snoozes).length === 0) {
      delete state.departureSnooze;
    }
  } else if (snoozes !== undefined) {
    delete state.departureSnooze;
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

// Compares each service's leading bus against where it should be by now and
// reports the ones that quietly slipped or disappeared before arriving.
function collectEtaAnomalies(context, items, windowKey) {
  const tracker = context.etaTracker;
  const nowMs = Date.now();
  const anomalies = [];

  for (const item of items) {
    const key = `${item.stop.stop_id}:${item.serviceNo}`;
    const leading = (item.arrivals || []).find(
      (arrival) => arrival && typeof arrival.duration_ms === "number",
    );
    const currentDurationMs = leading ? leading.duration_ms : null;
    const previous = tracker.get(key);
    const alertKey = `${windowKey}|${key}`;

    if (!context.reportedAnomalies.has(alertKey)) {
      const anomaly = detectEtaAnomaly(previous, currentDurationMs, nowMs);
      if (anomaly) {
        context.reportedAnomalies.add(alertKey);
        anomalies.push({ ...anomaly, stop: item.stop, serviceNo: item.serviceNo });
      }
    }

    if (currentDurationMs === null) {
      tracker.delete(key);
    } else {
      tracker.set(key, { durationMs: currentDurationMs, at: nowMs });
    }
  }

  return anomalies;
}

function buildAnomalyMessage(anomalies) {
  const lines = ["⚠️ 有车没了", ""];

  for (const anomaly of anomalies) {
    lines.push(`🚌 ${anomaly.serviceNo}｜📍 ${anomaly.stop.stop_name}`);
    lines.push(
      anomaly.kind === "vanished"
        ? `   原本还有 ${anomaly.expectedMinutes} 分钟到，现在从班次里消失了`
        : `   原本还有 ${anomaly.expectedMinutes} 分钟，现在要等 ${anomaly.actualMinutes} 分钟`,
    );
  }

  lines.push("");
  lines.push("别白等了，看看其他线路或改走地铁。");
  return lines.join("\n");
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
      isWithinWindow(now, timeZone, window.start, window.end, getActiveWeekdays(state));
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

  const weatherSummary = await context.getWeatherSummary();
  const rainy = isRainyForecast(weatherSummary);
  // Rain means a slower walk and a fuller bus, so start nudging earlier.
  const effectiveThreshold = rainy
    ? defaultThresholdMinutes + context.rainExtraMinutes
    : defaultThresholdMinutes;

  const { items, triggered } = await evaluateWindowServices(
    apiBase,
    windowStops,
    state,
    effectiveThreshold,
    runCache,
  );
  const periodLabel = windowPeriodLabel(activeWindow);
  const displayMode = state.displayMode || "auto";
  const existingNotice = notices[windowKey];

  // Only worth interrupting once the user has been told a bus is coming.
  const anomalies = existingNotice ? collectEtaAnomalies(context, items, windowKey) : [];
  if (anomalies.length > 0) {
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: buildAnomalyMessage(anomalies),
      disable_web_page_preview: true,
      reply_markup: buildTelegramButtons(stops, false),
    });
    for (const anomaly of anomalies) {
      logInfo(`eta anomaly (${anomaly.kind}) for ${anomaly.stop.stop_id}:${anomaly.serviceNo}`);
    }
  }

  if (!existingNotice) {
    if (triggered.length > 0 && items.length > 0) {
      const text = buildWindowNoticeMessage(
        items,
        timeZone,
        weatherSummary,
        periodLabel,
        true,
        `🔄 自动刷新中｜更新时间：${nowClock}`,
        { displayMode, rainy, leadLine: buildLeadLine(items, nowClock) },
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
    const text = buildWindowNoticeMessage(
      items,
      timeZone,
      weatherSummary,
      periodLabel,
      triggered.length > 0,
      `🔄 自动刷新中｜更新时间：${nowClock}`,
      { displayMode, rainy, leadLine: buildLeadLine(items, nowClock) },
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
    const snoozeUntil = state.departureSnooze?.[`${windowKey}|${rowKey}`];
    if (Number.isFinite(snoozeUntil) && Date.now() < snoozeUntil) {
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
      reply_markup: buildDeparturePingKeyboard(pings, windowKey),
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

async function handleSharedLocation(context, message, coordinate) {
  const { token, chatId, state, stops, timeZone, alertWindows } = context;
  const replyMarkup = buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows));

  if (!isPlausibleSingaporeCoordinate(coordinate)) {
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: "这个位置看起来不在新加坡，请确认后再发一次。",
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    return;
  }

  let dataset = null;
  try {
    dataset = await loadStopsDataset(context);
  } catch (error) {
    logInfo(`stops dataset load failed: ${describeError(error)}`);
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: "暂时拿不到站点数据，请稍后再试一次。",
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    return;
  }

  const candidates = findNearestStops(dataset, coordinate, {
    limit: NEARBY_STOP_LIMIT,
    maxMeters: NEARBY_RADIUS_METERS,
  });

  if (candidates.length === 0) {
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: `这个位置 ${NEARBY_RADIUS_METERS} 米内没有找到公交站。\n可以把地图上的图钉挪到路边的车站再发一次。`,
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    return;
  }

  await sendTelegramMessage(token, {
    chat_id: chatId,
    text: buildNearbyStopsMessage(candidates, stops),
    reply_to_message_id: message.message_id,
    disable_web_page_preview: true,
    reply_markup: buildNearbyStopsKeyboard(candidates, stops) || replyMarkup,
  });
  logInfo(`nearby stops offered for ${coordinate.lat},${coordinate.lng}`);
}

async function handleAddStopCallback(context, message, callbackQuery, stopId) {
  const { token, chatId, state, stops, apiBase, runCache } = context;

  if (stops.some((stop) => stop.stop_id === stopId)) {
    await answerTelegramCallbackQuery(token, callbackQuery.id, "该站点已在监控中");
    return;
  }

  let dataset = [];
  try {
    dataset = await loadStopsDataset(context);
  } catch {
    dataset = [];
  }
  const known = dataset.find((stop) => stop.stop_id === stopId);
  const newStop = { stop_id: stopId, stop_name: known?.name || stopId, services: [] };
  stops.push(newStop);
  state.monitoredStops = cloneStops(stops);

  let serviceNumbers = [];
  try {
    const arrivalData = await fetchArrivalsCached(apiBase, stopId, runCache);
    serviceNumbers = (arrivalData.services || []).map((service) => service.no).sort();
  } catch (error) {
    logInfo(`service discovery failed for ${stopId}: ${describeError(error)}`);
  }

  const lines = [`✅ 已添加站点：${newStop.stop_name} (${stopId})`, ""];
  if (serviceNumbers.length > 0) {
    lines.push(`这个站现在经过的线路：${serviceNumbers.join(" / ")}`);
    lines.push("");
    lines.push("点按钮选择要监控的线路。");
  } else {
    lines.push("暂时没查到该站的线路，可以稍后发送：添加线路 <线路号> " + stopId);
  }
  lines.push("");
  lines.push(`改成中文名：重命名 ${stopId} 公司门口`);
  lines.push(`只在某个时段提醒：设置时段 ${stopId} 晚`);

  await sendTelegramMessage(token, {
    chat_id: chatId,
    text: lines.join("\n"),
    disable_web_page_preview: true,
    reply_markup: buildStopServicesKeyboard(stopId, serviceNumbers, []) || undefined,
  });
  await answerTelegramCallbackQuery(token, callbackQuery.id, "站点已添加");
  logInfo(`stop ${stopId} added from shared location`);
}

async function handleAddServiceCallback(context, message, callbackQuery, stopId, serviceNo) {
  const { token, chatId, state, stops, timeZone, alertWindows } = context;
  const targetStop = stops.find((stop) => stop.stop_id === stopId);

  if (!targetStop) {
    await answerTelegramCallbackQuery(token, callbackQuery.id, "站点已不在监控中");
    return;
  }

  if (!(targetStop.services || []).includes(serviceNo)) {
    targetStop.services = Array.from(new Set([...(targetStop.services || []), serviceNo])).sort();
    state.monitoredStops = cloneStops(stops);
    logInfo(`service ${serviceNo} added to stop ${stopId}`);
  }

  await sendTelegramMessage(token, {
    chat_id: chatId,
    text: `✅ 已监控 ${serviceNo}\n站点：${targetStop.stop_name} (${stopId})`,
    disable_web_page_preview: true,
    reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
  });
  await answerTelegramCallbackQuery(token, callbackQuery.id, `已添加 ${serviceNo}`);
}

async function fetchStopServiceNumbers(context, stopId) {
  try {
    const arrivalData = await fetchArrivalsCached(context.apiBase, stopId, context.runCache);
    return (arrivalData.services || []).map((service) => service.no).sort();
  } catch (error) {
    logInfo(`service discovery failed for ${stopId}: ${describeError(error)}`);
    return [];
  }
}

// Menus live in a single message that is edited as the user navigates; only the
// entry point (⚙️ 设置) creates a new one.
async function showMenuScreen(context, message, screen, { asNewMessage = false } = {}) {
  const { token, chatId } = context;

  if (asNewMessage) {
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: screen.text,
      disable_web_page_preview: true,
      reply_markup: screen.replyMarkup,
    });
    return;
  }

  await editTelegramMessageText(
    token,
    chatId,
    message.message_id,
    screen.text,
    screen.replyMarkup,
  );
}

async function handleMenuCallback(context, message, callbackQuery, parsed) {
  const { token, state, stops, timeZone, alertWindows, defaultThresholdMinutes } = context;
  const { action, args } = parsed;
  const findStop = (stopId) => stops.find((stop) => stop.stop_id === stopId);
  let notice = "";

  const openStopScreen = async (stopId) => {
    const stop = findStop(stopId);
    if (!stop) {
      await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
      return;
    }
    await showMenuScreen(context, message, buildStopMenu(stop, state, defaultThresholdMinutes));
  };

  switch (action) {
    case "main":
      // Reached from the ⚙️ button on a status or alert message, which is either
      // live-refreshing or worth keeping, so the menu starts its own message.
      await showMenuScreen(
        context,
        message,
        buildMainMenu(stops, state, defaultThresholdMinutes),
        { asNewMessage: true },
      );
      break;

    case "back":
      await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
      break;

    case "stop":
      await openStopScreen(args[0]);
      break;

    case "routes": {
      const stop = findStop(args[0]);
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      const services = await fetchStopServiceNumbers(context, stop.stop_id);
      await showMenuScreen(context, message, buildRoutesMenu(stop, services));
      break;
    }

    case "svcadd":
    case "svcdel": {
      const stop = findStop(args[0]);
      const serviceNo = args[1];
      if (!stop || !isValidServiceNo(serviceNo)) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      if (action === "svcadd") {
        stop.services = Array.from(new Set([...(stop.services || []), serviceNo])).sort();
        notice = `已添加 ${serviceNo}`;
      } else {
        stop.services = (stop.services || []).filter((item) => item !== serviceNo);
        notice = `已移除 ${serviceNo}`;
      }
      state.monitoredStops = cloneStops(stops);
      logInfo(`${action} ${serviceNo} @ ${stop.stop_id}`);
      const services = await fetchStopServiceNumbers(context, stop.stop_id);
      await showMenuScreen(context, message, buildRoutesMenu(stop, services));
      break;
    }

    case "thr": {
      const stop = findStop(args[0]);
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      await showMenuScreen(
        context,
        message,
        buildThresholdServiceMenu(stop, state, defaultThresholdMinutes),
      );
      break;
    }

    case "thrpick": {
      const stop = findStop(args[0]);
      const serviceNo = args[1];
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      const current = getStopThresholdLines(stop, state, defaultThresholdMinutes).find(
        (row) => row.serviceNo === serviceNo,
      );
      await showMenuScreen(
        context,
        message,
        buildThresholdValueMenu(stop, serviceNo, current?.minutes ?? defaultThresholdMinutes),
      );
      break;
    }

    case "thrset": {
      const stop = findStop(args[0]);
      const serviceNo = args[1];
      const minutes = Number(args[2]);
      if (!stop || !isValidServiceNo(serviceNo) || !Number.isFinite(minutes)) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      state.serviceThresholdMinutes = {
        ...(state.serviceThresholdMinutes || {}),
        [serviceNo]: minutes,
      };
      notice = `${serviceNo} 改为提前 ${minutes} 分钟`;
      logInfo(`threshold ${serviceNo} = ${minutes}m`);
      await showMenuScreen(context, message, buildThresholdValueMenu(stop, serviceNo, minutes));
      break;
    }

    case "period": {
      const stop = findStop(args[0]);
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      await showMenuScreen(context, message, buildPeriodMenu(stop));
      break;
    }

    case "periodset": {
      const stop = findStop(args[0]);
      const period = args[1];
      if (!stop || !["早", "晚", "全部"].includes(period)) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      if (period === "全部") {
        delete stop.periods;
      } else {
        stop.periods = [period];
      }
      state.monitoredStops = cloneStops(stops);
      notice = period === "全部" ? "早晚都提醒" : `只在${period}高峰提醒`;
      logInfo(`period ${stop.stop_id} = ${period}`);
      await showMenuScreen(context, message, buildPeriodMenu(stop));
      break;
    }

    case "win":
      await showMenuScreen(context, message, buildWindowsMenu(alertWindows));
      break;

    case "winpick": {
      const index = Number(args[0]);
      const window = alertWindows[index];
      if (!window) {
        await showMenuScreen(context, message, buildWindowsMenu(alertWindows));
        break;
      }
      await showMenuScreen(context, message, buildWindowEditMenu(index, window));
      break;
    }

    case "wintime": {
      const index = Number(args[0]);
      const field = args[1];
      const window = alertWindows[index];
      if (!window || (field !== "start" && field !== "end")) {
        await showMenuScreen(context, message, buildWindowsMenu(alertWindows));
        break;
      }
      await showMenuScreen(context, message, buildWindowTimeMenu(index, window, field));
      break;
    }

    case "winset": {
      const index = Number(args[0]);
      const field = args[1];
      const time = args[2];
      const window = alertWindows[index];
      if (!window || (field !== "start" && field !== "end") || !/^\d{2}:\d{2}$/.test(time)) {
        await showMenuScreen(context, message, buildWindowsMenu(alertWindows));
        break;
      }

      const updated = applyWindowTime(window, field, time);
      const nextWindows = alertWindows.map((item, itemIndex) =>
        itemIndex === index ? updated : { start: item.start, end: item.end },
      );
      state.alertWindowsOverride = nextWindows;
      context.alertWindows = nextWindows;
      notice = `${updated.start}-${updated.end}`;
      logInfo(`alert window ${index} set to ${updated.start}-${updated.end}`);
      await showMenuScreen(context, message, buildWindowTimeMenu(index, updated, field));
      break;
    }

    case "vac": {
      const todayKey = formatDateKey(new Date(), timeZone);
      await showMenuScreen(context, message, buildVacationMenu(state.vacationUntil, todayKey));
      break;
    }

    case "vacset": {
      const days = Number(args[0]);
      const todayKey = formatDateKey(new Date(), timeZone);
      if (days > 0) {
        state.vacationUntil = addDaysToDateKey(todayKey, days);
        notice = `休假到 ${state.vacationUntil}`;
      } else {
        delete state.vacationUntil;
        notice = "休假已结束";
      }
      logInfo(`vacation until ${state.vacationUntil || "none"}`);
      await showMenuScreen(context, message, buildVacationMenu(state.vacationUntil, todayKey));
      break;
    }

    case "days":
      await showMenuScreen(context, message, buildWeekdaysMenu(state.activeWeekdays));
      break;

    case "daytoggle": {
      const day = args[0];
      const current = normalizeActiveWeekdays(state.activeWeekdays);
      const next = current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day];
      state.activeWeekdays = normalizeActiveWeekdays(next);
      notice = describeActiveWeekdays(state.activeWeekdays);
      logInfo(`active weekdays = ${state.activeWeekdays.join(",")}`);
      await showMenuScreen(context, message, buildWeekdaysMenu(state.activeWeekdays));
      break;
    }

    case "display":
      await showMenuScreen(context, message, buildDisplayMenu(state.displayMode || "auto"));
      break;

    case "displayset": {
      const mode = args[0];
      if (!["auto", "compact", "detailed"].includes(mode)) {
        break;
      }
      if (mode === "auto") {
        delete state.displayMode;
      } else {
        state.displayMode = mode;
      }
      notice = "显示方式已更新";
      await showMenuScreen(context, message, buildDisplayMenu(mode));
      break;
    }

    case "stats": {
      const stats = await readBoardingStatsFromStore(context.stateFile);
      await showMenuScreen(context, message, buildStatsMenu(stats, alertWindows));
      break;
    }

    case "snooze": {
      const windowKey = `${args[0]}|${args[1]}`;
      const rowKey = `${args[2]}:${args[3]}`;
      const until = Date.now() + SNOOZE_MINUTES * 60 * 1000;
      if (!state.departureSnooze || typeof state.departureSnooze !== "object") {
        state.departureSnooze = {};
      }
      state.departureSnooze[`${windowKey}|${rowKey}`] = until;
      if (Array.isArray(state.departurePings?.[windowKey])) {
        state.departurePings[windowKey] = state.departurePings[windowKey].filter(
          (item) => item !== rowKey,
        );
      }
      notice = `好，${SNOOZE_MINUTES} 分钟后再提醒`;
      logInfo(`departure ping snoozed for ${rowKey}`);
      await answerTelegramCallbackQuery(token, callbackQuery.id, notice);
      return;
    }

    case "walk":
      await showMenuScreen(context, message, buildWalkMenu(state));
      break;

    case "walkset": {
      const minutes = Number(args[0]);
      if (minutes > 0) {
        state.walkMinutesDefault = minutes;
        notice = `步行 ${minutes} 分钟`;
      } else {
        delete state.walkMinutesDefault;
        delete state.walkMinutesByStop;
        notice = "出门提醒已关闭";
      }
      logInfo(`walk default = ${minutes || "off"}`);
      await showMenuScreen(context, message, buildWalkMenu(state));
      break;
    }

    case "add":
      await showMenuScreen(context, message, buildAddStopMenu());
      break;

    case "rename": {
      const stop = findStop(args[0]);
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      await sendTelegramMessage(token, {
        chat_id: context.chatId,
        text: buildRenamePrompt(stop),
        reply_markup: { force_reply: true },
      });
      notice = "请回复新名字";
      break;
    }

    case "del": {
      const stop = findStop(args[0]);
      if (!stop) {
        await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
        break;
      }
      await showMenuScreen(context, message, buildDeleteConfirmMenu(stop));
      break;
    }

    case "delok": {
      const index = stops.findIndex((stop) => stop.stop_id === args[0]);
      if (index !== -1) {
        const [removed] = stops.splice(index, 1);
        state.monitoredStops = cloneStops(stops);
        notice = `已删除 ${removed.stop_name}`;
        logInfo(`stop ${removed.stop_id} deleted`);
      }
      await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
      break;
    }

    case "close":
      await editTelegramMessageText(
        token,
        context.chatId,
        message.message_id,
        "⚙️ 设置已关闭",
        buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      );
      break;

    default:
      await showMenuScreen(context, message, buildMainMenu(stops, state, defaultThresholdMinutes));
      break;
  }

  await answerTelegramCallbackQuery(token, callbackQuery.id, notice);
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

    const sharedLocation = update.message?.location || update.message?.venue?.location;
    if (!callbackQuery && sharedLocation) {
      await handleSharedLocation(context, message, {
        lat: sharedLocation.latitude,
        lng: sharedLocation.longitude,
      });
      continue;
    }

    // A reply to the rename prompt carries the stop id in the quoted text, so no
    // pending-operation state has to survive across restarts.
    const renameTargetId = !callbackQuery
      ? parseRenamePrompt(update.message?.reply_to_message?.text)
      : null;
    if (renameTargetId) {
      const newName = (message.text || "").trim();
      const renameStop = stops.find((stop) => stop.stop_id === renameTargetId);
      let replyText;
      if (!renameStop) {
        replyText = `站点 ${renameTargetId} 已不在监控中。`;
      } else if (!isValidStopName(newName)) {
        replyText = "名称无效，请控制在 80 字以内且不要换行。";
      } else {
        const previousName = renameStop.stop_name;
        renameStop.stop_name = newName;
        state.monitoredStops = cloneStops(stops);
        replyText = `✅ 已改名：${previousName} → ${newName}`;
        logInfo(`stop ${renameTargetId} renamed`);
      }

      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: replyText,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildMainMenu(stops, state, defaultThresholdMinutes).replyMarkup,
      });
      continue;
    }

    let text = normalizeSlashCommand((message.text || "").trim());
    if (callbackQuery) {
      const data = String(callbackQuery.data || "");
      const menuCallback = parseMenuCallback(data);
      if (menuCallback) {
        await handleMenuCallback(context, message, callbackQuery, menuCallback);
        continue;
      }
      if (data.startsWith("addstop:")) {
        await handleAddStopCallback(context, message, callbackQuery, data.slice("addstop:".length));
        continue;
      }
      if (data.startsWith("addsvc:")) {
        const [, stopId, serviceNo] = data.split(":");
        await handleAddServiceCallback(context, message, callbackQuery, stopId, serviceNo);
        continue;
      }

      switch (data) {
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
          text = parseServiceCallbackData(data) || "";
      }
    }
    if (!text) {
      continue;
    }

    let requestedServices = null;
    const todayKey = formatDateKey(new Date(), timeZone);

    if (text === "上车了") {
      const { hour, minute, second } = getLocalParts(new Date(), timeZone);
      const targetWindow = pickBoardedWindow(hour * 60 + minute, alertWindows);
      const targetKey = targetWindow ? windowKeyFor(todayKey, targetWindow) : null;
      if (targetKey) {
        addMutedWindowKey(state, targetKey);
        const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
        await logBoardingToStore(context.stateFile, targetKey, clock);
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
        if (
          window &&
          isWithinWindow(
            nowForResume,
            timeZone,
            window.start,
            window.end,
            getActiveWeekdays(state),
          )
        ) {
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
    } else if (text === "配置" || text === "设置" || text === "菜单") {
      const menu = buildMainMenu(stops, state, defaultThresholdMinutes);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: menu.text,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: menu.replyMarkup,
      });
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
    } else if (!callbackQuery && looksLikeLocationInput(text)) {
      let coordinate = null;
      try {
        coordinate = await resolveCoordinateFromText(text);
      } catch (error) {
        logInfo(`map link resolution failed: ${describeError(error)}`);
      }

      if (!coordinate) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: [
            "没能从这个链接里读出坐标。",
            "",
            "最稳的方式：用 Telegram 的 📎 附件 → 位置（Location），把图钉拖到车站再发送。",
            "也可以在 Google 地图里长按目标点，把最下方显示的一串坐标（例如 1.32049,103.76389）直接发给我。",
          ].join("\n"),
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
        });
        continue;
      }

      await handleSharedLocation(context, message, coordinate);
      continue;
    } else if (/^重命名\s+\S+\s+.+/.test(text)) {
      const match = /^重命名\s+(\S+)\s+(.+)$/.exec(text);
      const renameStop = findStopByIdentifier(stops, match[1]);
      const newName = match[2].trim();
      const replyMarkup = buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows));

      if (!renameStop) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "没有找到你指定的站点，可用站点请先发送：配置",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
        continue;
      }

      if (!isValidStopName(newName)) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "名称无效，请控制在 80 字以内且不要换行。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
        continue;
      }

      const previousName = renameStop.stop_name;
      renameStop.stop_name = newName;
      state.monitoredStops = cloneStops(stops);
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已重命名：${previousName} → ${newName} (${renameStop.stop_id})`,
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
        buildStatusMessage(statuses, timeZone, stops, weatherSummary, muteStatus, state.displayMode),
        buildTelegramButtons(stops, isProactiveMutedNow(state, timeZone, alertWindows)),
      );
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: buildStatusMessage(statuses, timeZone, stops, weatherSummary, muteStatus, state.displayMode),
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
  const parsedHistoryKeepDays = Number(env.HISTORY_KEEP_DAYS);
  const historyKeepDays =
    Number.isFinite(parsedHistoryKeepDays) && parsedHistoryKeepDays > 0
      ? parsedHistoryKeepDays
      : 180;
  const parsedRainExtra = Number(env.RAIN_EXTRA_MINUTES);
  const rainExtraMinutes =
    Number.isFinite(parsedRainExtra) && parsedRainExtra >= 0 ? parsedRainExtra : 3;
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
      alertWindows: loadEffectiveWindows(state, alertWindows),
      defaultThresholdMinutes: maxMinutes,
      rainExtraMinutes,
      stateFile,
      holidays,
      stops: [],
      runCache: null,
      weatherCache: { summary: null, fetchedAt: 0, lastAttemptAt: 0 },
      holidayLoggedFor: null,
      lastWindowLog: null,
      etaTracker: new Map(),
      reportedAnomalies: new Set(),
    };
    context.getWeatherSummary = () => getWeatherSummaryCached(context, weatherConfig, nowcastArea);

    let lastPersisted = JSON.stringify(state);
    const persistIfDirty = async () => {
      const snapshot = JSON.stringify(state);
      if (snapshot !== lastPersisted) {
        await writeStateFromStore(stateFile, state);
        lastPersisted = snapshot;
        try {
          await writeConfigBackup(stateFile, state);
        } catch (error) {
          logInfo(`config backup failed: ${describeError(error)}`);
        }
      }
    };

    const singleCycle = mode === "once";
    let lastProactiveAt = 0;
    let lastHeartbeatAt = Date.now();

    logInfo(
      `daemon started, windows=${context.alertWindows
        .map((w) => `${w.start}-${w.end}`)
        .join(",")}, timezone=${timeZone}`,
    );

    try {
      await registerBotCommands(token);
    } catch (error) {
      logInfo(`bot command registration skipped: ${describeError(error)}`);
    }

    // Back up on boot too: a config that never changes again would otherwise
    // never get a backup, which is exactly the case worth protecting.
    try {
      await writeConfigBackup(stateFile, state);
    } catch (error) {
      logInfo(`config backup failed: ${describeError(error)}`);
    }

    const prunedRows = await pruneHistoryFromStore(stateFile, historyKeepDays);
    if (prunedRows > 0) {
      logInfo(`pruned ${prunedRows} history rows older than ${historyKeepDays} days`);
    }

    do {
      let cycleFailed = false;
      try {
        const now = new Date();
        context.stops = loadEffectiveStops(state, defaultStops);
        context.alertWindows = loadEffectiveWindows(state, alertWindows);
        context.runCache = { arrivals: new Map() };
        cleanupState(state, now.toISOString(), timeZone);

        const activeWindow = findActiveWindow(now, timeZone, context.alertWindows);
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
        logInfo(`cycle failed (streak=${state.failureStreak}): ${describeError(error)}`);
        if (state.failureStreak === failureAlertAfter) {
          try {
            await sendTelegramMessage(token, {
              chat_id: chatId,
              text: `⚠️ 机器人连续 ${failureAlertAfter} 次循环失败，请检查日志。\n最近错误：${describeError(error)}`,
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
