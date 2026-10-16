/**
 * Plain arrays → SharpJS sounding. This is the entry point for apps that already have a profile
 * in memory (model output, a radiosonde decoder, a database row, …).
 */
import { DewFromTRh } from '../calc/skewtCalcs.js';
import { Process } from './sharppy.js';
import { withLocation } from './location.js';

const MISSING = -9999;
const KT_PER = { kt: 1, 'm/s': 1.943844, mph: 0.868976, 'km/h': 0.539957 };

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const ok = (v) => Number.isFinite(v) && v !== MISSING;

/**
 * Convert a temperature value from the selected unit to Celsius.
 * @param {number} v Temperature value (in the unit named by unit).
 * @param {string} unit Input temperature unit: C, K, or F.
 * @returns {number} Temperature (in °C), or NaN when v is invalid.
 */
function toCelsius(v, unit) {
  if (!ok(v)) return NaN;
  if (unit === 'K') return v - 273.15;
  if (unit === 'F') return ((v - 32) * 5) / 9;
  return v;
}

/** Heights (m) from the hypsometric equation, integrating up from `elevation` at the first level. */
function hypsometricHeights(p, tC, elevation) {
  const h = new Array(p.length).fill(NaN);
  h[0] = elevation;
  for (let i = 1; i < p.length; i++) {
    const t0 = ok(tC[i - 1]) ? tC[i - 1] : tC[i];
    const t1 = ok(tC[i]) ? tC[i] : t0;
    const tMeanK = ((ok(t0) ? t0 : 15) + (ok(t1) ? t1 : 15)) / 2 + 273.15;
    h[i] = h[i - 1] + (287.05 / 9.80665) * tMeanK * Math.log(p[i - 1] / p[i]);
  }
  return h;
}

/**
 * Build a sounding from parallel arrays (one entry per level, any vertical order).
 *
 * @param {object} profile
 * @param {number[]} profile.pressure          hPa (mb), required
 * @param {number[]} [profile.height]          m above sea level (computed from T and p when omitted)
 * @param {number[]} profile.temperature       °C unless options.units.temperature says otherwise
 * @param {number[]} [profile.dewpoint]        °C (same unit as temperature) …
 * @param {number[]} [profile.relativeHumidity] … or relative humidity in %
 * @param {number[]} [profile.windDirection]   degrees the wind blows from …
 * @param {number[]} [profile.windSpeed]       … and speed (kt unless options.units.windSpeed)
 * @param {number[]} [profile.u]               … or u/v components (m/s unless options.units.windSpeed)
 * @param {number[]} [profile.v]
 * @param {number[]} [profile.omega]           vertical velocity, Pa/s
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {{ lat: number, lon: number }} [options.location]
 * @param {number} [options.elevation=0]       surface height (m) when heights must be computed
 * @param {{ temperature?: 'C'|'K'|'F', windSpeed?: 'kt'|'m/s'|'mph'|'km/h' }} [options.units]
 * @param {boolean} [options.isModel]          gridded model data: skip the hodograph thinning used for
 *                                             high-resolution observations
 * @param {boolean} [options.isDropsonde]      use the dropsonde layout
 * @returns {object} sounding
 */
export function fromArrays(profile, options = {}) {
  if (!profile || !Array.isArray(profile.pressure)) throw new Error('SharpJS: fromArrays needs a pressure array');
  const n = profile.pressure.length;
  if (!Array.isArray(profile.temperature) || profile.temperature.length !== n) {
    throw new Error('SharpJS: temperature must be an array the same length as pressure');
  }
  const units = options.units || {};
  const hasUV = Array.isArray(profile.u) && Array.isArray(profile.v);
  const speedUnit = units.windSpeed || (hasUV && !Array.isArray(profile.windSpeed) ? 'm/s' : 'kt');
  const toKt = KT_PER[speedUnit];
  if (!toKt) throw new Error(`SharpJS: unknown wind speed unit ${speedUnit}`);

  let levels = [];
  for (let i = 0; i < n; i++) {
    const p = num(profile.pressure[i]);
    if (!ok(p) || p <= 0 || p > 1100) continue;
    const t = toCelsius(num(profile.temperature[i]), units.temperature);
    let d = NaN;
    if (Array.isArray(profile.dewpoint)) {
      d = toCelsius(num(profile.dewpoint[i]), units.temperature);
    } else if (Array.isArray(profile.relativeHumidity) && ok(t)) {
      const rh = num(profile.relativeHumidity[i]);
      if (ok(rh) && rh > 0) d = DewFromTRh(t, Math.min(100, rh));
    }
    let wd = NaN;
    let ws = NaN;
    if (Array.isArray(profile.windDirection) && Array.isArray(profile.windSpeed)) {
      wd = num(profile.windDirection[i]);
      ws = num(profile.windSpeed[i]) * toKt;
    } else if (hasUV) {
      const u = num(profile.u[i]);
      const v = num(profile.v[i]);
      if (ok(u) && ok(v)) {
        ws = Math.hypot(u, v) * toKt;
        wd = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
      }
    }
    const om = Array.isArray(profile.omega) ? num(profile.omega[i]) : NaN;
    levels.push({ p, h: Array.isArray(profile.height) ? num(profile.height[i]) : NaN, t, d, wd, ws, om });
  }
  levels.sort((a, b) => b.p - a.p);
  levels = levels.filter((l, i) => i === 0 || l.p < levels[i - 1].p);
  if (levels.length < 2) throw new Error('SharpJS: need at least two levels with valid pressure');

  if (!levels.some((l) => ok(l.h))) {
    const hs = hypsometricHeights(levels.map((l) => l.p), levels.map((l) => l.t), num(options.elevation) || 0);
    levels.forEach((l, i) => { l.h = hs[i]; });
  }

  const cell = (v, digits = 4) => (ok(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : String(MISSING));
  const title = options.title || 'Custom Sounding';
  const rows = levels.map((l) => ` ${cell(l.p)},\t${cell(l.h)},\t${cell(l.t)},\t${cell(l.d)},\t${cell(l.wd)},\t${cell(l.ws)}`);
  const text = `%TITLE%
${title}

     LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD
-------------------------------------------------------------------
%RAW%
${rows.join('\n')}
%END%`;
  const sounding = Process(text);
  sounding.Title = title;
  sounding.STitle = title;

  // Omega in the scale the chart's omega bars expect: -omega(Pa/s) / 50.
  const omegas = levels.map((l) => (ok(l.om) ? Math.round(200 * -l.om) / 10000 : 0));
  if (sounding.Sounding.Slice.length === levels.length) {
    sounding.Sounding.OMEGA = omegas;
    sounding.Sounding.Slice.forEach((row, i) => { row[7] = omegas[i]; });
  }

  if (options.location) withLocation(sounding, options.location);
  if (options.isDropsonde) sounding.isDropsonde = true;
  sounding.meta = { source: 'arrays', isModel: options.isModel === true };
  return sounding;
}
