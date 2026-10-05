/**
 * BUFKIT (model point forecast) files → SharpJS sounding objects.
 *
 * Column order is read from the file's SNPARM header, so any model's BUFKIT
 * layout works (RAP/HRRR/NAM include CFRL, GFS does not).
 * Pure functions: no DOM, no network.
 */
import { RelHum, DewFromTRh, wetbulb, GetLayerByPres, VirtTemp } from '../calc/skewtCalcs.js';
import { Process } from './sharppy.js';

const DEFAULT_COLUMNS = ['PRES', 'TMPC', 'TMWC', 'DWPC', 'THTE', 'DRCT', 'SKNT', 'OMEG', 'CFRL', 'HGHT'];
const GFS_COLUMNS = ['PRES', 'TMPC', 'TMWC', 'DWPC', 'THTE', 'DRCT', 'SKNT', 'OMEG', 'HGHT'];

/** Model id from a BUFKIT file name, e.g. "rap_kdsm.buf" → "rap", "gfs3_kdsm.buf" → "gfs". */
function modelFromFileName(fileName) {
  const m = /(?:^|[\\/])([a-z0-9]+)_[a-z0-9]+\.buf$/i.exec(String(fileName || ''));
  if (!m) return null;
  const id = m[1].toLowerCase();
  if (id === 'gfs3') return 'gfs';
  if (id === 'namm') return 'nam';
  return id;
}

/** True when the text looks like a BUFKIT file. */
export function isBufkitText(text) {
  return typeof text === 'string' && text.includes('STID') && text.includes('STNM') && /STIM\s*=/.test(text);
}

/** "KEY = value" pairs from a BUFKIT station block. An empty value (e.g. "STID = STNM = 1") stays ''. */
function readKeyValues(block) {
  const tokens = block.split(/\s+/).filter(Boolean);
  const out = {};
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i + 1] !== '=') continue;
    const value = tokens[i + 2];
    out[tokens[i]] = value !== undefined && tokens[i + 3] !== '=' ? value : '';
    i += 1;
  }
  return out;
}

function splitSections(text) {
  const sections = text.split('STID').slice(1).map((s) => `STID${s}`);
  if (sections.length > 0) {
    const last = sections[sections.length - 1];
    const sfc = last.indexOf('STN YYMMDD/HHMM');
    if (sfc !== -1) sections[sections.length - 1] = last.substring(0, sfc);
  }
  return sections;
}

function forecastHourOf(section) {
  const m = /STIM\s*=\s*(-?[\d.]+)/.exec(section);
  return m ? parseFloat(m[1]) : NaN;
}

/** Forecast hours available in a BUFKIT file, in file order. */
export function listBufkitForecastHours(text) {
  return splitSections(text).map(forecastHourOf).filter((h) => Number.isFinite(h));
}

/** "240526/1200" → Date (UTC). */
function parseBufkitTime(value) {
  const m = /^(\d{2})(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return new Date(Date.UTC(2000 + parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10)));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const mdy = (d) => `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCFullYear(), 4)}`;

/**
 * Parse one forecast hour of a BUFKIT file.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.forecastHour]  STIM to pull (default: first forecast in the file)
 * @param {string} [options.model]         model name for the title (default: from fileName, else "BUFKIT")
 * @param {string} [options.station]       station id for files with an empty STID
 * @param {string} [options.fileName]      e.g. "rap_kdsm.buf"
 * @returns {object} sounding
 */
export function parseBufkit(text, options = {}) {
  if (!isBufkitText(text)) throw new Error('SharpJS: not a BUFKIT file');

  const headerEnd = text.indexOf('STID');
  const snparm = /SNPARM\s*=\s*([A-Z0-9;]+)/.exec(text.slice(0, headerEnd));
  const model = String(options.model || modelFromFileName(options.fileName) || 'bufkit').toLowerCase();
  const columns = snparm ? snparm[1].split(';') : (model === 'gfs' ? GFS_COLUMNS : DEFAULT_COLUMNS);
  const col = (name) => columns.indexOf(name);
  for (const name of ['PRES', 'TMPC', 'DWPC', 'DRCT', 'SKNT', 'HGHT']) {
    if (col(name) === -1) throw new Error(`SharpJS: BUFKIT file has no ${name} column`);
  }

  const sections = splitSections(text);
  if (sections.length === 0) throw new Error('SharpJS: no forecasts found in BUFKIT file');

  const wantHour = options.forecastHour != null ? parseFloat(options.forecastHour) : forecastHourOf(sections[0]);
  const Selected = sections.find((s) => forecastHourOf(s) === wantHour);
  if (!Selected) throw new Error(`SharpJS: F${wantHour} not found in BUFKIT file`);
  const FHour = wantHour;

  const hghtIndex = Selected.lastIndexOf('HGHT');
  const presIndex = Selected.lastIndexOf('PRES');
  if (hghtIndex === -1 || presIndex === -1) throw new Error('SharpJS: corrupt BUFKIT section (missing header)');

  const meta = readKeyValues(Selected.slice(0, presIndex));
  if (!meta.STID && options.station) meta.STID = String(options.station).toUpperCase();

  // Every level is columns.length numbers; files wrap them over two lines.
  const values = Selected.slice(hghtIndex + 4).split(/\s+/).filter(Boolean).map(parseFloat);
  const rows = [];
  for (let i = 0; i + columns.length <= values.length; i += columns.length) {
    rows.push(values.slice(i, i + columns.length));
  }
  if (rows.length < 2) throw new Error('SharpJS: BUFKIT section has fewer than two levels');

  const iP = col('PRES'), iT = col('TMPC'), iD = col('DWPC'), iWD = col('DRCT'), iWS = col('SKNT'), iH = col('HGHT'), iO = col('OMEG');

  // Above the last moist level, hold the last relative humidity (same as the IEM RAOB path).
  let LastMoisture = 0;
  let LastRH = 0;
  for (let x = 0; x < rows.length; x++) {
    if (rows[x][iD] !== -9999) {
      LastMoisture = x;
      LastRH = RelHum(rows[x][iT], rows[x][iD]);
    }
  }

  const Slices = rows.map((r, x) => {
    let DWPT = r[iD];
    if (x >= LastMoisture) DWPT = DewFromTRh(r[iT], LastRH);
    const omega = iO !== -1 && r[iO] !== -9999 ? r[iO] / 30 : 0;
    return [r[iP], r[iH], r[iT], DWPT, r[iWD], r[iWS], omega];
  });
  Slices.sort((a, b) => b[0] - a[0]);

  let InfoString = '';
  for (const P of Slices) {
    InfoString += ` ${P[0]},\t${P[1]},\t${P[2]},\t${P[3]},\t${P[4]},\t${P[5]}\n`;
  }

  const valid = parseBufkitTime(meta.TIME);
  const run = valid ? new Date(valid.getTime() - FHour * 3600 * 1000) : null;
  const station = meta.STID || '';
  const Title = run
    ? `${model.toUpperCase()} ${mdy(run)} ${pad(run.getUTCHours())}Z - F${pad(FHour, 3)}; Valid: ${mdy(valid)} ${pad(valid.getUTCHours())}Z; Location: ${meta.SLAT}N, ${meta.SLON}W`
    : `${model.toUpperCase()} ${station} F${pad(FHour, 3)}`;

  const text2 = `%TITLE%
  ${Title}
  Saved by: SharpJS
      LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD
  -------------------------------------------------------------------
  %RAW%
  ${InfoString}%END%`;

  const ProcessedSounding = Process(text2);
  const lat = parseFloat(meta.SLAT);
  const lon = parseFloat(meta.SLON);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // Location keeps the original SharpJS BUFKIT convention (west-positive longitude).
    ProcessedSounding.Location = [lat, -lon];
    ProcessedSounding.Location2 = ProcessedSounding.Location;
    ProcessedSounding.Coords = { lat, lon };
  }
  ProcessedSounding.Sounding.OMEGA = Slices.map((k) => k[6]);

  for (let x = 0; x < ProcessedSounding.Sounding.Slice.length; x++) {
    ProcessedSounding.Sounding.Slice[x].push(Slices[x][6]);
    ProcessedSounding.Sounding.Slice[x][6] = wetbulb(ProcessedSounding.Sounding.Slice[x][0], ProcessedSounding.Sounding.Slice[x][2], ProcessedSounding.Sounding.Slice[x][3]);
  }

  for (let x = 0; x < ProcessedSounding.Sounding.TW.length; x++) {
    const TWI = ProcessedSounding.Sounding.TW[x];
    const Layer = GetLayerByPres(ProcessedSounding.Sounding, TWI.P);
    TWI.WB = wetbulb(Layer.P, Layer.T, Layer.D);
    TWI.VT = VirtTemp(Layer, ProcessedSounding.Sounding.P[0], false, true);
  }

  ProcessedSounding.meta = {
    source: 'bufkit',
    model,
    station,
    forecastHour: FHour,
    valid: valid ? valid.toISOString() : null,
    run: run ? run.toISOString() : null,
  };
  return ProcessedSounding;
}
