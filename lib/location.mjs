// Turning a shared place into a bus stop: parse coordinates out of Google Maps
// links (or raw text), then rank monitored-stop candidates by distance.

const SHORT_LINK_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "www.goo.gl",
  "g.co",
  "maps.google.com",
  "www.google.com",
  "google.com",
]);

// Generous bounding box around Singapore; anything outside is not a typo we can rescue.
const SG_BOUNDS = { minLat: 1.15, maxLat: 1.52, minLng: 103.55, maxLng: 104.15 };

export function isPlausibleSingaporeCoordinate(coordinate) {
  return Boolean(
    coordinate &&
      coordinate.lat >= SG_BOUNDS.minLat &&
      coordinate.lat <= SG_BOUNDS.maxLat &&
      coordinate.lng >= SG_BOUNDS.minLng &&
      coordinate.lng <= SG_BOUNDS.maxLng,
  );
}

function toCoordinate(latText, lngText) {
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

export function extractCoordinate(text) {
  const raw = String(text || "");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    decoded = raw;
  }

  // `!3d<lat>!4d<lng>` marks the actual place, so it beats the viewport centre.
  const placeMatch = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(decoded);
  if (placeMatch) {
    const coordinate = toCoordinate(placeMatch[1], placeMatch[2]);
    if (coordinate) {
      return coordinate;
    }
  }

  const queryMatch = /[?&](?:q|query|ll|daddr|destination|center|sll)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(
    decoded,
  );
  if (queryMatch) {
    const coordinate = toCoordinate(queryMatch[1], queryMatch[2]);
    if (coordinate) {
      return coordinate;
    }
  }

  const viewportMatch = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(decoded);
  if (viewportMatch) {
    const coordinate = toCoordinate(viewportMatch[1], viewportMatch[2]);
    if (coordinate) {
      return coordinate;
    }
  }

  const bareMatch = /^\s*(-?\d+\.\d+)\s*[,，]\s*(-?\d+\.\d+)\s*$/.exec(decoded);
  if (bareMatch) {
    const coordinate = toCoordinate(bareMatch[1], bareMatch[2]);
    if (coordinate) {
      return coordinate;
    }
  }

  return null;
}

export function findUrl(text) {
  const match = /https?:\/\/[^\s]+/i.exec(String(text || ""));
  return match ? match[0] : null;
}

export function isResolvableShortLink(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    return SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function looksLikeLocationInput(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  const url = findUrl(value);
  if (url) {
    return /google\.[a-z.]+\/maps|maps\.google|goo\.gl|maps\.app\.goo\.gl|g\.co/i.test(url);
  }
  return /^-?\d+\.\d+\s*[,，]\s*-?\d+\.\d+$/.test(value);
}

export function haversineMeters(a, b) {
  const earthRadius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parseStopsDataset(json) {
  const stops = [];
  for (const [stopId, value] of Object.entries(json || {})) {
    if (!Array.isArray(value) || value.length < 2) {
      continue;
    }
    const [lng, lat, name, road] = value;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    stops.push({
      stop_id: stopId,
      lat,
      lng,
      name: String(name || stopId),
      road: String(road || ""),
    });
  }
  return stops;
}

export function findNearestStops(stops, coordinate, { limit = 5, maxMeters = 1000 } = {}) {
  return (stops || [])
    .map((stop) => ({ ...stop, distanceMeters: haversineMeters(coordinate, stop) }))
    .filter((stop) => stop.distanceMeters <= maxMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

export function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} 米` : `${(meters / 1000).toFixed(1)} 公里`;
}
