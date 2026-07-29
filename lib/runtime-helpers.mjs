import fs from "node:fs/promises";
import process from "node:process";

export const LOCK_STALE_MS = 2 * 60 * 1000;
export const MAX_INLINE_SERVICE_BUTTONS = 6;
export const MAX_HELP_SERVICE_COMMANDS = 8;

export function hhmmToMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) {
    throw new Error(`Invalid HH:MM time: ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseAlertWindows(env) {
  const windows = [];
  const pushWindow = (start, end) => {
    if (!start || !end) {
      return;
    }
    hhmmToMinute(start);
    hhmmToMinute(end);
    if (!windows.some((window) => window.start === start)) {
      windows.push({ start, end });
    }
  };

  for (const chunk of String(env.ALERT_WINDOWS || "").split(",")) {
    const [start, end] = chunk.trim().split("-");
    if (start && end) {
      pushWindow(start.trim(), end.trim());
    }
  }
  pushWindow(env.ALERT_WINDOW_START, env.ALERT_WINDOW_END);
  pushWindow(env.EVENING_WINDOW_START, env.EVENING_WINDOW_END);

  if (windows.length === 0) {
    windows.push({ start: "08:30", end: "09:30" });
  }

  return windows.sort((a, b) => hhmmToMinute(a.start) - hhmmToMinute(b.start));
}

export function windowKeyFor(dateKey, window) {
  return `${dateKey}|${window.start}`;
}

export function windowPeriodLabel(window) {
  return hhmmToMinute(window.start) < 12 * 60 ? "晨间" : "晚间";
}

export function pickBoardedWindow(currentMinute, windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return null;
  }

  return (
    windows.find(
      (window) =>
        currentMinute >= hhmmToMinute(window.start) && currentMinute <= hhmmToMinute(window.end),
    ) ||
    windows.find((window) => hhmmToMinute(window.start) > currentMinute) ||
    windows[windows.length - 1]
  );
}

export function getMonitoredServices(stops) {
  const seen = new Set();
  const services = [];

  for (const stop of stops || []) {
    for (const serviceNo of stop.services || []) {
      if (seen.has(serviceNo)) {
        continue;
      }
      seen.add(serviceNo);
      services.push(serviceNo);
    }
  }

  return services;
}

export function buildServiceCallbackData(serviceNo) {
  return `status_service:${serviceNo}`;
}

export function parseServiceCallbackData(value) {
  const match = /^status_service:(.+)$/.exec(String(value || ""));
  return match?.[1] || null;
}

export function buildTelegramButtons(stops, isMuted) {
  const services = getMonitoredServices(stops).slice(0, MAX_INLINE_SERVICE_BUTTONS);
  const inlineKeyboard = [[{ text: "🚏 查看状态", callback_data: "status_all" }]];

  for (let index = 0; index < services.length; index += 3) {
    inlineKeyboard.push(
      services.slice(index, index + 3).map((serviceNo) => ({
        text: `🚌 ${serviceNo}`,
        callback_data: buildServiceCallbackData(serviceNo),
      })),
    );
  }

  inlineKeyboard.push(
    isMuted
      ? [{ text: "🔔 恢复提醒", callback_data: "resume" }]
      : [
          { text: "🛑 我上车了", callback_data: "boarded" },
          { text: "🔕 暂停今天", callback_data: "mute" },
        ],
  );

  return {
    inline_keyboard: inlineKeyboard,
  };
}

export function buildAvailableCommandsHint(stops) {
  const services = getMonitoredServices(stops);
  const serviceCommands = services.slice(0, MAX_HELP_SERVICE_COMMANDS);
  const commands = ["状态", ...serviceCommands, "上车了", "暂停", "恢复", "配置"];

  if (services.length > serviceCommands.length) {
    commands.push("更多线路号");
  }

  return `可发送：${commands.join(" / ")}`;
}

export function buildHelpMessage(stops) {
  return [
    "可用命令：",
    "状态",
    "配置",
    buildAvailableCommandsHint(stops),
    "添加站点 <ID> <名称>",
    "删除站点 <ID>",
    "添加线路 <线路号> <站点ID/名称>",
    "删除线路 <线路号> <站点ID/名称>",
    "阈值 <线路号> <分钟>",
  ].join("\n");
}

export function buildLockContents(pid, createdAt = new Date().toISOString()) {
  const commandSource = process.argv[1] || process.argv[0] || "";
  const commandHint = commandSource.split(/[\\/]/).pop() || commandSource;
  return `${JSON.stringify({ pid, createdAt, commandHint })}\n`;
}

export function parseLockContents(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function shouldRecoverLock({ nowMs = Date.now(), staleMs = LOCK_STALE_MS, statMtimeMs, lockData }) {
  const createdAtMs = Date.parse(lockData?.createdAt || "");
  const baseTimeMs = Number.isFinite(createdAtMs) ? createdAtMs : statMtimeMs;

  if (!Number.isFinite(baseTimeMs)) {
    return true;
  }

  if (nowMs - baseTimeMs <= staleMs) {
    return false;
  }

  return true;
}

async function getProcessCommandLine(pid) {
  try {
    const text = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return text.replace(/\u0000/g, " ").trim();
  } catch {
    return "";
  }
}

async function isExpectedLockProcess(lockData) {
  if (!lockData?.pid || !isProcessRunning(lockData.pid)) {
    return false;
  }

  const expectedCommand = String(lockData.commandHint || "").trim();
  if (!expectedCommand) {
    return true;
  }

  const commandLine = await getProcessCommandLine(lockData.pid);
  return Boolean(commandLine) && commandLine.includes(expectedCommand);
}

async function inspectLock(lockPath, staleMs) {
  try {
    const [stat, text] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const lockData = parseLockContents(text);
    let stale = shouldRecoverLock({
      nowMs: Date.now(),
      staleMs,
      statMtimeMs: stat.mtimeMs,
      lockData,
    });

    if (stale && lockData?.pid && (await isExpectedLockProcess(lockData))) {
      stale = false;
    }

    return {
      exists: true,
      stale,
      lockData,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        stale: false,
        lockData: null,
      };
    }
    throw error;
  }
}

export async function acquireRunLock(lockPath, options = {}) {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(buildLockContents(process.pid));
      } finally {
        await handle.close();
      }

      return {
        acquired: true,
        recoveredStaleLock: attempt > 0,
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const inspected = await inspectLock(lockPath, staleMs);
      if (!inspected.exists) {
        continue;
      }

      if (!inspected.stale) {
        return {
          acquired: false,
          recoveredStaleLock: false,
          activeLock: inspected.lockData,
        };
      }

      try {
        await fs.unlink(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  return {
    acquired: false,
    recoveredStaleLock: true,
  };
}

export async function releaseRunLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
