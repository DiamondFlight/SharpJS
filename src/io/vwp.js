/**
 * NEXRAD VAD Wind Profile (Level III product 48, "NVW") → SharpJS sounding.
 *
 * Pure functions: no DOM, no network. Fetching NVW files is up to the host
 * (see src/sources/nexrad.js for a public Unidata S3 example).
 */
import { GetLayerByHght, GetLayerByPres } from '../calc/skewtCalcs.js';
import { parseVWP } from './nexrad-vwp-parser.js';

export { parseVWP };

/** @returns {{ volumeUnix: number, title: string }} */
function vwpVolumeMetaFromParse(P, radarLabel) {
  const isoString = P.scan.volume_time;
  const date = new Date(isoString);
  const volumeUnix = Math.floor(date.getTime() / 1000);
  const components = {
    year: date.getUTCFullYear(),
    day: date.getUTCDate(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
  };
  const utcMonthAbbrevs = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = utcMonthAbbrevs[date.getUTCMonth()];
  const hm = `${String(components.hours).padStart(2, '0')}:${String(components.minutes).padStart(2, '0')}`;
  const title = `VWP ${radarLabel} — valid ${components.day} ${mon} ${components.year} ${hm} UTC`;
  return { volumeUnix, title };
}

/**
 * Calculate the signed shortest angular difference between two wind directions.
 * @param {number} dir1 First wind direction (in degrees).
 * @param {number} dir2 Second wind direction (in degrees).
 * @returns {number} Signed angular difference (in degrees).
 */
function windDirDiff(dir1, dir2) {
    let diff = (dir1 - dir2 + 180) % 360 - 180;
    return diff < -180 ? diff + 360 : diff;
}

const avgAngle = (a, b) => {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff / 2 + 360) % 360;
};

/**
 * Populate a VWP sounding's wind and thermodynamic profile columns from parsed radar levels.
 * @param {object} VWPSounding Sounding structure to update in place.
 * @param {object} P Parsed VWP product containing times, profiles, and wind levels.
 * @returns {void} Updates the sounding's wind, pressure, height, temperature, moisture, and slice columns.
 */
function fillVwpWindColumnsFromParse(VWPSounding, P) {
  const rProf = P.profiles[P.times[0]];
  let sW = [];
  let sSlice = [];
  let sTW = [];
  let sDW = [];
  let sP = [];
  let sT = [];
  let sO = [];
  let sH = [];
  let sD = [];

  // Hodograph: first point = surface (H=0 AGL); second = lowest NEXRAD gate. Slice[0][1]=0 keeps
  // GetLayerByHght(..., aglM, addTo) aligned with true AGL after this fill.
  const surfLayer = GetLayerByHght(VWPSounding.Sounding, 'SFC');
  const surfH_m = 0;
  sH.push(surfH_m);
  sP.push(surfLayer.P);
  sT.push(surfLayer.T);
  sO.push(surfLayer.OM);
  sD.push(surfLayer.D);
  sW.push({
    WD: surfLayer.WD,
    WS: surfLayer.WS,
    H: surfH_m,
  });
  sSlice.push([
    surfLayer.P,
    surfH_m,
    surfLayer.T,
    surfLayer.D,
    surfLayer.WD,
    surfLayer.WS,
    surfLayer.WB,
    surfLayer.OM,
  ]);
  sDW.push({
    H: surfH_m,
    P: surfLayer.P,
    D: surfLayer.D,
  });
  sTW.push({
    H: surfH_m,
    P: surfLayer.P,
    T: surfLayer.T,
    WB: surfLayer.WB,
    VT: surfLayer.VT,
  });

  for (let i = 0; i < rProf.length; i++) {
    const ProfLyr = rProf[i];
    const Layer = GetLayerByHght(VWPSounding.Sounding, ProfLyr.altitude_km_agl * 1000);

    if (sH.includes(ProfLyr.altitude_km_agl * 1000)) {
      continue;
    }

    if (i <= 0){
      if (Math.abs(ProfLyr.speed_kts - surfLayer.WS) > 30 || windDirDiff(ProfLyr.direction_deg, surfLayer.WD) > 30){
        ProfLyr.speed_kts = (rProf[1]== undefined  ? 0 : rProf[1].speed_kts + surfLayer.WS)/2; //(ProfLyr.speed_kts + Layer.WS)/2;
        ProfLyr.direction_deg = rProf[1] == undefined ? surfLayer.WD : rProf[1].direction_deg; //avgAngle(ProfLyr.direction_deg, Layer.WD);
      }
    }

    sH.push(ProfLyr.altitude_km_agl * 1000);
    sP.push(Layer.P);
    sT.push(Layer.T);
    sO.push(Layer.OM);
    sD.push(Layer.D);

    sW.push({
      WD: ProfLyr.direction_deg,
      WS: ProfLyr.speed_kts,
      ...(ProfLyr.rms_kts != null && Number.isFinite(ProfLyr.rms_kts)
        ? { ERR_KTS: ProfLyr.rms_kts }
        : {}),
      H: ProfLyr.altitude_km_agl * 1000,
    });
    sSlice.push([
      Layer.P,
      ProfLyr.altitude_km_agl * 1000,
      Layer.T,
      Layer.D,
      ProfLyr.direction_deg,
      ProfLyr.speed_kts,
      Layer.WB,
      Layer.OM,
    ]);

    sDW.push({
      H: ProfLyr.altitude_km_agl * 1000,
      P: Layer.P,
      D: Layer.D,
    });

    sTW.push({
      H: ProfLyr.altitude_km_agl * 1000,
      P: Layer.P,
      T: Layer.T,
      WB: Layer.WB,
      VT: Layer.VT,
    });
  }

  // Surface row (H=0) uses SFC thermo but if its wind differs from the lowest radar gate, the first
  // hodograph segment is a visible spur toward the plot center. Default: match lowest gate; nearest-ASOS
  // METAR patch overwrites W[0]/Slice[0] later when enabled.
  if (sW.length > 1 && sSlice.length > 1) {
    sW[0].WD = sW[1].WD;
    sW[0].WS = sW[1].WS;
    delete sW[0].ERR_KTS;
    sSlice[0][4] = sSlice[1][4];
    sSlice[0][5] = sSlice[1][5];
  }

  VWPSounding.Sounding.W = sW;
  VWPSounding.Sounding.T = sT;
  VWPSounding.Sounding.P = sP;
  VWPSounding.Sounding.H = sH;
  VWPSounding.Sounding.D = sD;
  VWPSounding.Sounding.OMEGA = sO;
  VWPSounding.Sounding.TW = sTW;
  VWPSounding.Sounding.DW = sDW;
  VWPSounding.DWL = sDW.length;
  VWPSounding.TWL = sTW.length;
  VWPSounding.WWL = sW.length;
  VWPSounding.Sounding.Slice = sSlice;
  VWPSounding.End = GetLayerByPres(VWPSounding.Sounding, 'Last');
}


/** ISA-style thermo column for VWP-only soundings. Winds still come from the NVW product. */
function buildNexradVwpSkeletonSoundingFromParse(P, snding) {
  const rProf = P.profiles && P.times && P.times[0] ? P.profiles[P.times[0]] : null;
  if (!rProf || rProf.length === 0) return null;

  const h0Msl =
    (P.radar && typeof P.radar.height_ft === 'number' ? P.radar.height_ft : 300) * 0.3048;
  const aglMaxM = Math.max(...rProf.map((l) => l.altitude_km_agl * 1000));
  const topMsl = h0Msl + aglMaxM + 3500;
  const step = 200;

  const g = 9.80665;
  const R = 287.05;
  const L = 0.0065;
  const T0 = 288.15;
  const P0 = 1013.25;

  /**
   * Estimate standard-atmosphere pressure at a mean-sea-level height.
   * @param {number} h Height above mean sea level (in m).
   * @returns {number} Pressure (in hPa).
   */
  function pressureMbAtHeightMsl(h) {
    const hh = Math.min(Math.max(h, 0), 11000);
    const T = T0 - L * hh;
    if (T <= 150) return 110;
    return P0 * Math.pow(T / T0, g / (R * L));
  }

  /**
   * Estimate standard-atmosphere temperature at a mean-sea-level height.
   * @param {number} h Height above mean sea level (in m).
   * @returns {number} Temperature (in °C).
   */
  function tempCAtHeightMsl(h) {
    return 15 - L * h;
  }

  const slice = [];
  if (snding !== false){
    for (let h = h0Msl; h <= topMsl; h += step) {
      const Lyr = GetLayerByHght(snding.Sounding, h);
      const Pmb = Lyr.P || pressureMbAtHeightMsl(h);
      const T = Lyr.T || tempCAtHeightMsl(h);
      const D = Lyr.D || T-30;
      const WD = Lyr.WD || 270;
      const WS = Lyr.WS || 5;
      const WB = Lyr.WB || T;
      const OM = Lyr.OM || 0;
      slice.push([Pmb, h, T, D, WD, WS, WB, OM]);
    }
  } else {
    for (let h = h0Msl; h <= topMsl; h += step) {
      const Pmb = pressureMbAtHeightMsl(h);
      const T = tempCAtHeightMsl(h);
      const D = T-30;
      const WD = 270;
      const WS = 5;
      const WB = T;
      const OM = 0;
      slice.push([Pmb, h, T, D, WD, WS, WB, OM]);
    }
  }
  
  return {
    Sounding: {
      W: [],
      T: [],
      P: [],
      H: [],
      D: [],
      OMEGA: [],
      TW: [],
      DW: [],
      Slice: slice,
    },
    Location: [P.radar.latitude, P.radar.longitude],
    Location2: [P.radar.latitude, -P.radar.longitude],
    Title: '',
    STitle: '',
  };
}


/** Radar id from the WMO/AWIPS text header (e.g. "NVWOAX" → "OAX"), if the file still has it. */
function radarIdFromHeader(raw) {
  try {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
    if (!bytes || typeof bytes.length !== 'number') return null;
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 64); i++) head += String.fromCharCode(bytes[i]);
    const m = head.match(/NVW([A-Z0-9]{3})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build a SharpJS VWP sounding from a NEXRAD Level III NVW product.
 *
 * @param {ArrayBuffer|Uint8Array|object} input  Raw NVW bytes, or the result of parseVWP().
 * @param {object} [options]
 * @param {string} [options.radar]       Radar id for the title (read from the file header when omitted).
 * @param {object} [options.background]  A parsed sounding to take temperature/moisture from.
 *                                       Without one, a standard atmosphere is used.
 * @param {boolean} [options.resample]   With `background`: resample it onto a 200 m column first
 *                                       (the "VWP only" layout) instead of keeping its levels.
 * @returns {object|null} sounding object for viewer.update({ vwp }) / engine.applyNexradVwpStoredSounding
 */
export function buildVwpSounding(input, options = {}) {
  const parsed = input && input.profiles && input.radar ? input : parseVWP(input);
  const radar = (options.radar || (input && !input.profiles ? radarIdFromHeader(input) : null) || 'NEXRAD')
    .toString()
    .toUpperCase()
    .replace(/^K(?=[A-Z]{3}$)/, '');

  let built;
  const background = options.background && options.background.Sounding ? options.background : null;
  if (background && !options.resample) {
    built = JSON.parse(JSON.stringify(background));
  } else {
    built = buildNexradVwpSkeletonSoundingFromParse(parsed, background || false);
  }
  if (!built) return null;

  built.Location = [parsed.radar.latitude, parsed.radar.longitude];
  built.Location2 = [parsed.radar.latitude, -parsed.radar.longitude];
  const { volumeUnix, title } = vwpVolumeMetaFromParse(parsed, radar);
  built.Title = title;
  built.STitle = title;
  built.volumeUnix = volumeUnix;
  fillVwpWindColumnsFromParse(built, parsed);
  return built;
}
