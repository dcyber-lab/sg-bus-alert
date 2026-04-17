import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    ].join("\n"),
  ]);
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
    if (key === "telegramUpdateOffset") {
      const parsedOffset = Number(value);
      if (Number.isFinite(parsedOffset)) {
        state.telegramUpdateOffset = parsedOffset;
      }
    } else if (key === "monitoredStops" || key === "serviceThresholdMinutes") {
      state[key] = JSON.parse(value);
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
