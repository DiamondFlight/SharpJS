/**
 * Optional loaders for public data (all endpoints send CORS headers, so they work from a static site).
 *
 * The SharpJS core never imports this module. Apps that already have their own data
 * pipeline pass soundings straight to SharpJS(el, { sounding }) instead.
 *
 *   - Iowa Environmental Mesonet RAOB archive   https://mesonet.agron.iastate.edu/json/raob.py
 *   - Iowa Environmental Mesonet BUFKIT archive https://mtarchive.geol.iastate.edu/
 *   - Unidata NEXRAD Level III on AWS           https://unidata-nexrad-level3.s3.amazonaws.com
 *   - ACARS archive                             https://sharp.weather.ou.edu/soundings/acars/
 *
 * Please be kind to these free services: fetch on user action, not on a timer.
 */
import { parseIemRaob } from '../io/iem.js';
import { parseSounding } from '../io/parse.js';
import { parseBufkit, listBufkitForecastHours } from '../io/bufkit.js';
import { buildVwpSounding } from '../io/vwp.js';
import { withLocation } from '../io/location.js';
import { getAviationStationCatalog, indexAviationStations } from '../io/station_catalog.js';
import { pad } from '../io/general.js';

const IEM_RAOB = 'https://mesonet.agron.iastate.edu/json/raob.py';
const IEM_BUFKIT = 'https://mtarchive.geol.iastate.edu';
const NEXRAD_L3 = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const NEXRAD_RADAR_STATIONS = 'https://api.weather.gov/radar/stations';
const ACARS_ARCHIVE = 'https://sharp.weather.ou.edu/soundings/acars';
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
 * @param {{lat:number,lon:number}} [q.location] Station-map coordinates to use instead of file coordinates.
 * @param {Function} [q.fetch]
 */
export async function fetchIemBufkit({ model = 'hrrr', station, run, forecastHour = 0, location, fetch: fetchImpl }) {
  const { id, text } = await fetchIemBufkitText({ model, station, run, fetch: fetchImpl });
  return parseBufkit(text, { forecastHour, model, station: id, location });
}

/**
 * Fetch and parse every forecast hour from one IEM BUFKIT file.
 * @param {object} q BUFKIT archive selection.
 * @param {string} q.model Model identifier.
 * @param {string} q.station BUFKIT station identifier.
 * @param {Date|string|number} q.run Model run time (UTC).
 * @param {{lat:number,lon:number}} [q.location] Station-map coordinates to use instead of file coordinates.
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @returns {Promise<object[]>} Soundings for each forecast hour, in file order.
 */
export async function fetchIemBufkitForecasts({ model = 'hrrr', station, run, location, fetch: fetchImpl }) {
  const { id, text } = await fetchIemBufkitText({ model, station, run, fetch: fetchImpl });
  const hours = listBufkitForecastHours(text);
  if (hours.length === 0) throw new Error('SharpJS: no forecasts found in BUFKIT file');
  return hours.map((forecastHour) => parseBufkit(text, { forecastHour, model, station: id, location }));
}

/**
 * List ACARS reports in the inclusive lookback ending at `time`.
 * @param {object} q ACARS archive selection.
 * @param {Date|string|number} q.time Inclusive UTC window end.
 * @param {number} [q.hours=6] Lookback window in hours; must be between 0 and 24.
 * @param {string} [q.station] Optional three-character ACARS station code.
 * @param {string} [q.baseUrl] Archive base URL or CORS-enabled proxy preserving the archive path structure.
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @returns {Promise<Array<{station:string, time:number, url:string}>>} Reports in chronological order.
 */
export async function listAcarsArchive({ time, hours = 6, station, baseUrl = ACARS_ARCHIVE, fetch: fetchImpl }) {
  const end = toDate(time);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error('SharpJS: ACARS lookback hours must be greater than 0 and no more than 24');
  }
  const stationId = station == null || String(station).trim() === ''
    ? null
    : String(station).trim().toUpperCase();
  if (stationId && !/^[A-Z0-9]{3}$/.test(stationId)) {
    throw new Error('SharpJS: ACARS station must be a three-character code');
  }
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!root) throw new Error('SharpJS: ACARS archive base URL is required');
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const firstHour = new Date(start);
  firstHour.setUTCMinutes(0, 0, 0);
  const lastHour = new Date(end);
  lastHour.setUTCMinutes(0, 0, 0);
  const directories = [];
  for (const hour = new Date(firstHour); hour <= lastHour; hour.setUTCHours(hour.getUTCHours() + 1)) {
    directories.push(new Date(hour));
  }
  const listings = await Promise.all(directories.map((hour) => listAcarsDirectory(hour, root, fetchImpl)));
  const reports = listings.flat().filter((report) =>
    report.time >= start.getTime() &&
    report.time <= end.getTime() &&
    (!stationId || report.station === stationId));
  reports.sort((a, b) => a.time - b.time || a.station.localeCompare(b.station) || a.url.localeCompare(b.url));
  return reports;
}

/**
 * Fetch and parse all ACARS soundings in the inclusive six-hour lookback by default.
 * Files are already SHARPpy text; station coordinates are attached from the bundled catalog.
 * @param {object} q ACARS archive selection and progress callback.
 * @param {Date|string|number} q.time Inclusive UTC window end.
 * @param {number} [q.hours=6] Lookback window in hours.
 * @param {string} [q.station] Optional three-character ACARS station code.
 * @param {string} [q.baseUrl] Archive base URL or CORS-enabled proxy preserving the archive path structure.
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @param {(sounding: object, progress: {index:number,total:number,station:string}) => void} [q.onSounding] Called as each report is ready.
 * @returns {Promise<object[]>} Soundings ordered by report time.
 */
export async function fetchAcarsArchive({ time, hours = 6, station, baseUrl = ACARS_ARCHIVE, fetch: fetchImpl, onSounding }) {
  const reports = await listAcarsArchive({ time, hours, station, baseUrl, fetch: fetchImpl });
  if (!reports.length) throw new Error('No ACARS reports found in the selected time window');
  const catalog = await getAviationStationCatalog(fetchImpl || fetch);
  const stationIndex = indexAviationStations(catalog);
  const soundings = new Array(reports.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(6, reports.length) }, async () => {
    while (nextIndex < reports.length) {
      const index = nextIndex++;
      const report = reports[index];
      const response = await getAcarsOk(report.url, fetchImpl);
      const sounding = parseSounding(await response.text(), { fileName: `${report.station}.txt` });
      const sourceTitle = sounding.Title;
      const validTime = acarsTitleTime(sourceTitle, report.time);
      const record = stationIndex.get(report.station);
      const lat = Number(record?.lat);
      const lon = Number(record?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) withLocation(sounding, { lat, lon });
      sounding.meta = {
        ...(sounding.meta || {}),
        source: 'acars',
        station: report.station,
        sourceTitle,
        fileTime: new Date(report.time).toISOString(),
        archiveTime: validTime.toISOString(),
      };
      const month = pad(validTime.getUTCMonth() + 1);
      const day = pad(validTime.getUTCDate());
      const hour = pad(validTime.getUTCHours());
      const minute = pad(validTime.getUTCMinutes());
      sounding.Title = `ACARS OBSERVED: ${report.station} - VALID ${month} ${day} ${validTime.getUTCFullYear()} - ${hour}${minute}Z`;
      sounding.STitle = sounding.Title;
      soundings[index] = sounding;
      completed += 1;
      onSounding?.(sounding, { index: completed, total: reports.length, station: report.station });
    }
  });
  await Promise.all(workers);
  return soundings;
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

async function listAcarsDirectory(hour, baseUrl, fetchImpl) {
  const directory = `${baseUrl}/${hour.getUTCFullYear()}/${pad(hour.getUTCMonth() + 1)}/${pad(hour.getUTCDate())}/${pad(hour.getUTCHours())}/`;
  let response;
  try {
    response = await getAcarsOk(directory, fetchImpl);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
  const html = await response.text();
  const reports = [];
  for (const [, href] of html.matchAll(/href=["']([^"'?#]+)["']/gi)) {
    const fileName = decodeURIComponent(href.split('/').at(-1));
    const match = /^([A-Z0-9]{3})_(\d{2})(\d{2})\.txt$/i.exec(fileName);
    if (!match) continue;
    const reportHour = Number(match[2]);
    const reportMinute = Number(match[3]);
    if (reportHour !== hour.getUTCHours() || reportHour > 23 || reportMinute > 59) continue;
    const reportTime = new Date(hour);
    reportTime.setUTCHours(reportHour, reportMinute, 0, 0);
    reports.push({
      station: match[1].toUpperCase(),
      time: reportTime.getTime(),
      url: `${directory}${encodeURIComponent(fileName)}`,
    });
  }
  return reports;
}

function acarsTitleTime(title, fallback) {
  const match = /\b(\d{2})(\d{2})(\d{2})\/(\d{2})(\d{2})\b/.exec(String(title || ''));
  if (!match) return new Date(fallback);
  const baseYear = new Date(fallback).getUTCFullYear();
  const yy = Number(match[1]);
  let year = Math.floor(baseYear / 100) * 100 + yy;
  if (year - baseYear > 50) year -= 100;
  if (baseYear - year > 50) year += 100;
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const validTime = new Date(Date.UTC(year, month, day, hour, minute));
  if (validTime.getUTCFullYear() !== year || validTime.getUTCMonth() !== month ||
    validTime.getUTCDate() !== day || hour > 23 || minute > 59) return new Date(fallback);
  return validTime;
}

async function getAcarsOk(url, fetchImpl) {
  try {
    return await getOk(url, fetchImpl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        'ACARS archive request was blocked or unreachable; use a same-origin deployment or configure a CORS-enabled ACARS proxy.',
        { cause: error },
      );
    }
    throw error;
  }
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

/**
 * Load the NWS WSR-88D radar site catalog used by the VWP map.
 * This lists network locations, not historical product availability.
 * @param {object} [q]
 * @param {Function} [q.fetch] Fetch-compatible function.
 * @returns {Promise<Array<{code:string, city:string, state:string, country:string, lat:number, lon:number}>>}
 */
export async function fetchNexradVwpRadarStations({ fetch: fetchImpl } = {}) {
  const response = await getOk(NEXRAD_RADAR_STATIONS, fetchImpl);
  const catalog = await response.json();
  if (!Array.isArray(catalog?.features)) {
    throw new Error('SharpJS: NWS radar station response has an invalid format');
  }
  return catalog.features.flatMap((feature) => {
    const props = feature.properties || {};
    const code = String(props.id || '').trim().toUpperCase().replace(/^K/, '');
    const [lon, lat] = feature.geometry?.coordinates || [];
    if (props.stationType !== 'WSR-88D' || !/^[A-Z0-9]{3}$/.test(code) ||
      !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{
      code,
      city: String(props.name || code),
      state: '',
      country: 'United States',
      lat,
      lon,
    }];
  }).sort((a, b) => a.code.localeCompare(b.code));
}
