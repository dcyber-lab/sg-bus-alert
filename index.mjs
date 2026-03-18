#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const ENV_PATH = path.join(process.cwd(), ".env");
const execFileAsync = promisify(execFile);

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

function formatLocalDateTime(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return formatter.format(date);
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
  if (Array.isArray(state.monitoredStops) && state.monitoredStops.length > 0) {
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

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

function buildTelegramButtons(isMuted) {
  return {
    inline_keyboard: [
      [
        { text: "🚏 查看状态", callback_data: "status_all" },
        { text: "🚌 189", callback_data: "status_189" },
        { text: "🚌 963", callback_data: "status_963" },
      ],
      isMuted
        ? [{ text: "🔔 恢复提醒", callback_data: "resume" }]
        : [
            { text: "🛑 我上车了", callback_data: "boarded" },
            { text: "🔕 暂停今天", callback_data: "mute" },
          ],
    ],
  };
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
  lines.push(`可发送：状态 / 189 / 963 / 上车了 / 暂停 / 恢复 / 配置`);
  return lines.join("\n");
}

function buildConfigMessage(stops, state, defaultThresholdMinutes) {
  const lines = ["⚙️ 当前配置", ""];

  for (const stop of stops) {
    lines.push(`📍 ${stop.stop_name} (${stop.stop_id})`);
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

  lines.push("可发送：");
  lines.push("添加线路 190");
  lines.push("删除线路 963");
  lines.push("阈值 189 6");
  return lines.join("\n");
}

function buildMorningAlertMessage(items, timeZone, weatherSummary = null) {
  const lines = ["⏰ 早高峰主动提醒", ""];

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

function applyMuteBannerToMessageText(text, isMuted) {
  const lines = String(text || "").split("\n");
  const filtered = lines.filter(
    (line) => line !== "🔕 今天已暂停" && line !== "🔔 今天的主动提醒：开启中",
  );

  if (
    filtered.length >= 2 &&
    (filtered[0] === "🚏 当前公交状态" ||
      filtered[0] === "🚏 手动查询状态" ||
      filtered[0] === "⏰ 晨间通知" ||
      filtered[0] === "⏰ 早高峰主动提醒") &&
    filtered[1] === ""
  ) {
    filtered.splice(2, 0, isMuted ? "🔕 今天已暂停" : "🔔 今天的主动提醒：开启中", "");
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

async function discoverServiceCandidateStops(apiBase, stops, serviceNo) {
  const candidates = [];

  for (const stop of stops) {
    const arrivalData = await fetchArrivals(apiBase, stop.stop_id);
    const services = arrivalData.services || [];
    if (services.some((service) => service.no === serviceNo)) {
      candidates.push(stop);
    }
  }

  return candidates;
}

async function processTelegramCommands(
  token,
  chatId,
  state,
  apiBase,
  stops,
  timeZone,
  weatherConfig,
  defaultThresholdMinutes,
) {
  const offset =
    typeof state.telegramUpdateOffset === "number" ? state.telegramUpdateOffset : undefined;
  const updates = await fetchTelegramUpdates(token, offset);

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
        case "status_189":
          text = "189";
          break;
        case "status_963":
          text = "963";
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
          text = "";
      }
    }
    if (!text) {
      continue;
    }

    let requestedServices = null;
    const todayKey = formatDateKey(new Date(), timeZone);

    if (text === "上车了" || text === "暂停") {
      state.mutedUntilDateKey = todayKey;
      if (callbackQuery) {
        await editTelegramMessageText(
          token,
          chatId,
          message.message_id,
          applyMuteBannerToMessageText(message.text, true),
          buildTelegramButtons(true),
        );
        await answerTelegramCallbackQuery(token, callbackQuery.id, "今天已暂停");
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "🔕 今天的主动提醒已暂停。\n如需恢复，请发送：恢复",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(true),
        });
      }
      continue;
    } else if (text === "恢复") {
      delete state.mutedUntilDateKey;
      if (callbackQuery) {
        await editTelegramMessageText(
          token,
          chatId,
          message.message_id,
          applyMuteBannerToMessageText(message.text, false),
          buildTelegramButtons(false),
        );
        await answerTelegramCallbackQuery(token, callbackQuery.id, "提醒已恢复");
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "🔔 今天的主动提醒已恢复。",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(false),
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
          buildTelegramButtons(state.mutedUntilDateKey === todayKey),
        );
      } else {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: buildConfigMessage(stops, state, defaultThresholdMinutes),
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
        });
      }
      if (callbackQuery) {
        await answerTelegramCallbackQuery(token, callbackQuery.id);
      }
      continue;
    } else if (text === "状态" || text.toLowerCase() === "status") {
      requestedServices = null;
    } else if (/^\d+$/.test(text)) {
      requestedServices = new Set([text]);
    } else if (/^添加线路\s+\S+/.test(text)) {
      const match = /^添加线路\s+(\S+)(?:\s+(.+))?$/.exec(text);
      const serviceNo = match?.[1];
      const stopIdentifier = match?.[2]?.trim();

      if (stops.some((stop) => (stop.services || []).includes(serviceNo))) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `线路 ${serviceNo} 已在当前监控配置中。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
        });
        continue;
      }

      let targetStop = null;
      if (stopIdentifier) {
        targetStop = findStopByIdentifier(stops, stopIdentifier);
      } else if (stops.length === 1) {
        targetStop = stops[0];
      } else {
        const candidates = await discoverServiceCandidateStops(apiBase, stops, serviceNo);
        if (candidates.length === 1) {
          targetStop = candidates[0];
        } else if (candidates.length === 0) {
          await sendTelegramMessage(token, {
            chat_id: chatId,
            text: `无法自动判断线路 ${serviceNo} 属于哪个站点，请这样发送：\n添加线路 ${serviceNo} 17379\n或\n添加线路 ${serviceNo} 金文泰大牌304`,
            reply_to_message_id: message.message_id,
            disable_web_page_preview: true,
            reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
          });
          continue;
        } else {
          await sendTelegramMessage(token, {
            chat_id: chatId,
            text: `线路 ${serviceNo} 在多个已监控站点都可能存在，请指定站点。`,
            reply_to_message_id: message.message_id,
            disable_web_page_preview: true,
            reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
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
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
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
        reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
      });
      continue;
    } else if (/^删除线路\s+\S+/.test(text)) {
      const match = /^删除线路\s+(\S+)(?:\s+(.+))?$/.exec(text);
      const serviceNo = match?.[1];
      const stopIdentifier = match?.[2]?.trim();
      const matchedStops = stops.filter((stop) => (stop.services || []).includes(serviceNo));

      if (matchedStops.length === 0) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: `线路 ${serviceNo} 当前不在监控配置中。`,
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
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
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
        });
        continue;
      }

      if (!targetStop) {
        await sendTelegramMessage(token, {
          chat_id: chatId,
          text: "没有找到你指定的站点，可用站点请先发送：配置",
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
          reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
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
        reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
      });
      continue;
    } else if (/^阈值\s+\S+\s+\d+$/.test(text)) {
      const match = /^阈值\s+(\S+)\s+(\d+)$/.exec(text);
      const serviceNo = match?.[1];
      const minutes = Number(match?.[2]);
      state.serviceThresholdMinutes = {
        ...(state.serviceThresholdMinutes || {}),
        [serviceNo]: minutes,
      };
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: `✅ 已设置线路 ${serviceNo} 的提醒阈值为 ${minutes} 分钟。`,
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
      });
      continue;
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: "可用命令：\n状态\n189\n963\n配置\n添加线路 190\n删除线路 963\n阈值 189 6",
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
      });
      if (callbackQuery) {
        await answerTelegramCallbackQuery(token, callbackQuery.id);
      }
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

    if (callbackQuery) {
      await editTelegramMessageText(
        token,
        chatId,
        message.message_id,
        buildStatusMessage(statuses, timeZone, weatherSummary, muteStatus),
        buildTelegramButtons(state.mutedUntilDateKey === todayKey),
      );
    } else {
      await sendTelegramMessage(token, {
        chat_id: chatId,
        text: buildStatusMessage(statuses, timeZone, weatherSummary, muteStatus),
        reply_to_message_id: message.message_id,
        disable_web_page_preview: true,
        reply_markup: buildTelegramButtons(state.mutedUntilDateKey === todayKey),
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
  const defaultStops = JSON.parse(required(env, "STOP_CONFIG_JSON"));

  if (!Array.isArray(defaultStops) || defaultStops.length === 0) {
    throw new Error("STOP_CONFIG_JSON must be a non-empty JSON array");
  }

  if (mode === "test") {
    const token = required(env, "TELEGRAM_BOT_TOKEN");
    const chatId = required(env, "TELEGRAM_CHAT_ID");
    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: "✅ 测试消息\nTelegram 机器人配置正常。",
      disable_web_page_preview: true,
      reply_markup: buildTelegramButtons(false),
    });
    console.log("Sent Telegram test message.");
    return;
  }

  const now = new Date();
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_CHAT_ID");
  const state = await readState(stateFile);
  const stops = loadEffectiveStops(state, defaultStops);
  cleanupState(state, now.toISOString());
  logInfo(
    `run at ${formatLocalDateTime(now, timeZone)} ${timeZone}, window ${windowStart}-${windowEnd}, muted=${
      state.mutedUntilDateKey === formatDateKey(now, timeZone) ? "yes" : "no"
    }`,
  );
  await processTelegramCommands(
    token,
    chatId,
    state,
    apiBase,
    stops,
    timeZone,
    weatherConfig,
    maxMinutes,
  );
  const todayKey = formatDateKey(now, timeZone);

  if (!isWithinWindow(now, timeZone, windowStart, windowEnd)) {
    await writeState(stateFile, state);
    logInfo("outside configured alert window, proactive morning notification skipped");
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

      const thresholdMinutes = getServiceThresholdMinutes(state, maxMinutes, serviceNo);
      const selectedArrival = selectArrival(service, thresholdMinutes);
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

    await sendTelegramMessage(token, {
      chat_id: chatId,
      text: buildMorningAlertMessage(pendingAlerts, timeZone, weatherSummary),
      disable_web_page_preview: true,
      reply_markup: buildTelegramButtons(false),
    });

    for (const alert of pendingAlerts) {
      state.alerts[alert.stateKey] = {
        lastArrivalTime: alert.selectedArrival.time,
        lastSentAt: now.toISOString(),
      };
      logInfo(`morning alert included stop ${alert.stop.stop_id} service ${alert.serviceNo}`);
    }
  } else if (pendingAlerts.length > 0 && state.mutedUntilDateKey === todayKey) {
    logInfo("morning alert candidates found, but proactive notification muted for today");
  } else {
    logInfo("no services matched proactive morning threshold in this run");
  }

  await writeState(stateFile, state);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
