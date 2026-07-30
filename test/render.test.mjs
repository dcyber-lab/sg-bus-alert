import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactStopSection,
  buildDetailedStopSection,
  buildLeadLine,
  buildServiceHints,
  buildStopSections,
  collectSoonestArrivals,
  findServicesWithoutData,
  groupItemsByStop,
  isRainyForecast,
  minutesLabel,
  shouldUseCompactLayout,
} from "../lib/render.mjs";

const TZ = "Asia/Singapore";

function arrival(minutes, load = "SEA") {
  return {
    duration_ms: minutes * 60000,
    time: new Date(Date.UTC(2026, 6, 31, 10, 30 + minutes)).toISOString(),
    load,
    type: "SD",
  };
}

const OFFICE = {
  stop: { stop_id: "18101", stop_name: "5 Sci Pk Dr" },
  services: [
    { serviceNo: "166", arrivals: [arrival(17), arrival(32)] },
    { serviceNo: "197", arrivals: [arrival(11, "SDA"), arrival(22)] },
    { serviceNo: "963", arrivals: [arrival(8), arrival(13)] },
    { serviceNo: "97", arrivals: [arrival(5), arrival(13, "LSD")] },
  ],
};

test("groupItemsByStop folds per-service rows back into one entry per stop", () => {
  const groups = groupItemsByStop([
    { stop: { stop_id: "1", stop_name: "A" }, serviceNo: "189", arrivals: [arrival(3)] },
    { stop: { stop_id: "2", stop_name: "B" }, serviceNo: "963", arrivals: [arrival(4)] },
    { stop: { stop_id: "1", stop_name: "A" }, serviceNo: "52", arrivals: [arrival(9)] },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].services.map((service) => service.serviceNo),
    ["189", "52"],
  );
  assert.equal(groups[1].stop.stop_id, "2");
});

test("compact layout kicks in only once a stop carries several routes", () => {
  assert.equal(shouldUseCompactLayout(OFFICE), true);
  assert.equal(shouldUseCompactLayout({ services: [{}, {}] }), false);
  assert.equal(shouldUseCompactLayout({ services: [{}, {}] }, "compact"), true);
  assert.equal(shouldUseCompactLayout(OFFICE, "detailed"), false);
});

test("collectSoonestArrivals merges routes into one time-sorted list", () => {
  const soonest = collectSoonestArrivals(OFFICE.services, 4);

  assert.deepEqual(
    soonest.map((row) => [row.serviceNo, Math.round(row.arrival.duration_ms / 60000)]),
    [
      ["97", 5],
      ["963", 8],
      ["197", 11],
      ["963", 13],
    ],
  );
});

test("compact section stays short and leads with the soonest bus", () => {
  const text = buildCompactStopSection(OFFICE, TZ);
  const lines = text.split("\n");

  assert.equal(lines[0], "📍 5 Sci Pk Dr");
  assert.equal(lines[1], "🚌 97 · 5 分钟 · 有座位");
  assert.equal(lines[2], "🚌 963 · 8 分钟 · 有座位");
  assert.equal(lines[3], "🚌 197 · 11 分钟 · 可站立");
  // One header plus at most COMPACT_ARRIVAL_LIMIT rows, versus 44 lines detailed.
  assert.ok(lines.length <= 7, `compact section grew to ${lines.length} lines`);
  assert.ok(buildDetailedStopSection(OFFICE, TZ).split("\n").length > 20);
});

test("compact section flags routes that returned no timings at all", () => {
  const group = {
    stop: { stop_id: "1", stop_name: "A" },
    services: [
      { serviceNo: "189", arrivals: [arrival(4)] },
      { serviceNo: "963", arrivals: [] },
      { serviceNo: "52", arrivals: [null] },
    ],
  };

  assert.deepEqual(findServicesWithoutData(group.services), ["963", "52"]);
  assert.match(buildCompactStopSection(group, TZ), /⚠️ 暂无班次：963 \/ 52/);
});

test("a stop with no timings at all says so instead of rendering nothing", () => {
  const group = {
    stop: { stop_id: "1", stop_name: "A" },
    services: [
      { serviceNo: "189", arrivals: [] },
      { serviceNo: "963", arrivals: [] },
      { serviceNo: "52", arrivals: [] },
    ],
  };

  assert.match(buildCompactStopSection(group, TZ), /暂无班次信息/);
});

test("detailed layout keeps the three-arrival block for single-route stops", () => {
  const group = {
    stop: { stop_id: "17379", stop_name: "金文泰大牌304" },
    services: [{ serviceNo: "189", arrivals: [arrival(3), arrival(14)] }],
  };
  const text = buildDetailedStopSection(group, TZ);

  assert.match(text, /🚌 189/);
  assert.match(text, /第 1 趟：3 分钟/);
  assert.match(text, /第 3 趟：暂无数据/);
});

test("buildStopSections mixes layouts per stop in one message", () => {
  const sections = buildStopSections(
    [
      { stop: { stop_id: "17379", stop_name: "家" }, serviceNo: "189", arrivals: [arrival(3)] },
      ...OFFICE.services.map((service) => ({
        stop: OFFICE.stop,
        serviceNo: service.serviceNo,
        arrivals: service.arrivals,
      })),
    ],
    TZ,
  );

  assert.equal(sections.length, 2);
  assert.match(sections[0], /第 1 趟：3 分钟/);
  assert.match(sections[1], /🚌 97 · 5 分钟/);
});

test("minutesLabel reads naturally at the boundaries", () => {
  assert.equal(minutesLabel(0), "即将到站");
  assert.equal(minutesLabel(20000), "1 分钟");
  assert.equal(minutesLabel(60000), "1 分钟");
  assert.equal(minutesLabel(5 * 60000), "5 分钟");
});

test("buildLeadLine puts the soonest ETAs where a notification banner shows them", () => {
  const items = [
    { serviceNo: "189", arrivals: [arrival(8)] },
    { serviceNo: "963", arrivals: [arrival(3)] },
    { serviceNo: "97", arrivals: [arrival(15)] },
    { serviceNo: "166", arrivals: [arrival(20)] },
  ];

  assert.equal(buildLeadLine(items, "08:37"), "🚌 963 3 分钟｜189 8 分钟｜97 15 分钟（08:37）");
  assert.equal(buildLeadLine(items, null, 1), "🚌 963 3 分钟");
});

test("buildLeadLine skips routes without timings and yields nothing when all are empty", () => {
  assert.equal(
    buildLeadLine([{ serviceNo: "189", arrivals: [] }, { serviceNo: "963", arrivals: [arrival(4)] }], "08:37"),
    "🚌 963 4 分钟（08:37）",
  );
  assert.equal(buildLeadLine([{ serviceNo: "189", arrivals: [null] }], "08:37"), null);
  assert.equal(buildLeadLine([], "08:37"), null);
});

test("buildServiceHints warns about a crowded first bus and a likely last bus", () => {
  assert.deepEqual(
    buildServiceHints([{ serviceNo: "189", arrivals: [arrival(4, "LSD"), arrival(12)] }]),
    ["😤 189 首班较拥挤，下一班 12 分钟"],
  );

  assert.deepEqual(buildServiceHints([{ serviceNo: "963", arrivals: [arrival(9)] }]), [
    "🌙 963 后面没有班次了，可能是末班车",
  ]);

  assert.deepEqual(buildServiceHints([{ serviceNo: "97", arrivals: [arrival(5), arrival(15)] }]), []);
  assert.deepEqual(buildServiceHints([{ serviceNo: "97", arrivals: [] }]), []);
});

test("isRainyForecast catches the wet nowcast wordings", () => {
  assert.equal(isRainyForecast("Thundery Showers"), true);
  assert.equal(isRainyForecast("Light Rain"), true);
  assert.equal(isRainyForecast("🌧 未来两小时（Clementi）：雷阵雨"), true);
  assert.equal(isRainyForecast("Partly Cloudy (Day)"), false);
  assert.equal(isRainyForecast("局部多云"), false);
  assert.equal(isRainyForecast(""), false);
});
