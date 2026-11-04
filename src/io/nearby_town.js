const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const nearbyTownCache = new Map();
const EARTH_RADIUS_MILES = 3958.7613;
let nominatimQueue = Promise.resolve();
let lastNominatimRequestAt = 0;

function fetchNominatim(url, fetchImpl) {
  const request = nominatimQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNominatimRequestAt = Date.now();
    return fetchImpl(url, { headers: { 'Accept-Language': 'en' } });
  });
  nominatimQueue = request.then(() => undefined, () => undefined);
  return request;
}

/**
 * Return the nearest mapped town-like place for a coordinate.
 * @param {{lat:number, lon:number}} location Geographic coordinates.
 * @param {typeof fetch} [fetchImpl] Fetch-compatible function.
 * @returns {Promise<{name:string, lat:number, lon:number}|null>} Town result, or null if none is mapped.
 */
export function findNearbyTown(location, fetchImpl = fetch) {
  const lat = Number(location?.lat);
  const lon = Number(location?.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    return Promise.reject(new RangeError('Nearby-town lookup requires valid latitude and longitude coordinates.'));
  }

  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (fetchImpl === globalThis.fetch && nearbyTownCache.has(key)) return nearbyTownCache.get(key);

  const url = new URL(NOMINATIM_REVERSE_URL);
  url.search = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lon),
    zoom: '10',
    addressdetails: '1',
  });
  const request = fetchImpl === globalThis.fetch
    ? fetchNominatim(url.href, fetchImpl)
    : fetchImpl(url.href, { headers: { 'Accept-Language': 'en' } });
  const lookup = request
    .then((response) => {
      if (!response.ok) throw new Error(`Nearby-town lookup failed (HTTP ${response.status}).`);
      return response.json();
    })
    .then((result) => {
      const address = result?.address;
      const name = address?.city || address?.town || address?.village
        || address?.municipality || address?.hamlet;
      const state = address?.state || address?.province || address?.region;
      const townLat = Number(result?.lat);
      const townLon = Number(result?.lon);
      if (!name || !Number.isFinite(townLat) || !Number.isFinite(townLon)) return null;
      return {
        name: String(name),
        state: state ? String(state) : '',
        lat: townLat,
        lon: townLon,
      };
    });

  if (fetchImpl === globalThis.fetch) {
    const cachedLookup = lookup.catch((error) => {
      nearbyTownCache.delete(key);
      throw error;
    });
    nearbyTownCache.set(key, cachedLookup);
    return cachedLookup;
  }
  return lookup;
}

/**
 * Calculate great-circle distance between two coordinates.
 * @param {{lat:number, lon:number}} from Starting coordinates.
 * @param {{lat:number, lon:number}} to Destination coordinates.
 * @returns {number} Distance in statute miles.
 */
export function distanceMiles(from, to) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const lat1 = toRadians(Number(from.lat));
  const lat2 = toRadians(Number(to.lat));
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(Number(to.lon) - Number(from.lon));
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

/**
 * Get the 8-point compass direction from one coordinate to another.
 * @param {{lat:number, lon:number}} from Starting coordinates.
 * @param {{lat:number, lon:number}} to Destination coordinates.
 * @returns {string|null} Compass direction, or null when the coordinates are identical.
 */
export function directionTo(from, to) {
  const lat1 = Number(from.lat) * Math.PI / 180;
  const lat2 = Number(to.lat) * Math.PI / 180;
  const deltaLon = (Number(to.lon) - Number(from.lon)) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  if (x === 0 && y === 0) return null;
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
}
