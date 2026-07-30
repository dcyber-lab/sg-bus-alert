// Message rendering. A stop with several routes is unreadable as one block per
// route, so those collapse into a single time-sorted list of catchable buses.

export const COMPACT_SERVICE_THRESHOLD = 3;
export const COMPACT_ARRIVAL_LIMIT = 6;

const RAIN_PATTERN = /rain|shower|thunder|drizzle|雨/i;

export function loadLabel(code) {
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

export function vehicleTypeLabel(code) {
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

export function minutesLabel(durationMs) {
  const minutes = Math.max(0, Math.ceil(durationMs / 60000));
  if (minutes === 0) {
    return "即将到站";
  }
  if (minutes === 1) {
    return "1 分钟";
  }
  return `${minutes} 分钟`;
}

export function formatArrivalClock(isoString, timeZone) {
  if (!isoString) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

export function isRainyForecast(text) {
  return RAIN_PATTERN.test(String(text || ""));
}

export function groupItemsByStop(items) {
  const groups = [];
  const index = new Map();

  for (const item of items || []) {
    const stopId = item.stop.stop_id;
    if (!index.has(stopId)) {
      const group = { stop: item.stop, services: [] };
      index.set(stopId, group);
      groups.push(group);
    }
    index.get(stopId).services.push({ serviceNo: item.serviceNo, arrivals: item.arrivals || [] });
  }

  return groups;
}

export function shouldUseCompactLayout(group, displayMode = "auto") {
  if (displayMode === "compact") {
    return true;
  }
  if (displayMode === "detailed") {
    return false;
  }
  return group.services.length >= COMPACT_SERVICE_THRESHOLD;
}

export function collectSoonestArrivals(services, limit = COMPACT_ARRIVAL_LIMIT) {
  const rows = [];

  for (const service of services || []) {
    for (const arrival of service.arrivals || []) {
      if (!arrival || typeof arrival.duration_ms !== "number") {
        continue;
      }
      rows.push({ serviceNo: service.serviceNo, arrival });
    }
  }

  return rows.sort((a, b) => a.arrival.duration_ms - b.arrival.duration_ms).slice(0, limit);
}

export function findServicesWithoutData(services) {
  return (services || [])
    .filter(
      (service) =>
        !(service.arrivals || []).some((arrival) => arrival && typeof arrival.duration_ms === "number"),
    )
    .map((service) => service.serviceNo);
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

export function buildDetailedStopSection(group, timeZone) {
  const blocks = group.services.map((service) => {
    const hints = buildServiceHints([service]);
    return [
      `🚌 ${service.serviceNo}`,
      `📍 ${group.stop.stop_name}`,
      ``,
      buildArrivalSlot("第 1 趟", service.arrivals[0], timeZone),
      ``,
      buildArrivalSlot("第 2 趟", service.arrivals[1], timeZone),
      ``,
      buildArrivalSlot("第 3 趟", service.arrivals[2], timeZone),
      ...(hints.length > 0 ? ["", ...hints] : []),
    ].join("\n");
  });

  return blocks.join("\n\n────────\n\n");
}

export function buildCompactStopSection(group, timeZone, limit = COMPACT_ARRIVAL_LIMIT) {
  const lines = [`📍 ${group.stop.stop_name}`];
  const soonest = collectSoonestArrivals(group.services, limit);

  if (soonest.length === 0) {
    lines.push("暂无班次信息");
    return lines.join("\n");
  }

  for (const { serviceNo, arrival } of soonest) {
    lines.push(`🚌 ${serviceNo} · ${minutesLabel(arrival.duration_ms)} · ${loadLabel(arrival.load)}`);
  }

  const missing = findServicesWithoutData(group.services);
  if (missing.length > 0) {
    lines.push(`⚠️ 暂无班次：${missing.join(" / ")}`);
  }
  lines.push(...buildServiceHints(group.services));

  return lines.join("\n");
}

// The first line is all a phone notification banner and the chat list preview
// ever show, so it carries the ETAs rather than a title.
export function buildLeadLine(items, clock, limit = 3) {
  const rows = [];

  for (const item of items || []) {
    const first = (item.arrivals || []).find(
      (arrival) => arrival && typeof arrival.duration_ms === "number",
    );
    if (first) {
      rows.push({ serviceNo: item.serviceNo, durationMs: first.duration_ms });
    }
  }

  if (rows.length === 0) {
    return null;
  }

  const summary = rows
    .sort((a, b) => a.durationMs - b.durationMs)
    .slice(0, limit)
    .map((row) => `${row.serviceNo} ${minutesLabel(row.durationMs)}`)
    .join("｜");

  return `🚌 ${summary}${clock ? `（${clock}）` : ""}`;
}

export function buildServiceHints(services) {
  const hints = [];

  for (const service of services || []) {
    const arrivals = (service.arrivals || []).filter(
      (arrival) => arrival && typeof arrival.duration_ms === "number",
    );
    if (arrivals.length === 0) {
      continue;
    }
    if (arrivals[0].load === "LSD") {
      hints.push(
        arrivals.length > 1
          ? `😤 ${service.serviceNo} 首班较拥挤，下一班 ${minutesLabel(arrivals[1].duration_ms)}`
          : `😤 ${service.serviceNo} 首班较拥挤`,
      );
    }
    // No following trip in the feed usually means the service is winding down.
    if (arrivals.length === 1) {
      hints.push(`🌙 ${service.serviceNo} 后面没有班次了，可能是末班车`);
    }
  }

  return hints;
}

export function buildStopSection(group, timeZone, displayMode = "auto") {
  return shouldUseCompactLayout(group, displayMode)
    ? buildCompactStopSection(group, timeZone)
    : buildDetailedStopSection(group, timeZone);
}

export function buildStopSections(items, timeZone, displayMode = "auto") {
  return groupItemsByStop(items).map((group) => buildStopSection(group, timeZone, displayMode));
}
