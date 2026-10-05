/**
 * Attach a location to a sounding (used for the map inset, the tornado climatology panel and
 * hemisphere-aware wind barbs). Returns the same sounding.
 * @param {object} sounding
 * @param {{ lat: number, lon: number }} location  degrees, longitude negative west
 */
export function withLocation(sounding, location) {
  const lat = Number(location && location.lat);
  let lon = Number(location && location.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sounding;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  sounding.Location = [lat, lon];
  sounding.Location2 = [lat, -lon];
  sounding.Coords = { lat, lon };
  return sounding;
}
