/**
 * Iowa Environmental Mesonet RAOB JSON (https://mesonet.agron.iastate.edu/json/raob.py)
 * → SHARPpy text → SharpJS sounding. Pure functions: no network.
 */
import { RelHum, DewFromTRh } from '../calc/skewtCalcs.js';
import { Process } from './sharppy.js';

const KEYS = ['pres', 'hght', 'tmpc', 'dwpc', 'drct', 'sknt'];

function sharppyText(title, body) {
  return `%TITLE%
  ${title}
  Saved by: SharpJS
      LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD
  -------------------------------------------------------------------
  %RAW%
  ${body}%END%`;
}

/** "2024-05-26T12:00:00Z" → "240526/1200" (SHARPpy title time). */
function titleTime(valid) {
  const d = new Date(valid);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}/${p(d.getUTCHours())}00`;
}

/**
 * Convert one IEM RAOB profile to a SharpJS sounding.
 * Dewpoints missing above the last moist level are filled by holding that level's relative humidity.
 *
 * @param {object} json      Response of raob.py, or one entry of its `profiles` array.
 * @param {number} [index=0] Which profile to use when `json.profiles` has several.
 * @returns {object} sounding
 */
export function parseIemRaob(json, index = 0) {
  const tD = json && Array.isArray(json.profiles) ? json.profiles[index] : json;
  if (!tD || !Array.isArray(tD.profile) || tD.profile.length === 0) {
    throw new Error('SharpJS: no RAOB launches found');
  }

  const Title = `${tD.station} ${titleTime(tD.valid)}`.trim();
  const Data = [...tD.profile]
    .sort((a, b) => b.pres - a.pres)
    .filter((item) => item.pres !== null && item.hght !== null);

  let LastMoisture = 0;
  let LastRH = 0;
  for (let x = 0; x < Data.length; x++) {
    const Lbl = Data[x];
    if (parseFloat(Lbl.dwpc) !== -9999 && Lbl.dwpc !== null &&
        parseFloat(Lbl.tmpc) !== -9999 && Lbl.tmpc !== null) {
      LastMoisture = x;
      LastRH = RelHum(parseFloat(Lbl.tmpc), parseFloat(Lbl.dwpc));
    }
  }

  let InfoString = '';
  for (let i = 0; i < Data.length; i++) {
    if (Data[i].pres > 1100 || Data[i].hght < 0) continue;
    InfoString += KEYS.map((key) => (Data[i][key] == null ? '-9999' : `${Data[i][key]}`)).join(',\t') + '\n';
  }

  // First pass fills gaps by interpolation; the second extrapolates moisture aloft.
  const Processed = Process(sharppyText(Title, InfoString));
  InfoString = '';
  for (let i = 0; i < Processed.Sounding.Slice.length; i++) {
    const P = Processed.Sounding.Slice[i];
    let DWPTr = P[3];
    if (P[3] <= -100 || P[3] == null) {
      // NOTE: LastMoisture indexes the unfiltered profile (kept as in SharpJS ≤1.61).
      if (i >= LastMoisture) DWPTr = DewFromTRh(P[2], LastRH);
    }
    InfoString += ` ${P[0]},\t${P[1]},\t${P[2]},\t${DWPTr},\t${P[4]},\t${P[5]}\n`;
  }

  const sounding = Process(sharppyText(Title, InfoString));
  sounding.meta = { source: 'raob', station: tD.station, valid: tD.valid };
  return sounding;
}
