/**
 * Optional loaders for public data (all endpoints send CORS headers, so they work from a static site).
 *
 * The SharpJS core never imports this module. Apps that already have their own data
 * pipeline pass soundings straight to SharpJS(el, { sounding }) instead.
 *
 *   - Iowa Environmental Mesonet RAOB archive   https://mesonet.agron.iastate.edu/json/raob.py
 *   - Iowa Environmental Mesonet BUFKIT archive https://mtarchive.geol.iastate.edu/
 *   - Unidata NEXRAD Level III on AWS           https://unidata-nexrad-level3.s3.amazonaws.com
 *
 * Please be kind to these free services: fetch on user action, not on a timer.
 */
import { parseIemRaob } from '../io/iem.js';
import { parseBufkit, listBufkitForecastHours } from '../io/bufkit.js';
import { buildVwpSounding } from '../io/vwp.js';
import { withLocation } from '../io/location.js';
import { pad } from '../io/general.js';

const IEM_RAOB = 'https://mesonet.agron.iastate.edu/json/raob.py';
const IEM_BUFKIT = 'https://mtarchive.geol.iastate.edu';
const NEXRAD_L3 = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const IEM_RAOB_STATIONS = 'https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson';

/**
 * Normalize a supported date input and reject invalid timestamps.
 * @param {Date|string|number} time Date, parseable date string, or numeric timestamp (in milliseconds).
 * @returns {Date} Valid date object representing the same instant.
 */
function toDate(time) {
  const d = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(d.getTime())) throw new Error(`SharpJS: invalid time ${time}`);
  return d;
}

/**
 * Fetch a URL and reject non-success HTTP responses.
 * @param {string} url Resource URL.
 * @param {Function} fetchImpl Fetch-compatible function.
 * @returns {Promise<Response>} Successful HTTP response.
 */
async function getOk(url, fetchImpl) {
  const res = await (fetchImpl || fetch)(url);
  if (!res.ok) {
    const err = new Error(res.status === 404 ? 'Not found' : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

let raobStations = null;

/** Location of an upper-air station from the IEM station table (cached), or null. */
export async function raobStationLocation(station, fetchImpl) {
  const id = String(station || '').trim().toUpperCase();
  try {
    raobStations ??= getOk(IEM_RAOB_STATIONS, fetchImpl)
      .then((res) => res.json())
      .then((geo) => new Map(geo.features.map((f) => [String(f.id).toUpperCase(), f.geometry.coordinates])));
    const table = await raobStations;
    const c = table.get(id) || table.get(`K${id}`) || table.get(id.replace(/^K/, ''));
    return c ? { lat: c[1], lon: c[0] } : null;
  } catch {
    raobStations = null;
    return null;
  }
}

/**
 * Observed upper-air sounding from the IEM archive.
 * @param {object} q
 * @param {string} q.station   e.g. "OAX" or "KOAX"
 * @param {Date|string|number} q.time  launch time (UTC); IEM returns the matching launch
 * @param {{lat:number, lon:number}|false} [q.location]  station location (default: looked up from IEM)
 * @param {Function} [q.fetch] custom fetch implementation
 */
export async function fetchIemRaob({ station, time, location, fetch: fetchImpl }) {
  const id = String(station || '').trim().toUpperCase();
  if (!id) throw new Error('SharpJS: station is required');
  const d = toDate(time);
  const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00Z`;
  const [res, loc] = await Promise.all([
    getOk(`${IEM_RAOB}?station=${encodeURIComponent(id)}&ts=${ts}`, fetchImpl),
    location === undefined ? raobStationLocation(id, fetchImpl) : Promise.resolve(location || null),
  ]);
  const sounding = parseIemRaob(await res.json());
  if (loc) withLocation(sounding, loc);
  return sounding;
}

/** IEM archive directory and file names per model (NAM 06/18Z runs live under "namm"). */
function bufkitPath(model, station, run) {
  const m = model.toLowerCase();
  const hr = run.getUTCHours();
  let file = m;
  if (m === 'nam' && (hr === 6 || hr === 18)) file = 'namm';
  else if (m === 'gfs') file = 'gfs3';
  return `${run.getUTCFullYear()}/${pad(run.getUTCMonth() + 1)}/${pad(run.getUTCDate())}/bufkit/${pad(hr)}/${m}/${file}_${station.toLowerCase()}.buf`;
}

/** Models the IEM BUFKIT archive carries. */
export const BUFKIT_MODELS = ['hrrr', 'rap', 'ruc', 'nam', 'nam4km', 'gfs'];

/**
 * Archived model forecast sounding (BUFKIT) from the IEM archive.
 * @param {object} q
 * @param {string} q.model         one of BUFKIT_MODELS
 * @param {string} q.station       BUFKIT site, e.g. "kdsm" (RAP/RUC) or "dvn" (HRRR/NAM)
 * @param {Date|string|number} q.run  model run time (UTC)
 * @param {number} [q.forecastHour=0]
 * @param {Function} [q.fetch]
 */
export async function fetchIemBufkit({ model = 'hrrr', station, run, forecastHour = 0, fetch: fetchImpl }) {
  const { id, text } = await fetchIemBufkitText({ model, station, run, fetch: fetchImpl });
  return parseBufkit(text, { forecastHour, model, station: id });
}

/**
 * Fetch and parse every forecast hour from one IEM BUFKIT file.
 * @param {object} q BUFKIT archive selection.
 * @param {string} q.model Model identifier.
 * @param {string} q.station BUFKIT station identifier.
 * @param {Date|string|number} q.run Model run time (UTC).
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @returns {Promise<object[]>} Soundings for each forecast hour, in file order.
 */
export async function fetchIemBufkitForecasts({ model = 'hrrr', station, run, fetch: fetchImpl }) {
  const { id, text } = await fetchIemBufkitText({ model, station, run, fetch: fetchImpl });
  const hours = listBufkitForecastHours(text);
  if (hours.length === 0) throw new Error('SharpJS: no forecasts found in BUFKIT file');
  return hours.map((forecastHour) => parseBufkit(text, { forecastHour, model, station: id }));
}

async function fetchIemBufkitText({ model, station, run, fetch: fetchImpl }) {
  const id = String(station || '').trim();
  if (!id) throw new Error('SharpJS: station is required');
  const r = toDate(run);
  const url = `${IEM_BUFKIT}/${bufkitPath(model, id, r)}`;
  let res;
  try {
    res = await getOk(url, fetchImpl);
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`No ${model.toUpperCase()} BUFKIT for ${id.toUpperCase()} at ${pad(r.getUTCHours())}Z ${r.toISOString().slice(0, 10)}`, { cause: err });
    }
    throw err;
  }
  return { id, text: await res.text() };
}

/**
 * List NEXRAD S3 object keys matching a prefix.
 * @param {string} prefix Object-key prefix.
 * @param {Function} fetchImpl Fetch-compatible function.
 * @returns {Promise<string[]>} Matching S3 object keys.
 */
async function listKeys(prefix, fetchImpl) {
  const res = await getOk(`${NEXRAD_L3}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`, fetchImpl);
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

/** "OAX_NVW_2024_05_26_12_03_45" → unix seconds. */
function keyUnix(key) {
  const m = /_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : NaN;
}

/**
 * NEXRAD VAD Wind Profile (NVW) from Unidata's public Level III bucket (2020 onward).
 *
 * @param {object} q
 * @param {string} q.radar             e.g. "OAX" or "KOAX"
 * @param {Date|string|number} [q.time] closest volume at or before this time (default: latest)
 * @param {object} [q.background]      sounding to take thermodynamics from (default: standard atmosphere)
 * @param {Function} [q.fetch]
 */
export async function fetchNexradVwp({ radar, time, background, fetch: fetchImpl }) {
  let id = String(radar || '').trim().toUpperCase();
  if (id.length === 4) id = id.slice(1);
  if (!/^[A-Z0-9]{3}$/.test(id)) throw new Error('SharpJS: radar must be a 3- or 4-letter id');

  const target = time != null ? toDate(time) : new Date();
  let keys = [];
  // The current hour can be empty right after the top of the hour; look back a little.
  for (let back = 0; back <= 2 && keys.length === 0; back++) {
    const h = new Date(target.getTime() - back * 3600 * 1000);
    const prefix = `${id}_NVW_${h.getUTCFullYear()}_${pad(h.getUTCMonth() + 1)}_${pad(h.getUTCDate())}_${pad(h.getUTCHours())}`;
    keys = (await listKeys(prefix, fetchImpl)).filter((k) => keyUnix(k) <= target.getTime() / 1000 + 60);
  }
  if (keys.length === 0) throw new Error(`No VWP for ${id} near ${target.toISOString()}`);
  keys.sort((a, b) => keyUnix(a) - keyUnix(b));
  const key = keys[keys.length - 1];

  const res = await getOk(`${NEXRAD_L3}/${key}`, fetchImpl);
  const sounding = buildVwpSounding(await res.arrayBuffer(), { radar: id, background });
  if (!sounding) throw new Error(`VWP for ${id} has no wind levels`);
  return sounding;
}

/**
 * Fetch every archived NEXRAD VWP volume in an inclusive UTC time window.
 * @param {object} q Archive query and optional progress callback.
 * @param {string} q.radar Three- or four-letter radar id.
 * @param {Date|string|number} q.start Inclusive window start.
 * @param {Date|string|number} q.end Inclusive window end.
 * @param {object} [q.background] Sounding to take thermodynamics from.
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @param {(sounding: object, progress: { index: number, total: number }) => void} [q.onVolume] Called as each volume is ready.
 * @returns {Promise<object[]>} Soundings ordered by volume time.
 */
export async function fetchNexradVwpArchive({ radar, start, end, background, fetch: fetchImpl, onVolume }) {
  let id = String(radar || '').trim().toUpperCase();
  if (id.length === 4) id = id.slice(1);
  if (!/^[A-Z0-9]{3}$/.test(id)) throw new Error('SharpJS: radar must be a 3- or 4-letter id');

  const first = toDate(start);
  const last = toDate(end);
  if (first > last) throw new Error('SharpJS: VWP archive start must not be after end');

  const keys = new Set();
  const hour = new Date(first);
  hour.setUTCMinutes(0, 0, 0);
  const finalHour = new Date(last);
  finalHour.setUTCMinutes(0, 0, 0);
  for (; hour <= finalHour; hour.setUTCHours(hour.getUTCHours() + 1)) {
    const prefix = `${id}_NVW_${hour.getUTCFullYear()}_${pad(hour.getUTCMonth() + 1)}_${pad(hour.getUTCDate())}_${pad(hour.getUTCHours())}`;
    for (const key of await listKeys(prefix, fetchImpl)) {
      const timestamp = keyUnix(key) * 1000;
      if (timestamp >= first.getTime() && timestamp <= last.getTime()) keys.add(key);
    }
  }

  const orderedKeys = [...keys].sort((a, b) => keyUnix(a) - keyUnix(b));
  if (orderedKeys.length === 0) throw new Error(`No VWP volumes for ${id} from ${first.toISOString()} to ${last.toISOString()}`);

  const soundings = [];
  for (let index = 0; index < orderedKeys.length; index++) {
    const key = orderedKeys[index];
    const res = await getOk(`${NEXRAD_L3}/${key}`, fetchImpl);
    const sounding = buildVwpSounding(await res.arrayBuffer(), { radar: id, background });
    if (!sounding) throw new Error(`VWP for ${id} has no wind levels at ${key}`);
    soundings.push(sounding);
    onVolume?.(sounding, { index: index + 1, total: orderedKeys.length });
  }
  return soundings;
}
