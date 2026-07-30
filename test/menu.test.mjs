import assert from "node:assert/strict";
import test from "node:test";

import {
  addDaysToDateKey,
  applyWindowTime,
  buildDeleteConfirmMenu,
  buildVacationMenu,
  buildMainMenu,
  buildPeriodMenu,
  buildRenamePrompt,
  buildRoutesMenu,
  buildStopMenu,
  buildThresholdServiceMenu,
  buildThresholdValueMenu,
  buildDisplayMenu,
  buildStatsMenu,
  buildWalkMenu,
  buildWeekdaysMenu,
  buildWindowEditMenu,
  buildWindowsMenu,
  buildWindowTimeMenu,
  describeStopPeriod,
  generateTimeChoices,
  getStopWalkMinutes,
  minuteToHhmm,
  parseMenuCallback,
  parseRenamePrompt,
  suggestWindowFromStats,
} from "../lib/menu.mjs";

const WINDOWS = [
  { start: "08:30", end: "09:30" },
  { start: "18:30", end: "19:30" },
];

const STOPS = [
  { stop_id: "17379", stop_name: "金文泰大牌304", services: ["189"] },
  { stop_id: "17051", stop_name: "丽晶园对面", services: ["963"], periods: ["晚"] },
];

function allButtons(replyMarkup) {
  return replyMarkup.inline_keyboard.flat();
}

function callbackDataOf(replyMarkup) {
  return allButtons(replyMarkup).map((button) => button.callback_data);
}

test("every menu keeps callback_data within Telegram's 64-byte limit", () => {
  const state = { serviceThresholdMinutes: { "189": 6 }, walkMinutesDefault: 5 };
  const menus = [
    buildMainMenu(STOPS, state, 8),
    buildStopMenu(STOPS[0], state, 8),
    buildRoutesMenu(STOPS[0], ["52", "61", "154", "189"]),
    buildThresholdServiceMenu(STOPS[0], state, 8),
    buildThresholdValueMenu(STOPS[0], "189", 6),
    buildPeriodMenu(STOPS[1]),
    buildWalkMenu(state),
    buildDeleteConfirmMenu(STOPS[0]),
    buildWindowsMenu(WINDOWS),
    buildWindowEditMenu(1, WINDOWS[1]),
    buildWindowTimeMenu(1, WINDOWS[1], "start"),
    buildWindowTimeMenu(1, WINDOWS[1], "end"),
    buildWeekdaysMenu(["Mon", "Wed"]),
    buildDisplayMenu("compact"),
    buildStatsMenu([], WINDOWS),
  ];

  for (const menu of menus) {
    assert.ok(menu.text.length > 0);
    for (const data of callbackDataOf(menu.replyMarkup)) {
      assert.ok(
        Buffer.byteLength(data, "utf8") <= 64,
        `callback_data too long: ${data} (${Buffer.byteLength(data, "utf8")} bytes)`,
      );
    }
  }
});

test("main menu lists one button per stop plus the global actions", () => {
  const menu = buildMainMenu(STOPS, { walkMinutesDefault: 5 }, 8);

  assert.match(menu.text, /金文泰大牌304 \(17379\)/);
  assert.match(menu.text, /提前 8 分钟提醒/);
  assert.match(menu.text, /只晚高峰/);
  const data = callbackDataOf(menu.replyMarkup);
  // Stop buttons are the part that must match exactly; global actions are
  // asserted by presence so adding a screen does not break this test.
  assert.deepEqual(
    data.filter((item) => item.startsWith("m:stop:")),
    ["m:stop:17379", "m:stop:17051"],
  );
  for (const required of ["m:add", "m:walk", "m:win", "m:close"]) {
    assert.ok(data.includes(required), `main menu lost ${required}`);
  }
  assert.equal(data.at(-1), "m:close", "close should stay the last button");
});

test("main menu guides the user when nothing is monitored yet", () => {
  const menu = buildMainMenu([], {}, 8);

  assert.match(menu.text, /还没有监控任何站点/);
  const data = callbackDataOf(menu.replyMarkup);
  assert.equal(
    data.filter((item) => item.startsWith("m:stop:")).length,
    0,
    "no stops means no stop buttons",
  );
  assert.ok(data.includes("m:add"));
});

test("routes menu offers removal for monitored and addition for the rest", () => {
  const menu = buildRoutesMenu(STOPS[0], ["52", "189", "61"]);

  assert.match(menu.text, /已监控：189/);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), [
    "m:svcdel:17379:189",
    "m:svcadd:17379:52",
    "m:svcadd:17379:61",
    "m:stop:17379",
  ]);
});

test("routes menu caps how many addable services become buttons", () => {
  const many = Array.from({ length: 30 }, (_, index) => `S${index}`);
  const menu = buildRoutesMenu({ stop_id: "1", stop_name: "X", services: [] }, many);
  const addButtons = callbackDataOf(menu.replyMarkup).filter((data) => data.startsWith("m:svcadd:"));

  assert.equal(addButtons.length, 12);
});

test("threshold menus mark the current value and route back correctly", () => {
  const state = { serviceThresholdMinutes: { "189": 6 } };
  const picker = buildThresholdServiceMenu(STOPS[0], state, 8);
  assert.deepEqual(callbackDataOf(picker.replyMarkup), [
    "m:thrpick:17379:189",
    "m:stop:17379",
  ]);

  const values = buildThresholdValueMenu(STOPS[0], "189", 6);
  const selected = allButtons(values.replyMarkup).filter((button) => button.text.startsWith("✅"));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].callback_data, "m:thrset:17379:189:6");
});

test("threshold picker tells the user to add a route first when there is none", () => {
  const menu = buildThresholdServiceMenu({ stop_id: "1", stop_name: "X", services: [] }, {}, 8);

  assert.match(menu.text, /还没有监控线路/);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), ["m:stop:1"]);
});

test("walk menu reflects the configured default and can switch off", () => {
  const off = buildWalkMenu({});
  assert.match(off.text, /未开启/);
  assert.ok(callbackDataOf(off.replyMarkup).includes("m:walkset:0"));

  const on = buildWalkMenu({ walkMinutesDefault: 5 });
  assert.match(on.text, /步行 5 分钟/);
  const selected = allButtons(on.replyMarkup).filter((button) => button.text.startsWith("✅"));
  assert.deepEqual(
    selected.map((button) => button.callback_data),
    ["m:walkset:5"],
  );
});

test("period helpers describe and offer the three choices", () => {
  assert.equal(describeStopPeriod(STOPS[0]), "全部时段");
  assert.equal(describeStopPeriod(STOPS[1]), "只晚高峰");

  const menu = buildPeriodMenu(STOPS[1]);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), [
    "m:periodset:17051:早",
    "m:periodset:17051:晚",
    "m:periodset:17051:全部",
    "m:stop:17051",
  ]);
});

test("delete confirmation names the collateral services", () => {
  const menu = buildDeleteConfirmMenu(STOPS[0]);

  assert.match(menu.text, /线路 189 也会一并移除/);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), ["m:delok:17379", "m:stop:17379"]);
});

test("getStopWalkMinutes prefers a per-stop override over the default", () => {
  const state = { walkMinutesDefault: 5, walkMinutesByStop: { "17379": 9 } };

  assert.deepEqual(getStopWalkMinutes(STOPS[0], state), { minutes: 9, source: "stop" });
  assert.deepEqual(getStopWalkMinutes(STOPS[1], state), { minutes: 5, source: "default" });
  assert.deepEqual(getStopWalkMinutes(STOPS[0], {}), { minutes: null, source: "none" });
});

test("rename prompt round-trips the stop id so the reply needs no stored state", () => {
  const prompt = buildRenamePrompt(STOPS[0]);

  assert.equal(parseRenamePrompt(prompt), "17379");
  assert.equal(parseRenamePrompt("随便一句话"), null);
});

test("windows menu labels each window by period and links to its editor", () => {
  const menu = buildWindowsMenu(WINDOWS);

  assert.match(menu.text, /晨间：08:30 – 09:30/);
  assert.match(menu.text, /晚间：18:30 – 19:30/);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), ["m:winpick:0", "m:winpick:1", "m:back"]);
});

test("window editor offers both ends and returns to the window list", () => {
  const menu = buildWindowEditMenu(1, WINDOWS[1]);

  assert.deepEqual(callbackDataOf(menu.replyMarkup), [
    "m:wintime:1:start",
    "m:wintime:1:end",
    "m:win",
  ]);
});

test("generateTimeChoices centres a half-hour grid on the current value", () => {
  assert.deepEqual(generateTimeChoices("18:30"), [
    "16:30",
    "17:00",
    "17:30",
    "18:00",
    "18:30",
    "19:00",
    "19:30",
    "20:00",
    "20:30",
  ]);
});

test("generateTimeChoices clamps at the ends of the day", () => {
  const early = generateTimeChoices("00:30");
  const late = generateTimeChoices("23:00");

  assert.equal(early[0], "00:00");
  assert.ok(early.every((time) => time >= "00:00"));
  assert.equal(late.at(-1), "23:30");
});

test("window time menu marks the current value and offers every choice", () => {
  const menu = buildWindowTimeMenu(1, WINDOWS[1], "start");
  const selected = allButtons(menu.replyMarkup).filter((button) => button.text.startsWith("✅"));

  assert.deepEqual(
    selected.map((button) => button.callback_data),
    ["m:winset:1:start:18:30"],
  );
  assert.ok(callbackDataOf(menu.replyMarkup).includes("m:winpick:1"));
});

test("applyWindowTime keeps the window at least half an hour long", () => {
  assert.deepEqual(applyWindowTime(WINDOWS[1], "start", "19:00"), {
    start: "19:00",
    end: "19:30",
  });

  // Dragging the start past the end pushes the end out instead of inverting.
  assert.deepEqual(applyWindowTime(WINDOWS[1], "start", "20:00"), {
    start: "20:00",
    end: "21:00",
  });

  // Same in reverse when the end is moved before the start.
  assert.deepEqual(applyWindowTime(WINDOWS[1], "end", "18:00"), {
    start: "17:00",
    end: "18:00",
  });

  assert.deepEqual(applyWindowTime(WINDOWS[1], "end", "20:30"), {
    start: "18:30",
    end: "20:30",
  });
});

test("minuteToHhmm formats and clamps into a valid clock time", () => {
  assert.equal(minuteToHhmm(0), "00:00");
  assert.equal(minuteToHhmm(8 * 60 + 30), "08:30");
  assert.equal(minuteToHhmm(-30), "00:00");
  assert.equal(minuteToHhmm(24 * 60), "23:30");
});

test("addDaysToDateKey counts the current day as the first day off", () => {
  assert.equal(addDaysToDateKey("2026-07-30", 1), "2026-07-30");
  assert.equal(addDaysToDateKey("2026-07-30", 3), "2026-08-01");
  assert.equal(addDaysToDateKey("2026-12-30", 7), "2027-01-05");
});

test("vacation menu shows the end date and only offers to cancel while active", () => {
  const active = buildVacationMenu("2026-08-05", "2026-07-30");
  assert.match(active.text, /休假到 2026-08-05/);
  assert.ok(callbackDataOf(active.replyMarkup).includes("m:vacset:0"));

  const idle = buildVacationMenu(undefined, "2026-07-30");
  assert.match(idle.text, /未在休假/);
  assert.equal(callbackDataOf(idle.replyMarkup).includes("m:vacset:0"), false);

  // A finished vacation should read as idle, not as still running.
  const expired = buildVacationMenu("2026-07-01", "2026-07-30");
  assert.match(expired.text, /未在休假/);
});

test("weekday menu marks the selected days and toggles each one", () => {
  const menu = buildWeekdaysMenu(["Mon", "Wed"]);

  assert.match(menu.text, /当前：周一、三/);
  assert.deepEqual(
    allButtons(menu.replyMarkup)
      .filter((button) => button.text.startsWith("✅"))
      .map((button) => button.callback_data),
    ["m:daytoggle:Mon", "m:daytoggle:Wed"],
  );
});

test("display menu marks the active mode", () => {
  const menu = buildDisplayMenu("compact");
  const selected = allButtons(menu.replyMarkup).filter((button) => button.text.startsWith("✅"));

  assert.deepEqual(
    selected.map((button) => button.callback_data),
    ["m:displayset:compact"],
  );
});

test("stats menu explains itself before any boarding is recorded", () => {
  const menu = buildStatsMenu([], WINDOWS);

  assert.match(menu.text, /还没有记录/);
  assert.deepEqual(callbackDataOf(menu.replyMarkup), ["m:back"]);
});

test("stats menu reports per-window boarding habits", () => {
  const menu = buildStatsMenu(
    [{ windowStart: "18:30", count: 12, earliest: "18:40:00", latest: "19:05:00", averageMinute: 1132 }],
    WINDOWS,
  );

  assert.match(menu.text, /晚间（18:30 起）/);
  assert.match(menu.text, /平均上车：18:52/);
  assert.match(menu.text, /共 12 次/);
});

test("suggestWindowFromStats pads around observed boardings and stays quiet when already right", () => {
  const window = { start: "18:30", end: "19:30" };

  assert.deepEqual(
    suggestWindowFromStats(
      { earliest: "18:40:00", latest: "19:05:00", count: 12 },
      window,
    ),
    { start: "18:00", end: "19:30" },
  );

  // Boarding close to the closing edge argues for a later end.
  assert.deepEqual(
    suggestWindowFromStats({ earliest: "18:45:00", latest: "19:20:00", count: 9 }, window),
    { start: "18:30", end: "20:00" },
  );

  // Nothing to say when the padded range is the window we already have.
  assert.equal(
    suggestWindowFromStats({ earliest: "18:45:00", latest: "19:00:00", count: 9 }, window),
    null,
  );

  assert.equal(suggestWindowFromStats({}, window), null);
});

test("parseMenuCallback splits action and arguments, ignoring other callbacks", () => {
  assert.deepEqual(parseMenuCallback("m:stop:17379"), { action: "stop", args: ["17379"] });
  assert.deepEqual(parseMenuCallback("m:thrset:17379:189:6"), {
    action: "thrset",
    args: ["17379", "189", "6"],
  });
  assert.deepEqual(parseMenuCallback("m:main"), { action: "main", args: [] });
  assert.equal(parseMenuCallback("status_all"), null);
});
