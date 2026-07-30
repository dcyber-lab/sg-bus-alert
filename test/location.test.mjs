import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCoordinate,
  findNearestStops,
  findUrl,
  formatDistance,
  haversineMeters,
  isPlausibleSingaporeCoordinate,
  isResolvableShortLink,
  looksLikeLocationInput,
  parseStopsDataset,
} from "../lib/location.mjs";

const BLK_304 = { lat: 1.32049, lng: 103.76389 };

test("extractCoordinate prefers the place marker over the viewport centre", () => {
  const url =
    "https://www.google.com/maps/place/Blk+304/@1.3100,103.7500,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d1.32049!4d103.76389";

  assert.deepEqual(extractCoordinate(url), { lat: 1.32049, lng: 103.76389 });
});

test("extractCoordinate handles viewport, query and bare coordinate forms", () => {
  assert.deepEqual(extractCoordinate("https://www.google.com/maps/@1.32049,103.76389,15z"), BLK_304);
  assert.deepEqual(extractCoordinate("https://maps.google.com/?q=1.32049,103.76389"), BLK_304);
  assert.deepEqual(
    extractCoordinate("https://www.google.com/maps/search/?api=1&query=1.32049%2C103.76389"),
    BLK_304,
  );
  assert.deepEqual(extractCoordinate("1.32049,103.76389"), BLK_304);
  assert.deepEqual(extractCoordinate("1.32049，103.76389"), BLK_304);
});

test("extractCoordinate rejects text without usable coordinates", () => {
  assert.equal(extractCoordinate("https://maps.app.goo.gl/abcdef"), null);
  assert.equal(extractCoordinate("状态"), null);
  assert.equal(extractCoordinate(""), null);
  assert.equal(extractCoordinate("999.0,999.0"), null);
});

test("isPlausibleSingaporeCoordinate guards against far-away pins", () => {
  assert.equal(isPlausibleSingaporeCoordinate(BLK_304), true);
  assert.equal(isPlausibleSingaporeCoordinate({ lat: 51.5, lng: -0.12 }), false);
  assert.equal(isPlausibleSingaporeCoordinate(null), false);
});

test("isResolvableShortLink only trusts known Google hosts", () => {
  assert.equal(isResolvableShortLink("https://maps.app.goo.gl/abc123"), true);
  assert.equal(isResolvableShortLink("https://goo.gl/maps/abc123"), true);
  assert.equal(isResolvableShortLink("https://www.google.com/maps/place/x"), true);
  assert.equal(isResolvableShortLink("https://evil.example.com/maps"), false);
  assert.equal(isResolvableShortLink("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isResolvableShortLink("not a url"), false);
});

test("looksLikeLocationInput recognises map shares but not ordinary commands", () => {
  assert.equal(looksLikeLocationInput("https://maps.app.goo.gl/abc123"), true);
  assert.equal(looksLikeLocationInput("看看这个 https://www.google.com/maps/@1.3,103.7,15z"), true);
  assert.equal(looksLikeLocationInput("1.32049,103.76389"), true);
  assert.equal(looksLikeLocationInput("状态"), false);
  assert.equal(looksLikeLocationInput("189"), false);
  assert.equal(looksLikeLocationInput("https://example.com/page"), false);
});

test("findUrl picks the first link out of surrounding chatter", () => {
  assert.equal(
    findUrl("公司在这 https://maps.app.goo.gl/xyz 帮我加一下"),
    "https://maps.app.goo.gl/xyz",
  );
  assert.equal(findUrl("没有链接"), null);
});

test("haversineMeters matches the known distance between two Clementi stops", () => {
  const oppRegentPk = { lat: 1.31726, lng: 103.7624 };
  const meters = haversineMeters(BLK_304, oppRegentPk);

  assert.ok(meters > 350 && meters < 450, `expected ~400m, got ${Math.round(meters)}m`);
});

test("parseStopsDataset and findNearestStops rank real stops by distance", () => {
  const stops = parseStopsDataset({
    "17379": [103.76389, 1.32049, "Blk 304", "Clementi Ave 6"],
    "17051": [103.7624, 1.31726, "Opp Regent Pk", "Clementi Ave 6"],
    "10009": [103.81722, 1.2821, "Bt Merah Int", "Bt Merah Ctrl"],
    bad: ["x", "y", "Broken"],
  });

  assert.equal(stops.length, 3);

  const nearest = findNearestStops(stops, BLK_304, { limit: 5, maxMeters: 1000 });
  assert.deepEqual(
    nearest.map((stop) => stop.stop_id),
    ["17379", "17051"],
  );
  assert.equal(Math.round(nearest[0].distanceMeters), 0);
  assert.equal(nearest[0].road, "Clementi Ave 6");

  assert.equal(findNearestStops(stops, BLK_304, { maxMeters: 100 }).length, 1);
  assert.equal(findNearestStops(stops, { lat: 1.5, lng: 104.0 }, { maxMeters: 500 }).length, 0);
});

test("formatDistance switches to kilometres past 1000m", () => {
  assert.equal(formatDistance(0), "0 米");
  assert.equal(formatDistance(412.6), "413 米");
  assert.equal(formatDistance(1500), "1.5 公里");
});
