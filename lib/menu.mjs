// Button-driven settings UI. Every screen is a (text, keyboard) pair rendered
// into one message that gets edited in place as the user navigates, so the chat
// never fills up with menu messages.

import {
  describeActiveWeekdays,
  hhmmToMinute,
  normalizeActiveWeekdays,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  windowPeriodLabel,
} from "./runtime-helpers.mjs";

export const THRESHOLD_CHOICES = [3, 5, 6, 8, 10, 12];
export const WALK_CHOICES = [2, 3, 4, 5, 6, 8, 10];
export const MAX_ADDABLE_SERVICE_BUTTONS = 12;
export const TIME_STEP_MINUTES = 30;
export const TIME_SPAN_MINUTES = 120;
export const MIN_WINDOW_MINUTES = 30;

export function minuteToHhmm(minute) {
  const clamped = Math.max(0, Math.min(23 * 60 + 30, minute));
  const hours = String(Math.floor(clamped / 60)).padStart(2, "0");
  const minutes = String(clamped % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// A grid centred on the current value: far enough to retime a commute, small
// enough to stay one screen of buttons.
export function generateTimeChoices(currentHhmm) {
  const current = hhmmToMinute(currentHhmm);
  const choices = [];
  for (let offset = -TIME_SPAN_MINUTES; offset <= TIME_SPAN_MINUTES; offset += TIME_STEP_MINUTES) {
    const minute = current + offset;
    if (minute < 0 || minute > 23 * 60 + 30) {
      continue;
    }
    choices.push(minuteToHhmm(minute));
  }
  return choices;
}

// `m:main` opens a fresh settings message; `m:back` re-renders the one already
// on screen, so navigating never leaves a trail of menu messages.
export const BACK_BUTTON = { text: "🔙 返回", callback_data: "m:back" };

export function getStopThresholdLines(stop, state, defaultThresholdMinutes) {
  const overrides = state.serviceThresholdMinutes || {};
  return (stop.services || []).map((serviceNo) => {
    const minutes = Number.isFinite(overrides[serviceNo])
      ? overrides[serviceNo]
      : defaultThresholdMinutes;
    return { serviceNo, minutes };
  });
}

export function describeStopPeriod(stop) {
  if (!Array.isArray(stop.periods) || stop.periods.length === 0) {
    return "全部时段";
  }
  return stop.periods.map((period) => `只${period}高峰`).join("、");
}

export function getStopWalkMinutes(stop, state) {
  const byStop = state.walkMinutesByStop || {};
  if (Number.isFinite(byStop[stop.stop_id])) {
    return { minutes: byStop[stop.stop_id], source: "stop" };
  }
  if (Number.isFinite(state.walkMinutesDefault)) {
    return { minutes: state.walkMinutesDefault, source: "default" };
  }
  return { minutes: null, source: "none" };
}

export function buildMainMenu(stops, state, defaultThresholdMinutes) {
  const lines = ["⚙️ 设置", ""];

  if (stops.length === 0) {
    lines.push("还没有监控任何站点。");
    lines.push("点「➕ 添加站点」，把车站位置发给我就行。");
  } else {
    for (const stop of stops) {
      lines.push(`📍 ${stop.stop_name} (${stop.stop_id})`);
      const thresholds = getStopThresholdLines(stop, state, defaultThresholdMinutes);
      if (thresholds.length === 0) {
        lines.push("   暂无监控线路");
      } else {
        for (const { serviceNo, minutes } of thresholds) {
          lines.push(`   🚌 ${serviceNo}｜提前 ${minutes} 分钟提醒`);
        }
      }
      const walk = getStopWalkMinutes(stop, state);
      if (walk.minutes !== null) {
        lines.push(`   🚶 步行 ${walk.minutes} 分钟${walk.source === "default" ? "（默认）" : ""}`);
      }
      lines.push(`   🕐 ${describeStopPeriod(stop)}`);
      lines.push("");
    }
  }

  lines.push("点站点名进入设置。");

  const inlineKeyboard = stops.map((stop) => [
    { text: `📍 ${stop.stop_name}`, callback_data: `m:stop:${stop.stop_id}` },
  ]);
  inlineKeyboard.push([
    { text: "➕ 添加站点", callback_data: "m:add" },
    { text: "🚶 出门提醒", callback_data: "m:walk" },
  ]);
  inlineKeyboard.push([
    { text: "🕐 提醒时间段", callback_data: "m:win" },
    { text: "📅 生效星期", callback_data: "m:days" },
  ]);
  inlineKeyboard.push([
    { text: "📊 我的统计", callback_data: "m:stats" },
    { text: "🖥 显示方式", callback_data: "m:display" },
  ]);
  inlineKeyboard.push([{ text: "❌ 关闭", callback_data: "m:close" }]);

  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: inlineKeyboard } };
}

export function buildStopMenu(stop, state, defaultThresholdMinutes) {
  const lines = [`📍 ${stop.stop_name} (${stop.stop_id})`, ""];
  const thresholds = getStopThresholdLines(stop, state, defaultThresholdMinutes);

  if (thresholds.length === 0) {
    lines.push("🚌 还没有选择线路");
  } else {
    lines.push("🚌 监控中的线路：");
    for (const { serviceNo, minutes } of thresholds) {
      lines.push(`   ${serviceNo}｜提前 ${minutes} 分钟提醒`);
    }
  }

  const walk = getStopWalkMinutes(stop, state);
  lines.push(
    walk.minutes === null
      ? "🚶 出门提醒：未开启"
      : `🚶 步行 ${walk.minutes} 分钟${walk.source === "default" ? "（默认）" : ""}`,
  );
  lines.push(`🕐 ${describeStopPeriod(stop)}`);

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "🚌 管理线路", callback_data: `m:routes:${stop.stop_id}` }],
        [
          { text: "⏱ 提醒时间", callback_data: `m:thr:${stop.stop_id}` },
          { text: "🕐 提醒时段", callback_data: `m:period:${stop.stop_id}` },
        ],
        [
          { text: "✏️ 改名字", callback_data: `m:rename:${stop.stop_id}` },
          { text: "🗑 删除站点", callback_data: `m:del:${stop.stop_id}` },
        ],
        [BACK_BUTTON],
      ],
    },
  };
}

export function buildRoutesMenu(stop, availableServices) {
  const monitored = stop.services || [];
  const addable = (availableServices || [])
    .filter((serviceNo) => !monitored.includes(serviceNo))
    .slice(0, MAX_ADDABLE_SERVICE_BUTTONS);

  const lines = [`🚌 ${stop.stop_name} 的线路`, ""];
  lines.push(monitored.length > 0 ? `已监控：${monitored.join(" / ")}` : "还没有监控任何线路");
  lines.push("");
  if (addable.length > 0) {
    lines.push("点 ➕ 添加，点 ➖ 取消监控。");
  } else if ((availableServices || []).length > 0) {
    lines.push("该站的线路都已在监控中。");
  } else {
    lines.push("暂时查不到该站经过的线路，请稍后再试。");
  }

  const inlineKeyboard = [];
  for (let index = 0; index < monitored.length; index += 3) {
    inlineKeyboard.push(
      monitored.slice(index, index + 3).map((serviceNo) => ({
        text: `➖ ${serviceNo}`,
        callback_data: `m:svcdel:${stop.stop_id}:${serviceNo}`,
      })),
    );
  }
  for (let index = 0; index < addable.length; index += 3) {
    inlineKeyboard.push(
      addable.slice(index, index + 3).map((serviceNo) => ({
        text: `➕ ${serviceNo}`,
        callback_data: `m:svcadd:${stop.stop_id}:${serviceNo}`,
      })),
    );
  }
  inlineKeyboard.push([{ text: "🔙 返回", callback_data: `m:stop:${stop.stop_id}` }]);

  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: inlineKeyboard } };
}

export function buildThresholdServiceMenu(stop, state, defaultThresholdMinutes) {
  const thresholds = getStopThresholdLines(stop, state, defaultThresholdMinutes);

  if (thresholds.length === 0) {
    return {
      text: `⏱ ${stop.stop_name}\n\n还没有监控线路，先去「管理线路」添加。`,
      replyMarkup: {
        inline_keyboard: [[{ text: "🔙 返回", callback_data: `m:stop:${stop.stop_id}` }]],
      },
    };
  }

  return {
    text: [
      `⏱ ${stop.stop_name}`,
      "",
      "车还有多久到站时提醒你，选择要调整的线路：",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...thresholds.map(({ serviceNo, minutes }) => [
          {
            text: `🚌 ${serviceNo}｜现在 ${minutes} 分钟`,
            callback_data: `m:thrpick:${stop.stop_id}:${serviceNo}`,
          },
        ]),
        [{ text: "🔙 返回", callback_data: `m:stop:${stop.stop_id}` }],
      ],
    },
  };
}

export function buildThresholdValueMenu(stop, serviceNo, currentMinutes) {
  const rows = [];
  for (let index = 0; index < THRESHOLD_CHOICES.length; index += 3) {
    rows.push(
      THRESHOLD_CHOICES.slice(index, index + 3).map((minutes) => ({
        text: minutes === currentMinutes ? `✅ ${minutes} 分钟` : `${minutes} 分钟`,
        callback_data: `m:thrset:${stop.stop_id}:${serviceNo}:${minutes}`,
      })),
    );
  }
  rows.push([{ text: "🔙 返回", callback_data: `m:thr:${stop.stop_id}` }]);

  return {
    text: [
      `⏱ ${serviceNo}｜${stop.stop_name}`,
      "",
      `当前：车还有 ${currentMinutes} 分钟到站时提醒`,
      "",
      "选一个新的提醒时间：",
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function buildPeriodMenu(stop) {
  return {
    text: [
      `🕐 ${stop.stop_name} 的提醒时段`,
      "",
      `当前：${describeStopPeriod(stop)}`,
      "",
      "早高峰盯家附近的站，晚高峰盯公司附近的站。",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "🌅 只早高峰", callback_data: `m:periodset:${stop.stop_id}:早` },
          { text: "🌆 只晚高峰", callback_data: `m:periodset:${stop.stop_id}:晚` },
        ],
        [{ text: "🔄 早晚都要", callback_data: `m:periodset:${stop.stop_id}:全部` }],
        [{ text: "🔙 返回", callback_data: `m:stop:${stop.stop_id}` }],
      ],
    },
  };
}

export function buildWalkMenu(state) {
  const current = Number.isFinite(state.walkMinutesDefault) ? state.walkMinutesDefault : null;
  const rows = [];
  for (let index = 0; index < WALK_CHOICES.length; index += 3) {
    rows.push(
      WALK_CHOICES.slice(index, index + 3).map((minutes) => ({
        text: minutes === current ? `✅ ${minutes} 分钟` : `${minutes} 分钟`,
        callback_data: `m:walkset:${minutes}`,
      })),
    );
  }
  rows.push([{ text: current === null ? "已关闭" : "🚫 关闭出门提醒", callback_data: "m:walkset:0" }]);
  rows.push([BACK_BUTTON]);

  return {
    text: [
      "🚶 出门提醒",
      "",
      current === null
        ? "未开启。设置你从家走到车站需要几分钟，"
        : `当前：步行 ${current} 分钟。`,
      "当有车正好赶得上时，我会单独提醒你现在出门。",
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function buildDeleteConfirmMenu(stop) {
  const services = stop.services || [];
  return {
    text: [
      `🗑 确认删除站点？`,
      "",
      `${stop.stop_name} (${stop.stop_id})`,
      services.length > 0 ? `其下的线路 ${services.join(" / ")} 也会一并移除。` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ 确认删除", callback_data: `m:delok:${stop.stop_id}` },
          { text: "取消", callback_data: `m:stop:${stop.stop_id}` },
        ],
      ],
    },
  };
}

export function buildWindowsMenu(windows) {
  const lines = ["🕐 提醒时间段", ""];

  windows.forEach((window) => {
    lines.push(`${windowPeriodLabel(window)}：${window.start} – ${window.end}`);
  });

  lines.push("");
  lines.push("这是机器人开始和停止盯车的范围，");
  lines.push("不是提醒时刻。只在工作日生效。");

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...windows.map((window, index) => [
          {
            text: `${windowPeriodLabel(window)} ${window.start}-${window.end}`,
            callback_data: `m:winpick:${index}`,
          },
        ]),
        [BACK_BUTTON],
      ],
    },
  };
}

export function buildWindowEditMenu(windowIndex, window) {
  return {
    text: [
      `🕐 ${windowPeriodLabel(window)}：${window.start} – ${window.end}`,
      "",
      "要改哪一头？",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: `🟢 开始 ${window.start}`, callback_data: `m:wintime:${windowIndex}:start` },
          { text: `🔴 结束 ${window.end}`, callback_data: `m:wintime:${windowIndex}:end` },
        ],
        [{ text: "🔙 返回", callback_data: "m:win" }],
      ],
    },
  };
}

export function buildWindowTimeMenu(windowIndex, window, field) {
  const current = field === "start" ? window.start : window.end;
  const choices = generateTimeChoices(current);
  const rows = [];

  for (let index = 0; index < choices.length; index += 3) {
    rows.push(
      choices.slice(index, index + 3).map((time) => ({
        text: time === current ? `✅ ${time}` : time,
        callback_data: `m:winset:${windowIndex}:${field}:${time}`,
      })),
    );
  }
  rows.push([{ text: "🔙 返回", callback_data: `m:winpick:${windowIndex}` }]);

  return {
    text: [
      `🕐 ${windowPeriodLabel(window)}｜${field === "start" ? "开始" : "结束"}时间`,
      "",
      `当前：${current}`,
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

// Keeps a window usable no matter which end the user moved.
export function applyWindowTime(window, field, time) {
  const next = { ...window, [field]: time };
  const start = hhmmToMinute(next.start);
  const end = hhmmToMinute(next.end);

  if (end - start >= MIN_WINDOW_MINUTES) {
    return next;
  }

  if (field === "start") {
    return { ...next, end: minuteToHhmm(start + 60) };
  }
  return { ...next, start: minuteToHhmm(Math.max(0, end - 60)) };
}

export function buildWeekdaysMenu(activeWeekdays) {
  const active = normalizeActiveWeekdays(activeWeekdays);
  const rows = [];

  for (let index = 0; index < WEEKDAY_ORDER.length; index += 4) {
    rows.push(
      WEEKDAY_ORDER.slice(index, index + 4).map((day) => ({
        text: `${active.includes(day) ? "✅" : "⬜"} ${WEEKDAY_LABELS[day]}`,
        callback_data: `m:daytoggle:${day}`,
      })),
    );
  }
  rows.push([BACK_BUTTON]);

  return {
    text: [
      "📅 生效星期",
      "",
      `当前：${describeActiveWeekdays(active)}`,
      "",
      "点一下切换。公共假期始终跳过。",
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function buildDisplayMenu(displayMode = "auto") {
  const options = [
    ["auto", "🔄 自动", "线路多的站自动用紧凑列表"],
    ["compact", "📋 总是紧凑", "只列最近几班，按时间排序"],
    ["detailed", "📖 总是详细", "每条线路分别列出三班"],
  ];

  return {
    text: [
      "🖥 显示方式",
      "",
      ...options.map(([key, label, hint]) => `${key === displayMode ? "✅" : "▫️"} ${label}：${hint}`),
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...options.map(([key, label]) => [
          { text: `${key === displayMode ? "✅ " : ""}${label}`, callback_data: `m:displayset:${key}` },
        ]),
        [BACK_BUTTON],
      ],
    },
  };
}

export function buildStatsMenu(stats, windows) {
  const lines = ["📊 我的统计", ""];

  if (!stats || stats.length === 0) {
    lines.push("还没有记录。");
    lines.push("每次点「🛑 我上车了」我都会记一笔，");
    lines.push("积累一两周后这里会告诉你实际的出行规律，");
    lines.push("并建议更贴合的提醒时间段。");
  } else {
    for (const row of stats) {
      const window = windows.find((item) => item.start === row.windowStart);
      const label = window ? windowPeriodLabel(window) : row.windowStart;
      lines.push(`${label}（${row.windowStart} 起）`);
      lines.push(`   平均上车：${minuteToHhmm(Math.round(row.averageMinute))}`);
      lines.push(`   最早 ${row.earliest?.slice(0, 5)}｜最晚 ${row.latest?.slice(0, 5)}`);
      lines.push(`   共 ${row.count} 次`);

      if (window && row.count >= 5) {
        const suggestion = suggestWindowFromStats(row, window);
        if (suggestion) {
          lines.push(`   💡 建议改成 ${suggestion.start} – ${suggestion.end}`);
        }
      }
      lines.push("");
    }
  }

  return {
    text: lines.join("\n").trimEnd(),
    replyMarkup: { inline_keyboard: [[BACK_BUTTON]] },
  };
}

// Suggest a window that starts a little before the earliest boarding and ends a
// little after the latest, rounded to the half hour the pickers use.
export function suggestWindowFromStats(row, window) {
  if (!row?.earliest || !row?.latest) {
    return null;
  }

  const floorToStep = (minute) => Math.floor(minute / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
  const ceilToStep = (minute) => Math.ceil(minute / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
  const start = floorToStep(hhmmToMinute(row.earliest.slice(0, 5)) - 15);
  const end = ceilToStep(hhmmToMinute(row.latest.slice(0, 5)) + 15);

  const suggestion = { start: minuteToHhmm(Math.max(0, start)), end: minuteToHhmm(end) };
  if (suggestion.start === window.start && suggestion.end === window.end) {
    return null;
  }
  return suggestion;
}

export function buildAddStopMenu() {
  return {
    text: [
      "➕ 添加站点",
      "",
      "把车站的位置发给我就行：",
      "",
      "1️⃣ 点输入框旁的 📎 → 位置（Location），",
      "   把图钉拖到车站附近发送",
      "",
      "2️⃣ 或粘贴一条 Google 地图链接",
      "",
      "3️⃣ 或直接发坐标，例如 1.32049,103.76389",
      "",
      "我会列出附近的车站给你挑。",
    ].join("\n"),
    replyMarkup: { inline_keyboard: [[BACK_BUTTON]] },
  };
}

export function buildRenamePrompt(stop) {
  return `✏️ 请直接回复这条消息，输入 ${stop.stop_id} 的新名字`;
}

export function parseRenamePrompt(text) {
  const match = /输入 (\d{5}) 的新名字/.exec(String(text || ""));
  return match ? match[1] : null;
}

export function parseMenuCallback(data) {
  const raw = String(data || "");
  if (!raw.startsWith("m:")) {
    return null;
  }
  const [, action, ...rest] = raw.split(":");
  return { action, args: rest };
}
