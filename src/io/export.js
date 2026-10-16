/**
 * SharpJS sounding → text formats (SHARPpy, SharpJS-with-omega, CM1 input_sounding).
 * Pure functions: no DOM.
 */
import { ConvertPolartoCart, ConvertToInfo, GetLayerByPres } from '../calc/skewtCalcs.js';
import { KTStoMPS } from './general.js';

/**
 * Round a CM1 value to the precision selected by tt.
 * @param {number} N Value to round
 * @param {number} tt Precision selector (1, 2, or other; in unitless).
 * @returns {number} Rounded value
 */
function CM1Round(N, tt=1){
  if (tt == 1){
    return Math.round(N * 10**4)/10**4;
  } else if (tt == 2){
    return Math.round(N * 10**6)/10**6;
  } else {
    return Math.round(N * 10**2)/10**2;
  }
}

/**
 * Convert pressure and dewpoint to water-vapor mixing ratio for CM1 output.
 * @param {number} pressure Pressure (in hPa).
 * @param {number} dewpoint Dewpoint temperature (in °C).
 * @returns {number} Water-vapor mixing ratio (in g/kg).
 */
function calculateQV(pressure, dewpoint) {
  const EPSILON = 0.62197; 
  const e = 6.1121 * Math.exp((17.67 * dewpoint) / (dewpoint + 243.5));
  const qv = (EPSILON * e) / (pressure - e);
  return qv*1000;
}

/**
 * Calculate high-precision water-vapor mixing ratio from pressure and dewpoint.
 * @param {number} p Pressure (in hPa).
 * @param {number} tdC Dewpoint temperature (in °C).
 * @returns {number} Water-vapor mixing ratio (in g/kg).
 */
function mixratiohighprec(p, tdC) {
  const eps = 0.62195691;
  const e = 6.112 * Math.exp((17.67 * tdC) / (tdC + 243.5));
  const w = (eps * e) / (p - e);
  return w * 1000.0;
}

/**
 * Calculate potential temperature for a pressure level.
 * @param {number} p Pressure (in hPa).
 * @param {number} tC Air temperature (in °C).
 * @param {number} p0 Reference pressure (in hPa).
 * @returns {number} Potential temperature (in K).
 */
function thetahighprec(p, tC, p0 = 1000) {
  return (tC + 273.15) * Math.pow(p0 / p, 0.2854);
}

/**
 * Format one row of values as fixed-width CM1 sounding text.
 * @param {Array<number|string>} values Values to write; columns have the units required by CM1.
 * @param {boolean} isQV Whether the row is the surface header row.
 * @returns {string} Space-padded numeric fields for one CM1 row.
 */
function formatCM1Line(values, isQV = false) {
  return values.map((val, i) => {
    val = parseFloat(val);
    const decimals = (isQV && i === 2) || (!isQV && i === 2) ? 6 : 4;
    return val.toFixed(decimals).padStart(12);
  }).join("");
}

/**
 * Serialize a sounding as a CM1 input_sounding file.
 * @param {object} Snding Parsed SharpJS sounding.
 * @returns {{text: string, filename: string}} CM1 text and its suggested file name.
 */
function exportToCm1(Snding){
  let text = "";
  const Sound = Snding.Sounding;

  const StartSlice = GetLayerByPres(Sound, "SFC"); 
  const sfcP = StartSlice.P;
  const sfcTta = thetahighprec(sfcP, StartSlice.T);
  const sfcQV = mixratiohighprec(sfcP, StartSlice.D);

  text += formatCM1Line([sfcP, sfcTta, sfcQV], true) + "\n";

  for (let i = 1; i < Sound.Slice.length; i++) {
    const P = ConvertToInfo(Sound.Slice[i], Sound.Slice[0]);
    
    const H = P.H - StartSlice.H; // height above ground (CM1 input_sounding is AGL)
    const tta = thetahighprec(P.P, P.T);
    const qv = mixratiohighprec(P.P, P.D);
    
    let windcomps = ConvertPolartoCart(P);
    let u = CM1Round(KTStoMPS(windcomps.x));
    let v = CM1Round(-KTStoMPS(windcomps.y));

    text += formatCM1Line([H, tta, qv, u, v]) + "\n";
  }

  return { 
    text: text.trimEnd(), 
    filename: `input_sounding.txt` 
  };
}

/**
 * Round a value to the nearest multiple of 1/m.
 * @param {number} N Value to round
 * @param {number} m Scale factor (in unitless).
 * @returns {number} Rounded value
 */
function RoundTo(N, m){
  return Math.round(N * m)/m;
}

/**
 * @param {object} Snding  sounding object
 * @param {boolean} OmegaBar  include the OMEGA column (SharpJS flavour)
 * @param {object} [options]
 * @param {string} [options.savedBy]     text after "Saved by: " (default "SharpJS")
 * @param {string} [options.filePrefix]  download file name prefix (default "SharpJS_Sounding")
 */
function exportToSharppy(Snding, OmegaBar, options = {}){
  const savedBy = options.savedBy || 'SharpJS';
  const filePrefix = options.filePrefix || 'SharpJS_Sounding';
  let InfoString = "";
  let Sound = Snding.Sounding;

  for (let i = 0; i < Sound.Slice.length; i++) {
    let P = Sound.Slice[i]
    if (OmegaBar){
      InfoString += ` ${RoundTo(P[0], 100)},\t${RoundTo(P[1], 100)},\t${RoundTo(P[2], 100)},\t${RoundTo(P[3], 100)},\t${RoundTo(P[4], 100)},\t${RoundTo(P[5], 100)},\t${RoundTo(P[7], 100)}\n`;
    } else {
      InfoString += ` ${RoundTo(P[0], 100)},\t${RoundTo(P[1], 100)},\t${RoundTo(P[2], 100)},\t${RoundTo(P[3], 100)},\t${RoundTo(P[4], 100)},\t${RoundTo(P[5], 100)}\n`;
    }
  }

  let P = `     LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD       OMEGA
--------------------------------------------------------------------------------`

  if (!OmegaBar){
    P = `     LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD
---------------------------------------------------------------------------`
  }

  let text = `%TITLE%
${Snding.STitle}
Saved by: ${savedBy}
${P}
%RAW%
${InfoString}%END%`;

  // Clean up filename to be safe for filesystems
  let safeTitle = String(Snding.Title || "sounding").trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'sounding';
  let filename = `${filePrefix}_${safeTitle}.txt`;

  return { text, filename };
}

/** Export formats understood by exportSounding(). */
export const EXPORT_FORMATS = {
  Default: 'SHARPpy',
  SharpJS: 'SharpJS (SHARPpy + omega)',
  CM1: 'CM1 input_sounding',
};

/**
 * Serialize a sounding.
 * @param {object} sounding
 * @param {'Default'|'SharpJS'|'CM1'} [format='Default']
 * @param {object} [options]  see exportToSharppy
 * @returns {{ text: string, filename: string } | null}
 */
export function exportSounding(sounding, format = 'Default', options = {}) {
  if (!sounding || !sounding.Sounding) return null;
  if (format === 'CM1') return exportToCm1(sounding);
  return exportToSharppy(sounding, format === 'SharpJS', options);
}

export { exportToSharppy as toSharppyText, exportToCm1 as toCm1Text };
