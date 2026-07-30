import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const JSON_SETTINGS_KEYS = new Set([
  "monitoredStops",
  "serviceThresholdMinutes",
  "mutedWindowKeys",
  "windowNotices",
  "walkMinutesByStop",
  "departurePings",
  "alertWindowsOverride",
  "departureSnooze",
  "activeWeekdays",
]);

const NUMBER_SETTINGS_KEYS = new Set(["telegramUpdateOffset", "walkMinutesDefault", "failureStreak"]);

function getDbPath(filePath) {
  return filePath.endsWith(".json") ? filePath.replace(/\.json$/u, ".db") : `${filePath}.db`;
}

function sqlValue(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function normalizeState(state) {
  const normalized = typeof state === "object" && state ? { ...state } : {};
  if (!normalized.alerts || typeof normalized.alerts !== "object" || Array.isArray(normalized.alerts)) {
    normalized.alerts = {};
  }
  if (!Number.isFinite(normalized.telegramUpdateOffset)) {
    delete normalized.telegramUpdateOffset;
  }
  return normalized;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDb(dbPath) {
  await execFileAsync("sqlite3", [
    dbPath,
    [
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);",
      "CREATE TABLE IF NOT EXISTS current_alerts (key TEXT PRIMARY KEY, last_arrival_time TEXT, last_sent_at TEXT);",
      "CREATE TABLE IF NOT EXISTS alert_history (id INTEGER PRIMARY KEY AUTOINCREMENT, stop_id TEXT, service_no TEXT, arrival_time TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);",
      "CREATE TABLE IF NOT EXISTS boarding_log (id INTEGER PRIMARY KEY AUTOINCREMENT, window_key TEXT, local_time TEXT, pressed_at DATETIME DEFAULT CURRENT_TIMESTAMP);",
    ].join("\n"),
  ]);
}

export async function logBoarding(filePath, windowKey, localTime) {
  const dbPath = getDbPath(filePath);
  try {
    await ensureDb(dbPath);
    await execFileAsync("sqlite3", [
      dbPath,
      `INSERT INTO boarding_log (window_key, local_time) VALUES (${sqlValue(windowKey)}, ${sqlValue(localTime)});`,
    ]);
    return true;
  } catch (error) {
    console.error(`Boarding log failed: ${error.message}`);
    return false;
  }
}

// Average boarding clock time per window start, used to suggest better windows.
export async function readBoardingStats(filePath, days = 30) {
  const dbPath = getDbPath(filePath);
  try {
    await ensureDb(dbPath);
    const { stdout } = await execFileAsync("sqlite3", [
      dbPath,
      `SELECT substr(window_key, 12) AS window_start, COUNT(*), MIN(local_time), MAX(local_time), AVG((CAST(substr(local_time,1,2) AS INTEGER)*60) + CAST(substr(local_time,4,2) AS INTEGER))
       FROM boarding_log
       WHERE pressed_at > datetime('now', '-${Number(days)} days')
       GROUP BY window_start ORDER BY window_start;`,
    ]);

    const rows = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [windowStart, count, earliest, latest, averageMinute] = line.split("|");
      rows.push({
        windowStart,
        count: Number(count),
        earliest,
        latest,
        averageMinute: Number(averageMinute),
      });
    }
    return rows;
  } catch (error) {
    console.error(`Boarding stats failed: ${error.message}`);
    return [];
  }
}

async function retireLegacyJson(filePath) {
  const migratedPath = `${filePath}.migrated-to-sqlite`;
  try {
    await fs.rm(migratedPath, { force: true });
    await fs.rename(filePath, migratedPath);
  } catch {
    await fs.rm(filePath, { force: true });
  }
}

async function readStateFromDb(dbPath) {
  await ensureDb(dbPath);
  const state = { alerts: {} };

  const { stdout: settingsOut } = await execFileAsync("sqlite3", [dbPath, "SELECT key, value FROM settings;"]);
  for (const line of settingsOut.trim().split("\n")) {
    if (!line) continue;
    const index = line.indexOf("|");
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (NUMBER_SETTINGS_KEYS.has(key)) {
      const parsedNumber = Number(value);
      if (Number.isFinite(parsedNumber)) {
        state[key] = parsedNumber;
      }
    } else if (JSON_SETTINGS_KEYS.has(key)) {
      try {
        state[key] = JSON.parse(value);
      } catch (error) {
        console.error(`Ignoring corrupt setting ${key}: ${error.message}`);
      }
    } else {
      state[key] = value;
    }
  }

  const { stdout: alertsOut } = await execFileAsync("sqlite3", [dbPath, "SELECT key, last_arrival_time, last_sent_at FROM current_alerts;"]);
  for (const line of alertsOut.trim().split("\n")) {
    if (!line) continue;
    const [key, arrival, sent] = line.split("|");
    state.alerts[key] = { lastArrivalTime: arrival, lastSentAt: sent };
  }

  return normalizeState(state);
}

function hasMeaningfulState(state) {
  return (
    Object.keys(state.alerts || {}).length > 0 ||
    Number.isFinite(state.telegramUpdateOffset) ||
    typeof state.mutedUntilDateKey === "string" ||
    Array.isArray(state.monitoredStops) ||
    (state.serviceThresholdMinutes && typeof state.serviceThresholdMinutes === "object")
  );
}

async function persistStateToDb(dbPath, state) {
  const normalized = normalizeState(state);
  await ensureDb(dbPath);

  const commands = [];
  if (Number.isFinite(normalized.telegramUpdateOffset)) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('telegramUpdateOffset', ${sqlValue(normalized.telegramUpdateOffset)});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'telegramUpdateOffset';");
  }

  if (normalized.mutedUntilDateKey) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('mutedUntilDateKey', ${sqlValue(normalized.mutedUntilDateKey)});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'mutedUntilDateKey';");
  }

  if (Array.isArray(normalized.monitoredStops)) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('monitoredStops', ${sqlValue(JSON.stringify(normalized.monitoredStops))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'monitoredStops';");
  }

  if (normalized.serviceThresholdMinutes && typeof normalized.serviceThresholdMinutes === "object") {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('serviceThresholdMinutes', ${sqlValue(JSON.stringify(normalized.serviceThresholdMinutes))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'serviceThresholdMinutes';");
  }

  if (Array.isArray(normalized.mutedWindowKeys) && normalized.mutedWindowKeys.length > 0) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('mutedWindowKeys', ${sqlValue(JSON.stringify(normalized.mutedWindowKeys))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'mutedWindowKeys';");
  }

  if (
    normalized.windowNotices &&
    typeof normalized.windowNotices === "object" &&
    Object.keys(normalized.windowNotices).length > 0
  ) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('windowNotices', ${sqlValue(JSON.stringify(normalized.windowNotices))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'windowNotices';");
  }

  if (
    normalized.walkMinutesByStop &&
    typeof normalized.walkMinutesByStop === "object" &&
    Object.keys(normalized.walkMinutesByStop).length > 0
  ) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('walkMinutesByStop', ${sqlValue(JSON.stringify(normalized.walkMinutesByStop))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'walkMinutesByStop';");
  }

  if (
    normalized.departurePings &&
    typeof normalized.departurePings === "object" &&
    Object.keys(normalized.departurePings).length > 0
  ) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('departurePings', ${sqlValue(JSON.stringify(normalized.departurePings))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'departurePings';");
  }

  if (Array.isArray(normalized.alertWindowsOverride) && normalized.alertWindowsOverride.length > 0) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('alertWindowsOverride', ${sqlValue(JSON.stringify(normalized.alertWindowsOverride))});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'alertWindowsOverride';");
  }

  if (Number.isFinite(normalized.walkMinutesDefault) && normalized.walkMinutesDefault > 0) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('walkMinutesDefault', ${sqlValue(normalized.walkMinutesDefault)});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'walkMinutesDefault';");
  }

  for (const key of ["departureSnooze", "activeWeekdays"]) {
    const value = normalized[key];
    const hasValue = Array.isArray(value)
      ? value.length > 0
      : value && typeof value === "object" && Object.keys(value).length > 0;
    if (hasValue) {
      commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${key}', ${sqlValue(JSON.stringify(value))});`);
    } else {
      commands.push(`DELETE FROM settings WHERE key = '${key}';`);
    }
  }

  if (normalized.displayMode) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('displayMode', ${sqlValue(normalized.displayMode)});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'displayMode';");
  }

  if (Number.isFinite(normalized.failureStreak) && normalized.failureStreak > 0) {
    commands.push(`INSERT OR REPLACE INTO settings (key, value) VALUES ('failureStreak', ${sqlValue(normalized.failureStreak)});`);
  } else {
    commands.push("DELETE FROM settings WHERE key = 'failureStreak';");
  }

  commands.push("DELETE FROM current_alerts;");
  for (const [key, value] of Object.entries(normalized.alerts || {})) {
    commands.push(`INSERT INTO current_alerts (key, last_arrival_time, last_sent_at) VALUES (${sqlValue(key)}, ${sqlValue(value.lastArrivalTime)}, ${sqlValue(value.lastSentAt)});`);
  }

  await execFileAsync("sqlite3", [dbPath, commands.join("\n")]);
}

async function migrateLegacyJsonState(filePath, dbPath) {
  const text = await fs.readFile(filePath, "utf8");
  const parsed = normalizeState(JSON.parse(text));
  await fs.rm(dbPath, { force: true });
  await persistStateToDb(dbPath, parsed);
  await retireLegacyJson(filePath);
  return parsed;
}

export async function writeState(filePath, state) {
  const dbPath = getDbPath(filePath);
  await persistStateToDb(dbPath, state);
  return true;
}

export async function readState(filePath) {
  const dbPath = getDbPath(filePath);
  const dbExists = await fileExists(dbPath);
  const jsonExists = await fileExists(filePath);

  if (jsonExists && !dbExists) {
    try {
      return await migrateLegacyJsonState(filePath, dbPath);
    } catch (error) {
      console.error(`State migration to SQLite failed: ${error.message}`);
      const text = await fs.readFile(filePath, "utf8");
      return normalizeState(JSON.parse(text));
    }
  }

  if (dbExists) {
    try {
      const dbState = await readStateFromDb(dbPath);
      if (jsonExists && !hasMeaningfulState(dbState)) {
        return await migrateLegacyJsonState(filePath, dbPath);
      }
      return dbState;
    } catch (error) {
      console.error(`SQLite read failed: ${error.message}`);
      if (jsonExists) {
        try {
          return await migrateLegacyJsonState(filePath, dbPath);
        } catch (migrationError) {
          console.error(`Fallback migration failed: ${migrationError.message}`);
          const text = await fs.readFile(filePath, "utf8");
          return normalizeState(JSON.parse(text));
        }
      }
      throw error;
    }
  }

  return normalizeState({ alerts: {} });
}

export async function logAlertToHistory(filePath, stopId, serviceNo, arrivalTime) {
  const dbPath = getDbPath(filePath);
  try {
    await ensureDb(dbPath);
    await execFileAsync("sqlite3", [dbPath, `INSERT INTO alert_history (stop_id, service_no, arrival_time) VALUES (${sqlValue(stopId)}, ${sqlValue(serviceNo)}, ${sqlValue(arrivalTime)});`]);
    return true;
  } catch (error) {
    console.error(`Alert history log failed: ${error.message}`);
    return false;
  }
}
