import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  acquireRunLock,
  buildAvailableCommandsHint,
  buildLockContents,
  buildTelegramButtons,
  getMonitoredServices,
  parseAlertWindows,
  parseDateKeySet,
  pickBoardedWindow,
  pickDepartureCandidate,
  releaseRunLock,
  stopsForPeriod,
  windowKeyFor,
  windowPeriodKey,
  windowPeriodLabel,
} from "../lib/runtime-helpers.mjs";

test("buildTelegramButtons reflects current monitored services with a practical cap", () => {
  const stops = [
    { stop_id: "1", stop_name: "A", services: ["189", "963", "190"] },
    { stop_id: "2", stop_name: "B", services: ["960", "51", "52", "53"] },
  ];

  const replyMarkup = buildTelegramButtons(stops, false);

  assert.deepEqual(getMonitoredServices(stops), ["189", "963", "190", "960", "51", "52", "53"]);
  assert.deepEqual(replyMarkup.inline_keyboard[0], [
    { text: "🚏 查看状态", callback_data: "status_all" },
  ]);
  assert.deepEqual(replyMarkup.inline_keyboard[1], [
    { text: "🚌 189", callback_data: "status_service:189" },
    { text: "🚌 963", callback_data: "status_service:963" },
    { text: "🚌 190", callback_data: "status_service:190" },
  ]);
  assert.deepEqual(replyMarkup.inline_keyboard[2], [
    { text: "🚌 960", callback_data: "status_service:960" },
    { text: "🚌 51", callback_data: "status_service:51" },
    { text: "🚌 52", callback_data: "status_service:52" },
  ]);
  assert.deepEqual(replyMarkup.inline_keyboard.at(-1), [
    { text: "🛑 我上车了", callback_data: "boarded" },
    { text: "🔕 暂停今天", callback_data: "mute" },
  ]);
  assert.equal(
    buildAvailableCommandsHint(stops),
    "可发送：状态 / 189 / 963 / 190 / 960 / 51 / 52 / 53 / 上车了 / 暂停 / 恢复 / 配置",
  );
});

test("buildAvailableCommandsHint truncates oversized service lists", () => {
  const stops = [
    { stop_id: "1", stop_name: "A", services: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
  ];

  assert.equal(
    buildAvailableCommandsHint(stops),
    "可发送：状态 / 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 上车了 / 暂停 / 恢复 / 配置 / 更多线路号",
  );
});

test("acquireRunLock blocks active lock and recovers stale lock safely", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-lock-"));
  const lockPath = path.join(tempDir, ".sg-bus-alert.lock");

  try {
    let result = await acquireRunLock(lockPath, { staleMs: 50 });
    assert.equal(result.acquired, true);
    await releaseRunLock(lockPath);

    await fs.writeFile(
      lockPath,
      buildLockContents(process.pid, new Date(Date.now() - 60_000).toISOString()),
      "utf8",
    );
    result = await acquireRunLock(lockPath, { staleMs: 50 });
    assert.equal(result.acquired, false);
    assert.equal(result.activeLock.pid, process.pid);

    await fs.writeFile(
      lockPath,
      buildLockContents(99999999, new Date(Date.now() - 60_000).toISOString()),
      "utf8",
    );
    result = await acquireRunLock(lockPath, { staleMs: 50 });
    assert.equal(result.acquired, true);
    assert.equal(result.recoveredStaleLock, true);
    await releaseRunLock(lockPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildLockContents records a command hint for safer stale lock checks", () => {
  const payload = JSON.parse(buildLockContents(process.pid).trim());

  assert.equal(payload.pid, process.pid);
  assert.equal(typeof payload.commandHint, "string");
  assert.ok(payload.commandHint.length > 0);
});

test("parseAlertWindows merges ALERT_WINDOWS with legacy window keys and dedupes", () => {
  assert.deepEqual(
    parseAlertWindows({
      ALERT_WINDOWS: "08:30-09:30,17:30-18:30",
      ALERT_WINDOW_START: "08:30",
      ALERT_WINDOW_END: "09:30",
      EVENING_WINDOW_START: "17:30",
      EVENING_WINDOW_END: "18:30",
    }),
    [
      { start: "08:30", end: "09:30" },
      { start: "17:30", end: "18:30" },
    ],
  );

  assert.deepEqual(parseAlertWindows({}), [{ start: "08:30", end: "09:30" }]);

  assert.deepEqual(
    parseAlertWindows({
      EVENING_WINDOW_START: "17:30",
      EVENING_WINDOW_END: "18:30",
      ALERT_WINDOW_START: "08:30",
      ALERT_WINDOW_END: "09:30",
    }),
    [
      { start: "08:30", end: "09:30" },
      { start: "17:30", end: "18:30" },
    ],
  );
});

test("pickBoardedWindow prefers the active window, then the next upcoming one", () => {
  const windows = [
    { start: "08:30", end: "09:30" },
    { start: "17:30", end: "18:30" },
  ];

  assert.deepEqual(pickBoardedWindow(9 * 60, windows), { start: "08:30", end: "09:30" });
  assert.deepEqual(pickBoardedWindow(12 * 60, windows), { start: "17:30", end: "18:30" });
  assert.deepEqual(pickBoardedWindow(7 * 60, windows), { start: "08:30", end: "09:30" });
  assert.deepEqual(pickBoardedWindow(20 * 60, windows), { start: "17:30", end: "18:30" });
  assert.equal(pickBoardedWindow(9 * 60, []), null);
});

test("windowKeyFor and windowPeriodLabel derive stable identifiers", () => {
  assert.equal(windowKeyFor("2026-07-29", { start: "08:30", end: "09:30" }), "2026-07-29|08:30");
  assert.equal(windowPeriodLabel({ start: "08:30", end: "09:30" }), "晨间");
  assert.equal(windowPeriodLabel({ start: "17:30", end: "18:30" }), "晚间");
  assert.equal(windowPeriodKey({ start: "08:30", end: "09:30" }), "早");
  assert.equal(windowPeriodKey({ start: "17:30", end: "18:30" }), "晚");
});

test("stopsForPeriod filters stops by their configured periods", () => {
  const stops = [
    { stop_id: "1", stop_name: "家", services: ["189"] },
    { stop_id: "2", stop_name: "公司", services: ["963"], periods: ["晚"] },
    { stop_id: "3", stop_name: "两边", services: ["51"], periods: [] },
  ];

  assert.deepEqual(
    stopsForPeriod(stops, "早").map((stop) => stop.stop_id),
    ["1", "3"],
  );
  assert.deepEqual(
    stopsForPeriod(stops, "晚").map((stop) => stop.stop_id),
    ["1", "2", "3"],
  );
});

test("pickDepartureCandidate fires only inside the leave-now band", () => {
  const arrival = (minutes) => ({ duration_ms: minutes * 60000, time: "2026-07-30T08:40:00+08:00" });

  assert.equal(pickDepartureCandidate([arrival(10)], 6), null);
  assert.deepEqual(pickDepartureCandidate([arrival(7)], 6), arrival(7));
  assert.deepEqual(pickDepartureCandidate([arrival(8)], 6), arrival(8));
  assert.equal(pickDepartureCandidate([arrival(3), arrival(12)], 6), null);
  assert.deepEqual(pickDepartureCandidate([arrival(3), arrival(7)], 6), arrival(7));
  assert.equal(pickDepartureCandidate([null, arrival(20)], 6), null);
  assert.equal(pickDepartureCandidate([arrival(7)], 0), null);
  assert.equal(pickDepartureCandidate([], 6), null);
});

test("parseDateKeySet keeps only well-formed dates", () => {
  const keys = parseDateKeySet(" 2026-08-10 , 2026-12-25, not-a-date,2026-1-1 ");
  assert.deepEqual([...keys].sort(), ["2026-08-10", "2026-12-25"]);
  assert.equal(parseDateKeySet(undefined).size, 0);
});
