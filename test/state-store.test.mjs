import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { logAlertToHistory, readState, writeState } from "../lib/state-store.mjs";

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("readState migrates legacy JSON state into sqlite on first load", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");

  try {
    await fs.writeFile(
      stateFile,
      `${JSON.stringify({
        alerts: {
          "17379:189": {
            lastArrivalTime: "2026-04-18T08:42:10+08:00",
            lastSentAt: "2026-04-18T08:37:00.000Z",
          },
        },
        telegramUpdateOffset: 123,
        mutedUntilDateKey: "2026-04-18",
        monitoredStops: [{ stop_id: "17379", stop_name: "金文泰大牌304", services: ["189"] }],
        serviceThresholdMinutes: { "189": 6 },
      }, null, 2)}\n`,
      "utf8",
    );

    const state = await readState(stateFile);

    assert.equal(state.telegramUpdateOffset, 123);
    assert.equal(state.mutedUntilDateKey, "2026-04-18");
    assert.deepEqual(state.serviceThresholdMinutes, { "189": 6 });
    assert.ok(await exists(dbFile));
    assert.equal(await exists(stateFile), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("readState migrates legacy JSON even when an empty sqlite file already exists", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");

  try {
    await fs.writeFile(dbFile, "", "utf8");
    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ telegramUpdateOffset: 789, alerts: { "17051:963": { lastArrivalTime: "2026-04-18T18:01:00+08:00", lastSentAt: "2026-04-18T17:54:00.000Z" } } }, null, 2)}\n`,
      "utf8",
    );

    const state = await readState(stateFile);

    assert.equal(state.telegramUpdateOffset, 789);
    assert.equal(state.alerts["17051:963"].lastArrivalTime, "2026-04-18T18:01:00+08:00");
    assert.equal(await exists(stateFile), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("writeState persists only to sqlite without creating a json state file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");

  try {
    await writeState(stateFile, {
      alerts: {
        "17051:963": {
          lastArrivalTime: "2026-04-18T18:01:00+08:00",
          lastSentAt: "2026-04-18T17:54:00.000Z",
        },
      },
      telegramUpdateOffset: 456,
      mutedUntilDateKey: "2026-04-18",
      monitoredStops: [{ stop_id: "17051", stop_name: "丽晶园对面", services: ["963"] }],
      serviceThresholdMinutes: { "963": 5 },
    });

    assert.equal(await exists(stateFile), false);

    const reloaded = await readState(stateFile);
    assert.equal(reloaded.telegramUpdateOffset, 456);
    assert.equal(reloaded.mutedUntilDateKey, "2026-04-18");
    assert.equal(reloaded.alerts["17051:963"].lastArrivalTime, "2026-04-18T18:01:00+08:00");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("logAlertToHistory writes into sqlite-backed history table", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");

  try {
    await writeState(stateFile, { alerts: {} });
    await logAlertToHistory(stateFile, "17379", "189", "2026-04-18T08:42:10+08:00");

    assert.equal(await exists(dbFile), true);
    const { stdout } = await execFileAsync("sqlite3", [dbFile, "SELECT COUNT(*) FROM alert_history WHERE stop_id = '17379' AND service_no = '189';"]);
    assert.equal(stdout.trim(), "1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("readState falls back to legacy JSON when sqlite is unreadable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await fs.writeFile(dbFile, "not-a-real-sqlite-db", "utf8");
    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ telegramUpdateOffset: 321, alerts: {} }, null, 2)}\n`,
      "utf8",
    );

    const state = await readState(stateFile);
    assert.equal(state.telegramUpdateOffset, 321);
  } finally {
    console.error = originalConsoleError;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("readState throws when sqlite is unreadable and no legacy JSON remains", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await fs.writeFile(dbFile, "not-a-real-sqlite-db", "utf8");
    await assert.rejects(() => readState(stateFile));
  } finally {
    console.error = originalConsoleError;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("writeState throws when sqlite storage is not writable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sg-bus-alert-state-"));
  const stateFile = path.join(tempDir, "state.json");
  const dbFile = path.join(tempDir, "state.db");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await fs.mkdir(dbFile);
    await assert.rejects(() => writeState(stateFile, { alerts: {} }));
  } finally {
    console.error = originalConsoleError;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
