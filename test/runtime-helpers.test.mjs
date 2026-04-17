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
  releaseRunLock,
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
