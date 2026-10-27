/**
 * Sounding diagnostics without drawing: parcels, downdraft CAPE, effective inflow layer and the
 * kinematic parameters (SRH, bulk shear, mean wind, EHI) for every layer the chart shows.
 * The chart engine and analyze() both use these, so they always agree.
 */
import {
  LiftParcel, GetDCape, EffInflowCalc, GetLayerByPres, GetLayerByHght, GetLayerByTemp,
  GetSRH, GetParams, WindShearFindP, ConvertPolartoCart, GetSWV,
} from './skewtCalcs.js';

/**
 * Surface-based, mixed-layer (lowest 100 mb) and most-unstable parcels, DCAPE and the effective
 * inflow layer. The storm motion used for ECAPE comes from UpdateCSMotStorm().
 * @param {object} Sound  sounding.Sounding
 */
export function computeThermo(Sound) {
  const SBParcel = LiftParcel(Sound, "SB");
  const MLParcel = LiftParcel(Sound, "ML");
  const MUParcel = LiftParcel(Sound, "MU", 767);
  const DCapeProf = GetDCape(Sound);
  const StartSlice = GetLayerByPres(Sound, "SFC");
  let EffInflow = false;
  if (SBParcel.Path != false) {
    EffInflow = EffInflowCalc(Sound, StartSlice);
  }
  return { DCapeProf, EffInflow, SBParcel, MLParcel, MUParcel };
}

/**
 * Wind parameters keyed the way the chart panels read them, e.g.
 *   SRH01 / BWD01 / EHI01 / MeanWind.M01   (0-1 km AGL)
 *   SRHEb03 …                               (0-3 km above the effective inflow base)
 *   ESRH, EBWD, BWDE, EHIE, LCLELSHR, BRM
 *
 * @param {object} Sounding  full sounding object ({ Sounding: {...} })
 * @param {object} Info      result of computeThermo()
 * @param {object|null} DP   the displayed parcel (SB/ML/MU/custom)
 * @param {{x:number,y:number}} CSMot  storm motion (chart convention: y points south)
 * @param {object} [WindParams]  object to fill (the engine reuses one); a new one by default
 */
export function computeWindParams(Sounding, Info, DP, CSMot, WindParams = { MeanWind: {} }) {
  let Sound = Sounding.Sounding;
  if (!WindParams.MeanWind) WindParams.MeanWind = {};
  if (!WindParams.SWV) WindParams.SWV = {};

  let ESRH = 0;
  let E_SWP = 0;
  let E_SWV = 0;
  let E_CWV = 0;
  let EffInfBot =GetLayerByPres(Sound, 'SFC');
  if (Info.EffInflow != false) {
    let swvdat = GetSWV(Sound, Info.EffInflow.Bot, Info.EffInflow.Top, "Pres", { x: CSMot.x, y: -CSMot.y });
    E_SWP = swvdat.SWPercent;
    E_SWV = swvdat.SWV/swvdat.LevelHght;
    E_CWV = swvdat.CWV/swvdat.LevelHght;
    ESRH = GetSRH(Sound, Info.EffInflow.Bot, Info.EffInflow.Top, "Pres");
    ESRH = ESRH.SRHP + ESRH.SRHM;
    EffInfBot = GetLayerByPres(Sound, Info.EffInflow.Bot);
  }

  const Surfaces = {
    'SFC': GetLayerByHght(Sound, "SFC"),
    '500': GetLayerByHght(Sound, 500, true),
    '1000': GetLayerByHght(Sound, 1000, true),
    '3000': GetLayerByHght(Sound, 3000, true),
    '6000': GetLayerByHght(Sound, 6000, true),

    'EbSFC': GetLayerByHght(Sound, EffInfBot.H, false),
    'Eb500': GetLayerByHght(Sound, EffInfBot.H + 500, false),
    'Eb1000': GetLayerByHght(Sound, EffInfBot.H + 1000, false),
    'Eb3000': GetLayerByHght(Sound, EffInfBot.H + 3000, false),
    'Eb6000': GetLayerByHght(Sound, EffInfBot.H + 6000, false),

    '9000': GetLayerByHght(Sound, 9000, true),
    '12000': GetLayerByHght(Sound, 12000, true),
    'SBLCL': GetLayerByHght(Sound, Info.SBParcel.LCL == -9999 ? 1500 : Info.SBParcel.LCL, true),
    'MLLFC': GetLayerByHght(Sound, Info.MLParcel.LFC == -9999 ? 1500 : Info.MLParcel.LFC, true),
    '500mb': GetLayerByPres(Sound, 500),
    '700mb': GetLayerByPres(Sound, 700),
    '300mb': GetLayerByPres(Sound, 300),
    'T-18': GetLayerByTemp(Sound, -18),
    'T-12': GetLayerByTemp(Sound, -12),
    'T-10': GetLayerByTemp(Sound, -10),
    'T-30': GetLayerByTemp(Sound, -30),
  }
  WindParams['ESRH'] = ESRH;
  WindParams['SWV']['ECWV'] = -E_CWV;
  WindParams['SWV']['ESWV'] = -E_SWV;
  WindParams['SWV']['ESWVPercent'] = E_SWP;

  if (Info.EffInflow != false) {
    WindParams['EHIE'] = GetParams({ DP: DP !== null ? DP : Info.SBParcel, SRHAmn: (ESRH) }, "EHI");
    WindParams['BWDE'] = WindShearFindP(Sound, Info.EffInflow.Bot, Info.EffInflow.Top)
    WindParams['MeanWind']['ME'] = WindShearFindP(Sound, Info.EffInflow.Bot, Info.EffInflow.Top, true)
  } else {
    WindParams['EHIE'] = "--";
    WindParams['BWDE'] = "--";
    WindParams['MeanWind']['ME'] = "--";
  }

  let ELVal = DP !== null ? DP.EL : Info.SBParcel.EL;
  let LCLVal = DP !== null ? DP.LCL : Info.SBParcel.LCL;

  if (Info.EffInflow != false) {
    let EBWD = {}
    if (ELVal == -9999 || ELVal == false){
      WindParams['EBWD'] = "--";
    } else {
      let LCLSHR = ConvertPolartoCart(GetLayerByPres(Sound, Info.EffInflow.Bot));
      let ELSHR = ConvertPolartoCart(GetLayerByHght(Sound, (GetLayerByPres(Sound, Info.EffInflow.Bot).H + ELVal)/2, true));
      let P = {
        x: -(LCLSHR.x - ELSHR.x),
        y: -(LCLSHR.y - ELSHR.y),
      };
      WindParams['EBWD'] = P;
    }
  } else {
    WindParams['EBWD'] = "--";
  }

  if (ELVal == -9999 || ELVal == false){
    WindParams['LCLELSHR'] = "--";
  } else {
    let LCLSHR = ConvertPolartoCart(GetLayerByHght(Sound, LCLVal, true));
    let ELSHR = ConvertPolartoCart(GetLayerByHght(Sound, ELVal, true));
    let P = {
      x: -(LCLSHR.x - ELSHR.x),
      y: -(LCLSHR.y - ELSHR.y),
    };
    WindParams['LCLELSHR'] = P;
  }

  // Wind Params
  for (const x of [
    ['005', 'SFC', "500"],
    ['01', 'SFC', "1000"],
    ['03', 'SFC', "3000"],
    ['06', 'SFC', "6000"],

    ['Eb005', 'EbSFC', "Eb500"],
    ['Eb01', 'EbSFC', "Eb1000"],
    ['Eb03', 'EbSFC', "Eb3000"],
    ['Eb06', 'EbSFC', "Eb6000"],

    ['0MLLFC', 'SFC', 'MLLFC'],
    ['0SBLCL', 'SFC', 'SBLCL'],
    ['13', "1000", "3000"],
    ['36', "3000", "6000"],
    ['09', 'SFC', "9000"],
    ['012', 'SFC', "12000"],
    ['912', "9000", "12000"],

    ['0mb300', 'SFC', '300mb'],
    ['0mb500', 'SFC', '500mb'],
    ['0mb700', 'SFC', '700mb'],

    ['DGZ', 'T-12', 'T-18'],
    ['0T18', 'SFC', 'T-18'],
    ['HGZ', 'T-10', 'T-30'],
  ]) {
    if (Surfaces[x[1]].isAbove == true || Surfaces[x[2]].isAbove == true){
      WindParams[`SRH${x[0]}`] = GetSRH(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P, "Pres", CSMot);
      WindParams[`BWD${x[0]}`] = WindShearFindP(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P);
      WindParams[`EHI${x[0]}`] = GetParams({ DP: DP !== null ? DP : Info.SBParcel, SRHAmn: (WindParams[`SRH${x[0]}`].SRHP + WindParams[`SRH${x[0]}`].SRHM) }, "EHI")
      WindParams['MeanWind'][`M${x[0]}`] = WindShearFindP(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P, true);
      let dataswv = GetSWV(Sound, Surfaces[x[1]].H, Surfaces[x[2]].H, "Hght", { x: CSMot.x, y: -CSMot.y });
      WindParams['SWV'][`SWV${x[0]}`] = dataswv.SWV/dataswv.LevelHght;
      WindParams['SWV'][`CWV${x[0]}`] = dataswv.CWV/dataswv.LevelHght;
      WindParams['SWV'][`SWPercent${x[0]}`] = dataswv.SWPercent; // Need to change to acculumation
    } else {
      WindParams[`SRH${x[0]}`] = GetSRH(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P, "Pres", CSMot);
      WindParams[`BWD${x[0]}`] = WindShearFindP(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P);
      WindParams[`EHI${x[0]}`] = GetParams({ DP: DP !== null ? DP : Info.SBParcel, SRHAmn: (WindParams[`SRH${x[0]}`].SRHP + WindParams[`SRH${x[0]}`].SRHM) }, "EHI")
      WindParams['MeanWind'][`M${x[0]}`] = WindShearFindP(Sound, Surfaces[x[1]].P, Surfaces[x[2]].P, true);
      let dataswv = GetSWV(Sound, Surfaces[x[1]].H, Surfaces[x[2]].H, "Hght", { x: CSMot.x, y: -CSMot.y });
      WindParams['SWV'][`SWV${x[0]}`] = dataswv.SWV/dataswv.LevelHght;
      WindParams['SWV'][`CWV${x[0]}`] = dataswv.CWV/dataswv.LevelHght;
      WindParams['SWV'][`SWPercent${x[0]}`] = dataswv.SWPercent; // Need to change to acculumation
    }
  }

  WindParams['BRM'] = CSMot;

  return WindParams;
}
