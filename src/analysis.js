/**
 * Headless sounding analysis — the "do the heavy lifting for me" API.
 *
 *   import { parseSounding, analyze } from 'sharpjs/core';
 *   const result = analyze(parseSounding(text), { parcel: 'ML', motion: 'RM' });
 *   result.parcels.ML.cape, result.kinematics.layers['0-1km'].srh, result.indices.stpEffective, …
 *
 * Uses exactly the calculations the chart draws (calc/params.js), with no DOM.
 */
import { GetBM, GetLayerByPres, GetLayerByHght, LiftParcel, UpdateCSMotStorm, DrawInsetParams, ConvertPolartoCart } from './calc/skewtCalcs.js';
import { computeThermo, computeWindParams } from './calc/params.js';
import { toSounding } from './io/input.js';

const MISSING = -9999;
const MOTIONS = ['RM', 'LM', 'MM', 'US', 'DS', 'DTMR', 'DTML'];

const round = (v, digits = 1) => (Number.isFinite(v) && v !== MISSING ? Math.round(v * 10 ** digits) / 10 ** digits : null);

/**
 * Wind vector (knots, as produced by the calc functions) → direction it blows from and speed.
 * Same conversion the chart uses for its labels.
 */
function polar(vec) {
  if (!vec || typeof vec !== 'object' || !Number.isFinite(vec.x) || !Number.isFinite(vec.y)) return null;
  const direction = ((Math.atan2(vec.y, vec.x) * 180) / Math.PI + 270 + 360) % 360;
  return { direction: round(direction, 0), speed: round(Math.hypot(vec.x, vec.y), 1) };
}

/** Storm motions are kept with y flipped (screen space) once lifted into the chart; undo that. */
const polarMotion = (vec) => (vec ? polar({ x: vec.x, y: -vec.y }) : null);

function flipY(motions) {
  const out = {};
  for (const key of MOTIONS) out[key] = { x: motions[key].x, y: -motions[key].y };
  return out;
}

function summarizeParcel(p) {
  if (!p) return null;
  return {
    startPressure: round(p.Start && p.Start.P, 1),
    startHeight: round(p.Start && p.Start.H, 0),
    cape: round(p.Cape, 0),
    cin: round(p.CINH, 0),
    cape3km: round(p.Cape3, 0),
    cape6km: round(p.Cape6, 0),
    ecape: round(p.ECape && p.ECape.Cape, 0),
    ncape: round(p.NCape, 3),
    lcl: round(p.LCL, 0),
    lfc: round(p.LFC, 0),
    el: round(p.EL, 0),
    mpl: round(p.MPL, 0),
  };
}

function srhTotal(srh) {
  if (typeof srh === 'number') return round(srh, 0);
  if (!srh || !Number.isFinite(srh.SRHP)) return null;
  return round(srh.SRHP + srh.SRHM, 0);
}

const LAYERS = {
  '0-500m': '005',
  '0-1km': '01',
  '0-3km': '03',
  '0-6km': '06',
  '1-3km': '13',
  '3-6km': '36',
  '0-9km': '09',
  '0-12km': '012',
  '9-12km': '912',
  'sfc-SBLCL': '0SBLCL',
  'sfc-MLLFC': '0MLLFC',
  'sfc-700mb': '0mb700',
  'sfc-500mb': '0mb500',
  'sfc-300mb': '0mb300',
  'effBot-1km': 'Eb01',
  'effBot-3km': 'Eb03',
  'effBot-6km': 'Eb06',
  'DGZ': 'DGZ',
  'HGZ': 'HGZ',
};

/**
 * Analyze a sounding.
 *
 * @param {string|object} input  sounding text, a parsed sounding, or arrays for fromArrays()
 * @param {object} [options]
 * @param {'MU'|'SB'|'ML'|'CU'} [options.parcel='MU']   parcel used for EHI
 * @param {number} [options.parcelPressure=900]         start pressure for parcel "CU"
 * @param {'RM'|'LM'|'MM'|'US'|'DS'|'DTMR'|'DTML'|{direction:number,speed:number}} [options.motion='RM']
 *        storm motion for SRH / ECAPE (a custom motion is degrees-from and knots)
 * @returns {object} see README "Headless analysis"
 */
export function analyze(input, options = {}) {
  const sounding = toSounding(input);
  const Sound = sounding.Sounding;

  const motions = flipY(GetBM(Sound));
  let CSMot;
  if (options.motion && typeof options.motion === 'object') {
    const c = ConvertPolartoCart({ WD: Number(options.motion.direction) || 0, WS: Number(options.motion.speed) || 0 });
    CSMot = { x: c.x, y: -c.y };
  } else {
    CSMot = motions[MOTIONS.includes(options.motion) ? options.motion : 'RM'];
  }
  UpdateCSMotStorm(CSMot);

  const Info = computeThermo(Sound);
  const parcelKey = options.parcel || 'MU';
  let DP = Info.MUParcel;
  if (parcelKey === 'SB') DP = Info.SBParcel;
  else if (parcelKey === 'ML') DP = Info.MLParcel;
  else if (parcelKey === 'CU') DP = LiftParcel(Sound, 'CU', Number(options.parcelPressure) || 900);

  const Wnd = computeWindParams(sounding, Info, DP, CSMot);
  const inset = DrawInsetParams(sounding, Wnd, { DCapeProf: Info.DCapeProf }, Info.SBParcel, Info.MLParcel, Info.MUParcel, true, {
    WindLapse: 'Default',
    Inset: 'Default',
    Vertical: 'Default',
  });

  const layers = {};
  for (const [name, key] of Object.entries(LAYERS)) {
    if (!(`SRH${key}` in Wnd)) continue;
    const mean = Wnd.MeanWind[`M${key}`];
    layers[name] = {
      srh: srhTotal(Wnd[`SRH${key}`]),
      bulkShear: polar(Wnd[`BWD${key}`]),
      meanWind: polar(mean),
      stormRelativeWind: mean && typeof mean === 'object' ? polar({ x: mean.x - CSMot.x, y: mean.y + CSMot.y }) : null,
      ehi: round(Wnd[`EHI${key}`], 1),
    };
  }

  const sfc = GetLayerByPres(Sound, 'SFC');
  const eff = Info.EffInflow;
  const effBottom = eff ? GetLayerByPres(Sound, eff.Bot) : null;
  const effTop = eff ? GetLayerByPres(Sound, eff.Top) : null;
  const pick = (k) => {
    if (!inset || !(k in inset) || inset[k] === '--') return null;
    const v = inset[k];
    if (typeof v === 'string') {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    return Number.isFinite(v) ? v : null;
  };

  const motionOut = {};
  for (const key of MOTIONS) motionOut[key] = polarMotion(motions[key]);

  return {
    title: sounding.Title ? String(sounding.Title).trim() : '',
    surface: {
      pressure: round(sfc.P, 1),
      height: round(sfc.H, 0),
      temperature: round(sfc.T, 1),
      dewpoint: round(sfc.D, 1),
      windDirection: round(sfc.WD, 0),
      windSpeed: round(sfc.WS, 0),
    },
    parcels: {
      SB: summarizeParcel(Info.SBParcel),
      ML: summarizeParcel(Info.MLParcel),
      MU: summarizeParcel(Info.MUParcel),
      ...(parcelKey === 'CU' ? { CU: summarizeParcel(DP) } : {}),
    },
    downdraft: {
      dcape: round(Info.DCapeProf && Info.DCapeProf.DCape, 0),
      downdraftTempF: round(Info.DCapeProf && Info.DCapeProf.DownT, 0),
    },
    stormMotion: { used: polarMotion(CSMot), ...motionOut },
    effectiveInflow: eff
      ? {
          bottomPressure: round(eff.Bot, 1),
          topPressure: round(eff.Top, 1),
          bottomHeightAgl: round(effBottom.H - sfc.H, 0),
          topHeightAgl: round(effTop.H - sfc.H, 0),
          srh: srhTotal(Wnd.ESRH),
          /** shear across the inflow layer (the chart's "Eff Inflow" row) */
          bulkShear: polar(Wnd.BWDE),
          /** effective bulk wind difference: inflow base to half the parcel EL height */
          ebwd: polar(Wnd.EBWD),
          meanWind: polar(Wnd.MeanWind.ME),
          stormRelativeWind: Wnd.MeanWind.ME && typeof Wnd.MeanWind.ME === 'object'
            ? polar({ x: Wnd.MeanWind.ME.x - CSMot.x, y: Wnd.MeanWind.ME.y + CSMot.y })
            : null,
          ehi: round(Wnd.EHIE, 1),
        }
      : null,
    kinematics: { layers },
    indices: {
      stpFixed: pick('STP (fixed)'),
      stpEffective: pick('STP (cin)'),
      scp: pick('Supercell Comp'),
      ship: pick('SHIP'),
      sigSevere: pick('SigSvr'),
      wndg: pick('WNDG'),
      derecho: pick('Derecho Comp'),
      pwat: pick('PWAT'),
      kIndex: pick('K Index'),
      totalTotals: pick('TT Index'),
      freezingLevel: pick('Freezing Level'),
      meanMixingRatio: pick('Mean Mix Rat'),
      convectiveTempF: pick('ConvT'),
      maxTempF: pick('MaxT'),
      lclTempF: pick('LCL Temp'),
      theta3kmDiff: pick('3km Theta Diff'),
      rhSurface: pick('Sfc RelH'),
      rhLow: pick('Low RelH'),
      rhMid: pick('Mid RelH'),
      rhDgzMean: pick('Avg DGZ RH'),
    },
    /** Raw engine structures, for anything the summary above leaves out. */
    raw: { Info, WindParams: Wnd, inset, motions, sounding },
  };
}

/** Interpolated level at a pressure (mb) or height (m AGL with { agl: true }). */
export function levelAt(input, { pressure, height, agl = true } = {}) {
  const Sound = toSounding(input).Sounding;
  let lvl;
  if (pressure != null) lvl = GetLayerByPres(Sound, Number(pressure));
  else if (height != null) {
    // GetLayerByHght measures from the first level unless told the height is already MSL.
    lvl = GetLayerByHght(Sound, Number(height), agl);
  } else throw new Error('SharpJS: levelAt needs pressure or height');
  return {
    pressure: round(lvl.P, 1),
    height: round(lvl.H, 0),
    temperature: round(lvl.T, 2),
    dewpoint: round(lvl.D, 2),
    windDirection: round(lvl.WD, 0),
    windSpeed: round(lvl.WS, 1),
    wetbulb: round(lvl.WB, 2),
    virtualTemperature: round(lvl.VT, 2),
  };
}
