import { calc_ecape_ncape, calc_sr_wind, linear_interp, spechum_from_dwp, rev_linear_interp } from './ecapeCalc.js';
import { ecape_parcel, density_temperature } from './ecape.js';
const globalFont = '"IBM Plex Sans", "Segoe UI", Roboto, Arial, sans-serif';

function ln(x) {
  return Math.log(x) / Math.log(Math.E);
}

export function DewFromTRh(T, Rh) {
  let N = (ln(Rh / 100) + ((17.27 * T) / (237.3 + T))) / 17.27;
  return (237.7 * N) / (1 - N);
}

export function Mag(N) {
  return Math.sqrt(Math.pow(N.x, 2) + Math.pow(N.y, 2));
}

export function GetAngleFromVector(B) {
  return Math.atan2(-B.x, -B.y) * (180 / Math.PI);
}

export function M2TOKTS(N) {
  return N / 0.514444444;
}

function QCCheck(N) {
  return (N != -9999 && !isNaN(N))
}


export function VirtTemp(Slice, SP, Thing = false, Conv = false) {
  if (Thing) {
    let w = 0;
    if (Slice[3] != -9999) {
      w = 0.001 * mixratio(SP, Slice[3]);
    }
    let tk = Slice[2] + ZEROCNK;
    let vt = (tk * (1 + (w / eps)) / (1 + w) - ZEROCNK);
    if (Conv) {
      return Math.max(vt, Slice[2]);
    } else {
      return Math.max(vt, Slice[2]);
    }
  } else {
    let w = 0;
    if (Slice.D != -9999) {
      w = 0.001 * mixratio(SP, Slice.D);
    }
    let tk = Slice.T + ZEROCNK;
    let vt = (tk * (1 + (w / eps)) / (1 + w)) - ZEROCNK;
    if (Conv) {
      return Math.max(vt, Slice.T);
    } else {
      return Math.max(vt, Slice.T);
    }
  }
}

export function ConvertToInfo(N, SP, isAbove=false) {
  return {
    P: N[0],
    H: N[1],
    T: N[2],
    D: N[3],
    VT: VirtTemp(N, SP, true, true),
    WD: N[4],
    WS: N[5],
    WB: N[6],
    OM: N[7],
    isAbove: isAbove,
  }
}

function GetLerpFactor(a, b, g) {
  return (1 - (g - b) / (a - b));
}

export function degtoRad(degrees) {
  return degrees * (Math.PI / 180);
}

function PolarToCartesianDeg(Spd, Tta) {
  return { x: Spd * Math.cos(degtoRad(Tta)), y: Spd * Math.sin(degtoRad(Tta)) };
}

function RadToDeg(rad) {
  return rad * (180 / Math.PI);
}

function CartesianToPolarDeg(T) {
  return { r: Math.sqrt(Math.pow(T.x, 2) + Math.pow(T.y, 2)), theta: RadToDeg(Math.atan2(T.y, T.x)) };
}

export function Lerp(a, b, t) {
  return a + (b - a) * t;
}

export function GetLayerByHght(Sounding, Level, addTo = true) {
  if (Level == "SFC") {
    let P = Sounding.Slice[0];
    if (QCCheck(P[0]) && QCCheck(P[1]) && QCCheck(P[2]) && QCCheck(P[3]) && QCCheck(P[4]) && QCCheck(P[5]) && QCCheck(P[6])) {
      return ConvertToInfo(Sounding.Slice[0], Sounding.Slice[0][0]);
    } else {
      return ConvertToInfo(Sounding.Slice[1], Sounding.Slice[1][0]);
    }
  }

  let FirstLvl = Math.min(Sounding.Slice.length - 1, 1);

  if (addTo) {
    Level += Sounding.Slice[0][1];
  }

  if (Level > Sounding.Slice[Sounding.Slice.length - 1][1]){
    if (Sounding.Slice.length == 1){
      return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[0][0], true);
    } else {
      let P = Sounding.Slice[0];
      if (QCCheck(P[0]) && QCCheck(P[1]) && QCCheck(P[2]) && QCCheck(P[3]) && QCCheck(P[4]) && QCCheck(P[5]) && QCCheck(P[6])) {
        return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[0][0], true);
      } else {
        return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[1][0], true);
      }
    }
  }

  for (let i = 0; i < Sounding.Slice.length; i++) {
    if (Sounding.Slice[i + 1] == undefined) {
      return false;
    }
    if (Sounding.Slice[i][1] == Level) {
      return ConvertToInfo(Sounding.Slice[i], Sounding.Slice[FirstLvl][0]);
    } else if (Sounding.Slice[i][1] < Level && Sounding.Slice[i + 1][1] > Level) {
      let Slice = {};
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][1], Sounding.Slice[i + 1][1], Level);
      //// console.log(LerpFactor, Sounding.Slice[i][1], Sounding.Slice[i+1][1]);
      let Rr = Sounding.Slice[i + 1];
      let Pr = Sounding.Slice[i];

      for (let x = 0; x < Sounding.Slice[i].length; x++) {
        if (x == 4 || x == 5) {
          if (x == 5) {
            continue;
          }

          let Cartesian = PolarToCartesianDeg(Pr[5], Pr[4]);
          let Cartesian2 = PolarToCartesianDeg(Rr[5], Rr[4]);

          let TrueCart = {
            x: Lerp(Cartesian.x, Cartesian2.x, LerpFactor),
            y: Lerp(Cartesian.y, Cartesian2.y, LerpFactor),
          };

          let TruePolarInterp = CartesianToPolarDeg(TrueCart);

          if (TruePolarInterp.theta < 0) {
            TruePolarInterp.theta = (TruePolarInterp.theta + 360) % 360;
          }

          Slice[4] = TruePolarInterp.theta;
          Slice[5] = TruePolarInterp.r;
        } else {
          Slice[x] = Lerp(Sounding.Slice[i][x], Sounding.Slice[i + 1][x], LerpFactor);
        }
      }

      return ConvertToInfo(Slice, Sounding.Slice[FirstLvl][0]);
    }
  }
}

export function ConvertPolartoCart(Slice) {
  // // console.log(Slice);
  return {
    x: Slice.WS * Math.cos(degtoRad((Slice.WD + 90) % 360)),
    y: Slice.WS * Math.sin(degtoRad((Slice.WD + 90) % 360))
  }
}


export function GetLayerByPres(Sounding, Level, Type = "All") {
  if (Level == "SFC") {
    let P = Sounding.Slice[0];
    if (QCCheck(P[0]) && QCCheck(P[1]) && QCCheck(P[2]) && QCCheck(P[3]) && QCCheck(P[4]) && QCCheck(P[5]) && QCCheck(P[6])) {
      return ConvertToInfo(Sounding.Slice[0], Sounding.Slice[0][0], Type);
    } else {
      return ConvertToInfo(Sounding.Slice[1], Sounding.Slice[1][0], Type);
    }
  }

  if (Level == "Last") {
    if (Sounding.Slice.length == 1){
      return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[0][0]);
    } else {
      let P = Sounding.Slice[0];
      if (QCCheck(P[0]) && QCCheck(P[1]) && QCCheck(P[2]) && QCCheck(P[3]) && QCCheck(P[4]) && QCCheck(P[5]) && QCCheck(P[6])) {
        return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[0][0]);
      } else {
        return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[1][0]);
      }
    }
  }

  let FirstLvl = Math.min(Sounding.Slice.length-1, 1);

  // Optimization: If the specific level exists in P array
  let IndexOf = Sounding.P.indexOf(Level)
  if (IndexOf > -1) {
    return ConvertToInfo(Sounding.Slice[IndexOf], Sounding.Slice[FirstLvl][0], Type);
  }

  

  // Optimization: Scan loop logic improvement
  // Assuming Sounding.Slice is sorted Descending Pressure (standard).
  for (let i = 0; i < Sounding.Slice.length - 1; i++) {
    // If current is greater and next is smaller, we found the gap.
    if (Sounding.Slice[i][0] > Level && Sounding.Slice[i + 1][0] < Level) {
      let Slice = {};
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][0], Sounding.Slice[i + 1][0], Level);

      let Rr = Sounding.Slice[i + 1];
      let Pr = Sounding.Slice[i];

      for (let x = 0; x < Sounding.Slice[i].length; x++) {
        // Handle Wind Vectors
        if (x == 4 || x == 5) {
          if (x == 5) {
            continue;
          }

          // OPTIMIZATION: If Type is "Thermo" or "ThermoOnly", SKIP vector math.
          // This saves 4 trig calls per interpolation.
          if (Type === "Thermo" || Type === "ThermoOnly") {
            Slice[4] = 0; // Dummy values
            Slice[5] = 0;
            continue;
          }

          let Cartesian = PolarToCartesianDeg(Pr[5], Pr[4]);
          let Cartesian2 = PolarToCartesianDeg(Rr[5], Rr[4]);

          let TrueCart = {
            x: Lerp(Cartesian.x, Cartesian2.x, LerpFactor),
            y: Lerp(Cartesian.y, Cartesian2.y, LerpFactor),
          };

          let TruePolarInterp = CartesianToPolarDeg(TrueCart);

          if (TruePolarInterp.theta < 0) {
            TruePolarInterp.theta = (TruePolarInterp.theta + 360) % 360;
          }

          Slice[4] = TruePolarInterp.theta;
          Slice[5] = TruePolarInterp.r;
        } else {
          Slice[x] = Lerp(Sounding.Slice[i][x], Sounding.Slice[i + 1][x], LerpFactor);
        }
      }

      return ConvertToInfo(Slice, Sounding.Slice[FirstLvl][0], Type);
    }
  }
  // Fallback if out of bounds (shouldn't happen with correct inputs)
  return ConvertToInfo(Sounding.Slice[Sounding.Slice.length - 1], Sounding.Slice[FirstLvl][0], Type, true);
}

export function MeanWindNW(Sounding, PBot, PTop, Inc) {
  let WX = 0;
  let WY = 0;
  let Vals = 0;

  for (let i = PBot; i >= PTop; i -= Inc) {
    let Layer = GetLayerByPres(Sounding, i);
    let Wind = ConvertPolartoCart(Layer);

    Vals += 1;
    WX += Wind.x;
    WY += Wind.y;
  }

  return { x: WX / Vals, y: WY / Vals };
}

export function WindShear(L1, L2) {
  return { x: L2.x - L1.x, y: L2.y - L1.y };
}

export function GetBM(Sounding) {
  let d = M2TOKTS(7.5);

  //let MUPrcl = LiftParcel(Sounding, "MU", 767, false);
  //let StartSlice = GetLayerByPres(Sounding, "SFC");
  //let Eff = EffInflowCalc(Sounding, StartSlice);

  let hght0km = GetLayerByHght(Sounding, "SFC", true);
  let hght500m = GetLayerByHght(Sounding, 500, true);
  let hght15km = GetLayerByHght(Sounding, 1500, true);
  let hght6km = GetLayerByHght(Sounding, 6000, true);

  let Mean6km = MeanWindNW(Sounding, hght0km.P, hght6km.P, 1);
  let Shear6km = WindShear(ConvertPolartoCart(hght0km), ConvertPolartoCart(hght6km));

  let Mean850300 = MeanWind(Sounding, Math.min(850, hght0km.P), 300, 1);
  let Mean015km = MeanWind(Sounding, hght0km.P, hght15km.P, 1);
  let Mean0500m = MeanWind(Sounding, hght0km.P, hght500m.P, 1);

  let RST; let LST;

  /*if (MUPrcl.Cape > 100 && qc(MUPrcl.EL)){
    let BotLyr = GetLayerByPres(Sounding, Eff.Bot);
    let dpth = MUPrcl.EL - BotLyr.H;
    let hTop = BotLyr.H + 0.65 * dpth;
    let pTop = GetLayerByHght(Sounding, hTop, true);
    let MnWind = MeanWind(Sounding, Eff.Bot, pTop.P, 1);
    let WndShr = WindShear(
      ConvertPolartoCart(GetLayerByPres(Sounding, Eff.Bot)),
      ConvertPolartoCart(GetLayerByPres(Sounding, pTop)),
    )


    let srMag = Mag(WndShr);
    let uchg = (d / srMag) * WndShr.y;
    let vchg = (d / srMag) * WndShr.x;

    Mean6km = MnWind;
    RST = {
      x: MnWind.x + uchg,
      y: MnWind.y - vchg,
    }
    LST = {
      x: MnWind.x - uchg,
      y: MnWind.y + vchg,
    }
    /*
  
        ptop = interp.pres(prof, interp.to_msl(prof, htop))
        mnu, mnv = winds.mean_wind(prof, pbot, ptop)
        sru, srv = winds.wind_shear(prof, pbot, ptop)
        srmag = utils.mag(sru, srv)
        uchg = d / srmag * srv
        vchg = d / srmag * sru
        rstu = mnu + uchg
        rstv = mnv - vchg
        lstu = mnu - uchg
        lstv = mnv + vchg
      */
  //} else {
    let SHRU = Shear6km.x;
    let SHRV = Shear6km.y;

    let tmp = d / (Math.sqrt(Math.pow(SHRU, 2) + Math.pow(SHRV, 2)));

    LST = {
      x: Mean6km.x + (tmp * SHRV),
      y: Mean6km.y - (tmp * SHRU),
    };
    RST = {
      x: Mean6km.x - (tmp * SHRV),
      y: Mean6km.y + (tmp * SHRU),
    };
  //}

  let US = {
    x: Mean850300.x - Mean015km.x,
    y: Mean850300.y - Mean015km.y,
  }

  let DS = {
    x: Mean850300.x + US.x,
    y: Mean850300.y + US.y,
  }

  let DTMR = {
    x: (Mean0500m.x + RST.x) / 2,
    y: (Mean0500m.y + RST.y) / 2,
  };

  let DTML = {
    x: (Mean0500m.x + LST.x) / 2,
    y: (Mean0500m.y + LST.y) / 2,
  };

  return { RM: RST, LM: LST, MM: Mean6km, US: US, DS: DS, DTMR: DTMR, DTML: DTML };
}

function mean_theta(Sounding, pb, pt) {
  let Tt = 0;
  let Cout = 0;


  for (let i = pb; pt <= i; i -= 1) {
    let Slice = GetLayerByPres(Sounding, i);

    Tt += theta(Slice.P, Slice.T, 1000);
    Cout += 1;
  }
  Tt /= Cout;

  //Tt /= 2;
  //Tt /= Cout*0.5;
  return Tt;
}

export const ROCP = 0.28571426;
export const RMISSD = -9999;

export function theta(pres, temp, pres2) {
  if (!qc(pres) || !qc(temp)) return RMISSD;

  var temp = temp + 273.15;
  return (temp * Math.pow(pres2 / pres, ROCP)) - 273.15;
}

export function pot_temp(pres, temp, pres2) {
  if (!qc(pres) || !qc(temp)) return RMISSD;

  var temp = temp + 273.15;
  return (temp * Math.pow(pres2 / pres, ROCP)) - 273.15;
}

function mean_mixratio(Sounding, pb, pt) {
  let Cout = 0;
  let Dwpt = 0;
  let Pres = 0;

  for (let i = pb; pt <= i; i -= 1) {
    let Slice = GetLayerByPres(Sounding, i);

    Cout += 1;
    Pres += i;
    Dwpt += Slice.D;
  }

  Dwpt /= 2;
  Pres /= 2;
  Cout /= 2;

  return mixratio(Pres / Cout, Dwpt / Cout);
}

function log10(val) {
  return Math.log(val) / Math.log(10);
}

export function temp_at_mixrat(mr, pres) {
  if (!qc(mr) || !qc(pres)) return RMISSD;

  var c1 = 0.0498646455;
  var c2 = 2.4082965;
  var c3 = 7.07475;
  var c4 = 38.9114;
  var c5 = 0.0915;
  var c6 = 1.2035;

  var x = log10(mr * pres / (622.0 + mr));
  var tmrk = Math.pow(10, c1 * x + c2) - c3 + c4 * Math.pow(Math.pow(10, c5 * x) - c6, 2);
  return tmrk - 273.15;
}

const eps = 0.62197;

export function virtemp(pres, temp, dwpt) {
  if (!qc(dwpt)) return temp;
  if (!qc(temp) || !qc(pres)) return RMISSD;

  var cta = 273.15;
  var tk = temp + cta;
  var w = 0.001 * mixratio(pres, dwpt);
  return (tk * (1.0 + w / eps) / (1.0 + w) - cta);
}

export function CtoK(N) {
  return N + 273.15;
}

export function qc(val) {
  if (val < -998.0 || val > 2.0E+05) return 0;
  return 1;
}

function lcltemp(temp, dwpt) {
  if (!qc(temp) || !qc(dwpt)) return RMISSD;

  var s = temp - dwpt;
  var dlt = s * (1.2185 + 0.001278 * temp + s * (-.00219 + 1.173E-05 *
    s - .0000052 * temp));
  return temp - dlt;
}

function thalvl(thta, temp) {
  if (!qc(temp || !qc(thta))) return RMISSD;

  var temp = temp + 273.15;
  var thta = thta + 273.15;
  return 1000.0 / Math.pow((thta / temp), (1 / ROCP));
}

export function FtoC(N) {
  return (N - 32) * (5 / 9);
}

function drylift(p1, t1, td1) {
  var p2 = -9999;
  var t2 = -9999;

  if (!(!qc(p1) || !qc(t1) || !qc(td1))) {
    t2 = lcltemp(t1, td1);
    p2 = thalvl(theta(p1, t1, 1000), t2);
  }
  return Array(p2, t2);
}

function Wobf(temp) {
  let x = temp - 20.0;

  if (x <= 0.0) {
    var pol = 1.0 + x * (-8.841660499999999E-03 + x * (1.4714143E-04
      + x * (-9.671989000000001E-07 + x * (-3.2607217E-08
        + x * (-3.8598073E-10)))));
    pol = pol * pol;
    return 15.13 / (pol * pol);
  } else {
    var pol = x * (4.9618922E-07 + x * (-6.1059365E-09 +
      x * (3.9401551E-11 + x * (-1.2588129E-13 +
        x * (1.6688280E-16)))));
    pol = 1.0 + x * (3.6182989E-03 + x * (-1.3603273E-05 + pol));
    pol = pol * pol;
    return 29.93 / (pol * pol) + 0.96 * x - 14.8;
  }
}

const ZEROCNK = 273.15;

function satlift(p, thetam, conv = 0.1) {
  if (!qc(p) || !qc(thetam)) return RMISSD;

  if ((Math.abs(p - 1000) - .001) <= 0) return thetam;

  var eor = 999;

  var pwrp, t1, t2, woto, wotm, e1, rate, e2, wot2, woe2;

  while (Math.abs(eor) - conv > 0) {
    if (eor == 999) {
      pwrp = Math.pow(p / 1000, ROCP);
      t1 = (thetam + ZEROCNK) * pwrp - ZEROCNK;
      e1 = Wobf(t1) - Wobf(thetam);
      rate = 1;
    } else {
      rate = (t2 - t1) / (e2 - e1);
      t1 = t2;
      e1 = e2;
    }
    t2 = t1 - (e1 * rate);
    e2 = (t2 + ZEROCNK) / pwrp - ZEROCNK;
    e2 += Wobf(t2) - Wobf(e2) - thetam;
    eor = e2 * rate;
  }
  return t2 - eor;
}


function wetlift(p, t, p2) {
  if (!qc(p) || !qc(t) || !qc(p2)) return RMISSD;
  let thta = theta(p, t, 1000.);
  let thetam = thta - Wobf(thta) + Wobf(t);
  return satlift(p2, thetam);
}

export function thetae(p, t, td) {
  let P = drylift(p, t, td);
  return theta(100, wetlift(P[0], P[1], 100), 1000);
}

function GetDryLapse(l, ST, P, eSlice=false) {
  let r = []
  let lr = 9.8;

  let dl = drylift(ST.P, ST.T, ST.D);
  let plcl = dl[0];
  let tlcl = dl[1];

  let T = virtemp(P[0], P[1], P[1]);

  let LCL_Height = Math.max(RoundTo(1000 * (ST.T - ST.D) / 7.83, 1), 20) + ST.H;

  if (eSlice !== false){
    //Take the interpolated temperature instead
    T = Lerp(T, ST.VT, (eSlice.H - LCL_Height)/(ST.H - LCL_Height));
  }

  for (let i = 0; i < l.length; i++) {
    let v = l[i];
    //r.push(Lerp(T, ST.VT, (v.H - LCL_Height)/(ST.H - LCL_Height)))
    //r.push(drylift(pLCL[0], t, td)[1]);
    r.push(Lerp(ST.VT, T, (i / (l.length - 1))));
    //r.push(Lerp(t, pLCL.t2, 1-((v.P-pLCL.p2)/(p-pLCL.p2))));
  }

  //r.push(T);

  return r;
}


function GetMoistLapse(l, t, td, p) {
  let dl = drylift(p, t, td);
  let plcl = dl[0];
  let tlcl = dl[1];

  let r = [];

  for (let i = 0; i < l.length; i++) {
    //t2 = tlcl
    let t3 = wetlift(plcl, tlcl, l[i].P);
    //let t3 = wetlift(p, t, l[i].P);
    r.push(virtemp(l[i].P, t3, t3));
  }

  return r
}

function RoundTo(N, V) {
  return Math.round(N / V) * V;
}

export function clamp(n, m, a) {
  return Math.max(Math.min(n, a), m);
}

function isEmptyObject(obj) {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj) && Object.keys(obj).length === 0;
}

const GRAVITY = 9.80665;

let CSMot = {};
let Info = {};
let Snding = {};
let currentComparisonSoundings = [];
let DP = {};
let CUPrcl = [];
let Motions = {};
let CUMot = {};
let rStart = {};
let WindParams = {};
let CustomWindLayer = {};
let CustomLapseLayer = {};
let relStart = false;
let FrontActive = false;
let Presets = {
  "WindLapse": "Default",
  "Inset": "Default",
  "Vertical": "Default",
}

export function UpdateCSMotStorm(CSMOT) {
  CSMot = CSMOT;
}

export function UpdatePresets(next) {
  if (next) Presets = next;
}

export function LiftParcel(Sounding, type, start, doEcape = true, FastProfile = null) {
  let ReturnTable = {
    Path: [],
    ECape: {
      Path: [],
      Cape: 0,
    },
    Cape: 0,
    Cape3: 0,
    Cape6: 0,
    NCape: 0,
    HGZCape: 0,
    PreHGZCape: 0,
    DGZCape: 0,
    PreDGZCape: 0,
    CINH: 0,
    LCL: -9999,
    LFC: -9999,
    EL: -9999,
    MPL: -9999,
    Levels: 0,
    Start: null,
  }

  let StartSlice = null;
  let EndSlice = GetLayerByPres(Sounding, "Last");

  // Use FastProfile for StartSlice lookup if available and compatible
  if (type == "SB") {
    StartSlice = GetLayerByPres(Sounding, "SFC");
  } else if (type == "ML") {
    let pbot = GetLayerByPres(Sounding, "SFC").P;
    let ptop = pbot - 100;
    let mtheta = mean_theta(Sounding, pbot, ptop);
    let tmpc = theta(1000., mtheta, pbot);
    let mmr = mean_mixratio(Sounding, pbot, ptop);
    let dwpc = temp_at_mixrat(mmr, pbot);

    StartSlice = GetLayerByPres(Sounding, "SFC");

    StartSlice.P = pbot;
    StartSlice.D = dwpc;
    StartSlice.T = tmpc;
    StartSlice.VT = virtemp(pbot, tmpc, dwpc);
  } else if (type == "MU") {
    let P = 950;
    let TMax = 0;
    let Strt = GetLayerByPres(Sounding, "SFC");

    for (let i = Strt.P; Math.max(Strt.P - 300, EndSlice.P-1) <= i; i -= 1) {
      // Use FastProfile here if available to speed up MU search
      let sce = (FastProfile && FastProfile[i]) ? FastProfile[i] : GetLayerByPres(Sounding, i, "Thermo");
      let TTa = CtoK(thetae(sce.P, sce.T, sce.D));

      if (TMax <= TTa) {
        P = i;
        TMax = TTa;
      }
    }

    StartSlice = GetLayerByPres(Sounding, P);
  } else {
    // For "EFF", we are usually passing an integer 'start'. Use lookup if possible.
    if (FastProfile && Number.isInteger(start) && FastProfile[start]) {
      StartSlice = FastProfile[start];
    } else {
      StartSlice = GetLayerByPres(Sounding, Math.min(GetLayerByPres(Sounding, "SFC").P, start));
    }
  }

  ReturnTable.Start = StartSlice;

  //MU Parcel
  let Lower = [];
  let Upper = [];
  let TSounding = [];
  let levels = 0;

  let P = drylift(StartSlice.P, StartSlice.T, StartSlice.D);

  let Iter = 1;

  // OPTIMIZATION: Main Loop Construction
  for (let i = Math.floor(StartSlice.P); EndSlice.P <= i; i -= Iter) {
    let Slice;

    // FAST LOOKUP O(1)
    if (FastProfile && FastProfile[i]) {
      Slice = FastProfile[i];
    } else {
      Slice = GetLayerByPres(Sounding, i, "Thermo"); // "Thermo" skips wind calc
    }

    TSounding.push(Slice);

    if (Slice.P > StartSlice.P) {
      levels += 1;
    } else {
      if (Slice.P >= Math.round(P[0])) {
        Lower.push(Slice);
      } else {
        Upper.push(Slice);
      }
    }
  }

  //Minor change to change LCL to be calculated with drylift instead of the imperial
  ReturnTable.LCL = Math.max(RoundTo(GetLayerByPres(Sounding, P[0]).H - StartSlice.H, 10), 10);

  if (ReturnTable.LCL > EndSlice.H) {
    let LowerT = GetDryLapse(Lower, StartSlice, P, EndSlice);
    let Rtn = [...LowerT];

    for (let i = 0; i < Rtn.length; i++) {
      ReturnTable.Path[i + levels] = Rtn[i];
    }

    return {
      Path: ReturnTable.Path,
      ECape: {
        Path: false,
        Cape: 0,
      },
      Cape: 0,
      Cape3: 0,
      Cape6: 0,
      NCape: 0,
      HGZCape: 0,
      PreHGZCape: 0,
      DGZCape: 0,
      PreDGZCape: 0,
      CINH: 0,
      LCL: Math.max(RoundTo(GetLayerByPres(Sounding, P[0]).H - StartSlice.H, 10), 10),
      LFC: -9999,
      EL: -9999,
      MPL: -9999,
      Levels: 0,
      Start: StartSlice,
    }
  }

  let EnvTempLCL = P[1];

  let LowerT = GetDryLapse(Lower, StartSlice, P);
  let UpperT = GetMoistLapse(Upper, StartSlice.T, StartSlice.D, StartSlice.P);

  // Performance: Spread operator can be slow on huge arrays, but okay here.
  // Concat is slightly safer for strict optimization but this is fine.
  let Rtn = [...LowerT, ...UpperT];

  for (let i = 0; i < Rtn.length; i++) {
    ReturnTable.Path[i + levels] = Rtn[i];
  }

  let FoundEL = false;

  let pe1 = P[0];
  let pelast = pe1;
  let tp1 = P[1];//virtemp(P[0], P[1], P[1]);//virtemp(StartSlice.P, StartSlice.T, StartSlice.T);
  let lyre = 0;
  let lyrlast = 0;
  let hasNegative = false;

  const pBot = Math.round(P[0]);
  const pTop = EndSlice.P;

  for (let p = pBot; p >= pTop; p -= 1) {
    const tp2 = wetlift(pe1, tp1, p);

    let lyr1 = GetLayerByPres(Sounding, pe1);
    let lyr2 = GetLayerByPres(Sounding, p);
    const te1 = virtemp(lyr1.P, lyr1.T, lyr1.D);//lyr1.VT;
    const h1  = lyr1.H;
    const te2 = virtemp(lyr2.P, lyr2.T, lyr2.D);
    const h2  = lyr2.H;

    const tdef1 = (virtemp(pe1, tp1, tp1) - te1) / CtoK(te1);
    const tdef2 = (virtemp(p,   tp2, tp2) - te2) / CtoK(te2);

    lyrlast = lyre;
    lyre = tdef1 + tdef2

    // LFC Possibility - only trigger after we've seen negative buoyancy
    if (lyre >= 0 && lyrlast <= 0) {
        let tp3 = tp1;
        let pe2 = pe1;
        let pe3 = pelast;
        let lyr3 = GetLayerByPres(Sounding, pe3);

        if (virtemp(lyr3.P, lyr3.T, lyr3.D) < virtemp(pe3, wetlift(pe2, tp3, pe3), wetlift(pe2, tp3, pe3))) {
            ReturnTable.LFC = Math.max(ReturnTable.LCL, Math.round(lyr3.H - StartSlice.H) );
        } else {
            while (
                virtemp(lyr3.P, lyr3.T, lyr3.D) > virtemp(pe3, wetlift(pe2, tp3, pe3), wetlift(pe2, tp3, pe3))
                && pe3 > 0
                && pe3 >= p
            ) {
                pe3 -= 5;
                lyr3 = GetLayerByPres(Sounding, pe3);
            }

            if (pe3 > 0) {
              lyr3 = GetLayerByPres(Sounding, pe3);
              ReturnTable.LFC = Math.max(ReturnTable.LCL, Math.round(lyr3.H - StartSlice.H));
            }
        }
    }

    pelast = pe1;
    pe1    = p;
    tp1    = tp2;
  }

  if (ReturnTable.LFC == -9999 && type == "EFF") {
    return false;
  }

  ReturnTable.EL = -9999;

  let Floor2nd = null;
  let MPLC = 0;

  for (let i = ReturnTable.Path.length - 1; 0 < i; i--) {
    let N = TSounding[i];
    // Safety check just in case TSounding is smaller due to floor/ceil
    if (!N) continue;

    if (ReturnTable.Path[i] >= N.VT && N.H >= (ReturnTable.Start.H + ReturnTable.LFC) && N.H >= (ReturnTable.Start.H + ReturnTable.LCL) && N.P >= 50) {
      let NP = TSounding[i - 1];

      if (NP.T == N.T) {
        ReturnTable.EL = NP.H;
        break;
      }

      let Lrp = Lerp(NP.H, N.H, clamp((ReturnTable.Path[i] - N.VT) / (NP.VT - N.VT), 0, 1));

      ReturnTable.EL = Lrp;
      break;
    }
  }

  for (let i = 0; i < ReturnTable.Path.length - 1; i++) {
    let N = TSounding[i];
    let N2 = TSounding[i + 1];

    // Safety
    if (!N || !N2) continue;

    if (N.H < ReturnTable.EL) {
      if (Floor2nd == null && (N.H >= ReturnTable.LFC)) {
        Floor2nd = N;
      }

      if ((ReturnTable.Path[i] - N.VT) >= 0 && (N.H >= ReturnTable.LFC)) {
        let HPart = (N2.H - N.H);

        if (N2.H > ReturnTable.EL){
          HPart = (ReturnTable.EL - N.H);
          N2 = GetLayerByHght(Sounding, ReturnTable.EL, false);
        }

        if (N.H <= ReturnTable.LFC){
          HPart = (N2.H - ReturnTable.LFC);
          N = GetLayerByHght(Sounding, ReturnTable.LFC, false);
        }
        let NVT = virtemp(N.P, N.T, N.D);
        let N2VT = virtemp(N2.P, N2.T, N2.D);

        let B1 = (ReturnTable.Path[i] - NVT) / CtoK(NVT);
        let B2 = (ReturnTable.Path[i + 1] - N2VT) / CtoK(N2VT);

        let LayerCape = GRAVITY * (((B1 + B2) / 2) * HPart);
        ReturnTable.Cape += LayerCape;

        if (N.H <= 6000) {
          ReturnTable.Cape6 += LayerCape;
        }

        if (N.H <= 3000) {
          ReturnTable.Cape3 += LayerCape;
        }

        if (N.T >= -30 && N.T <= -10) {
          ReturnTable.HGZCape += LayerCape;
        } else if (N.T > -10) {
          ReturnTable.PreHGZCape += LayerCape;
        }

        if (N.T >= -18 && N.T <= -12) {
          ReturnTable.DGZCape += LayerCape;
        } else if (N.T > -12) {
          ReturnTable.PreDGZCape += LayerCape;
        }

      } else if ((ReturnTable.Path[i] - N.VT) < 0 && (N.H < ReturnTable.LFC)) {
        let HPart = (N2.H - N.H);
        let NVT = virtemp(N.P, N.T, N.D);
        let N2VT = virtemp(N2.P, N2.T, N2.D);

        let B1 = (NVT - ReturnTable.Path[i]) / CtoK(NVT);
        let B2 = (N2VT - ReturnTable.Path[i + 1]) / CtoK(N2VT);

        ReturnTable.CINH -= Math.max(GRAVITY * ((B1 + B2) / 2 * HPart), 0);

        // OPTIMIZATION: Early Exit for EffInflow
        // If CINH is already too negative, stop calculating.
        // Effective Inflow criteria usually requires CIN > -250.
        if (type == "EFF" && ReturnTable.CINH < -250) {
          return false;
        }
      }

      // Check moved outside loop for cleaner logic, but kept here for existing flow
      if (type == "EFF" && ReturnTable.Cape >= 100 && ReturnTable.CINH >= -250) {
        return true;
      }

    } else if (N.H >= ReturnTable.EL) {
      let HPart = (N2.H - N.H);

      let B1 = (ReturnTable.Path[i] - N.VT) / CtoK(N.VT);
      let B2 = (ReturnTable.Path[i + 1] - N2.VT) / CtoK(N2.VT);

      MPLC += Math.abs(GRAVITY * ((B1 + B2) / 2 * HPart));

      if (ReturnTable.Cape - MPLC >= 0) {
        ReturnTable.MPL = N.H;
      }

      if (type == "EFF" && ReturnTable.Cape >= 100 && ReturnTable.CINH >= -250) {
        return true;
      } else if (type == "EFF" && ReturnTable.CINH < -250) {
        return false;
      }
    }
  }

  if (ReturnTable.Cape - MPLC >= 0 && ReturnTable.EL != -9999){
    let CapeLeft = ReturnTable.Cape - MPLC;
    let i = ReturnTable.Path.length - 2;

    let N = TSounding[i];
    let N2 = TSounding[i + 1];

    let HPart = (N2.H - N.H);

    let B1 = (ReturnTable.Path[i] - N.VT) / CtoK(N.VT);
    let B2 = (ReturnTable.Path[i + 1] - N2.VT) / CtoK(N2.VT);

    let priorCape = Math.abs(GRAVITY * ((B1 + B2) / 2 * HPart));

    let numb = Math.abs((-2 * GRAVITY + Math.sqrt(Math.pow(2 * GRAVITY, 2) - 4 * (GRAVITY) * (-2 * CapeLeft)))/(2 * GRAVITY));
    ReturnTable.MPL += Math.abs(numb * HPart);
  }

  if (ReturnTable.EL != -9999 && ReturnTable.LFC != -9999) {
    ReturnTable.NCape = (ReturnTable.Cape / (ReturnTable.EL - ReturnTable.LFC)) || 0;

    ReturnTable.NCape = isNaN(ReturnTable.NCape) ? 0 : ReturnTable.NCape;
  }


  if (type != "EFF" && doEcape) {
    //ECape

    if (ReturnTable.EL == EndSlice.H || ReturnTable.EL == -9999 || ReturnTable.MPL <= ReturnTable.EL) {
      ReturnTable.ECape.Cape = "--";
      ReturnTable.ECape.Path = false;
      return ReturnTable;
    }
    var spechum = [];
    var uwind = [];
    var vwind = [];

    for (let i = 0; i < Sounding.DW.length; i++) {
      spechum.push(spechum_from_dwp(Sounding.P[i] * 100, Sounding.DW[i].D + 273.15))

      const Winds = PolarToCartesianDeg(Sounding.W[i].WS, Sounding.W[i].WD)
      uwind.push(Winds.x);
      vwind.push(Winds.y);
    }
    if (isEmptyObject(Motions) && isEmptyObject(CSMot)) {
      let SMS = GetBM(Sounding);
      Motions = SMS;
      Motions.RM.y *= -1;
      Motions.LM.y *= -1;
      Motions.MM.y *= -1;
      Motions.US.y *= -1;
      Motions.DS.y *= -1;
      Motions.DTML.y *= -1;
      Motions.DTMR.y *= -1;
      CUMot = {
        x: 0,
        y: -10,
      };
      CSMot = Motions.RM;
    }
    const Info = {
      LFC: ReturnTable.LFC,
      EL: ReturnTable.EL,
      StormMotion: (CSMot.x == undefined ? Motions.RM : CSMot),
      Cape: ReturnTable.Cape,
      PrclHght: ReturnTable.Start.H,
    }

    var newP = Sounding.P;

    if (Sounding.P[0] > 3000) {
      newP = Sounding.P.map((R) => R / 100);
    }

    //console.log(Sounding.H, newP, Sounding.T, spechum, uwind, vwind,)
    const EPrcl = ecape_parcel(newP, Sounding.H, Sounding.T, Sounding.D, uwind, vwind, true, true, true, Sounding, Info, CSMot, 0, 1000, ReturnTable);

    if (EPrcl) {
      const EntrParcelReal = density_temperature(EPrcl[2], EPrcl[3], EPrcl[4]);

      const ECapeParcelPath = [];
      let ib= 0 ;

      for (let a = Math.round(StartSlice.P); a >= Math.round(EndSlice.P); a--) {
        ib += 1;
        ECapeParcelPath.push(
          (rev_linear_interp(EPrcl[0], EntrParcelReal, a * 100) - 273.15)
        );
        //Glue fix to prevent ecape from being higher then the regular parcel
        // - 2 * (rev_linear_interp(EPrcl[0], EntrParcelReal, a * 100) - 273.15 - ReturnTable.Path[a]));
      }

      var ECapeAddition = 0;

      for (let i = 0; i < ECapeParcelPath.length - 1; i++) {
        let N = TSounding[i];
        let N2 = TSounding[i + 1];

        // Safety
        if (!N || !N2) continue;

        if (N.H < ReturnTable.EL) {
          if (Floor2nd == null && (N.H >= ReturnTable.LFC)) {
            Floor2nd = N;
          }

          if ((ECapeParcelPath[i] - N.VT) >= 0 && (N.H >= ReturnTable.LFC)) {
            let HPart = (N2.H - N.H);

            let B1 = (ECapeParcelPath[i] - N.VT) / CtoK(N.VT);
            let B2 = (ECapeParcelPath[i + 1] - N2.VT) / CtoK(N2.VT);

            let LayerCape = GRAVITY * ((B1 + B2) / 2 * HPart);
            ECapeAddition += LayerCape;
          }
        }
      }

      ReturnTable.ECape.Cape = ECapeAddition;
      ReturnTable.ECape.Path = ECapeParcelPath;
    }
  }


  return ReturnTable;
}


function mean_thetae(Sounding, pb, pt) {
  let Tt = 0;
  let Cout = 0;

  for (let i = pb; pt <= i; i -= 1) {
    let Slice = GetLayerByPres(Sounding, i);

    Tt += thetae(Slice.P, Slice.T, Slice.D);
    Cout += 1;
  }

  Tt /= 2;
  Cout /= 2;

  Tt /= Cout;
  return Tt;
}

export function wetbulb(pres, tmp, dew) {
  let P = drylift(pres, tmp, dew);
  return wetlift(P[0], P[1], pres);
}

export function GetDCape(Sound) {
  let mine = 1000;
  let minp = -999;
  let dCape = 0;

  let StartSlice = GetLayerByPres(Sound, "SFC");

  for (let i = StartSlice.P; (StartSlice.P - 400) <= i; i -= 1) {
    let tta = mean_thetae(Sound, i, i - 50);

    if (tta < mine) {
      minp = i - 50;
      mine = tta;
    }
  }

  let upper = GetLayerByPres(Sound, minp);
  let tp1 = wetbulb(upper.P, upper.T, upper.D);

  let ttrace = [tp1];
  let ptrace = [upper.P];

  let te1 = upper.T;
  let pe1 = upper.P;
  let h1 = upper.H;

  for (let i = upper.P - 1; StartSlice.P > i; i++) {
    let Sc = GetLayerByPres(Sound, i);
    let tp2 = wetlift(pe1, tp1, i);
    let te2 = Sc.T;

    ttrace.push(tp2);
    ptrace.push(i);

    let HPart = Sc.H - h1;

    let tdef = (tp1 - te1) / (CtoK(te1));
    let tdef2 = (tp2 - te2) / (CtoK(te2));

    let ly = ((tdef + tdef2) / 2 * HPart);
    dCape += GRAVITY * ly;

    pe1 = i;
    te1 = te2;
    h1 = Sc.H;
    tp1 = tp2;
  }

  return {
    DCape: dCape,
    DownT: Math.round(CToF(tp1)),
    TempTrace: ttrace,
    StartPres: upper,
    PresTrace: ptrace,
  };
}


export function LapseRateHght(Sounding, hb, ht, type = false) {
  if (!type) {
    let Bot = GetLayerByHght(Sounding, hb);
    let Top = GetLayerByHght(Sounding, ht);

    let N = Math.round(10 * ((Top.VT - Bot.VT) / ((Bot.H - Top.H) * 1 / 1000))) / 10;

    if (N != N) {
      return "--";
    }
    return N;
  } else {
    let N = 0;
    let iter = 0;
    let LastLyr = GetLayerByHght(Sounding, hb);

    for (let i = LastLyr.H; i < ht; i += 50) {
      let NextLyr = GetLayerByHght(Sounding, i + 50)
      N += ((LastLyr.VT - NextLyr.VT) / ((50) * 1 / 1000))
      iter += 1;
      LastLyr = NextLyr;
    }

    return Math.round(10 * (N / iter)) / 10;
  }
}

export function LapseRatePres(Sounding, PBot, PTop, type = false) {
  if (!type) {
    let S = GetLayerByPres(Sounding, "SFC");

    if (S.P < PBot) {
      return "--";
    }

    let Bot = GetLayerByPres(Sounding, PBot);
    let Top = GetLayerByPres(Sounding, PTop);

    return Math.round(10 * (Top.VT - Bot.VT) / ((Bot.H - Top.H) * 1 / 1000)) / 10;
  } else {
    let N = 0;
    let iter = 0;
    let LastLyr = GetLayerByPres(Sounding, PBot);

    for (let i = PBot; i > PTop; i -= 1) {
      let NextLyr = GetLayerByPres(Sounding, i - 1)
      N += ((NextLyr.VT - LastLyr.VT) / ((LastLyr.H - NextLyr.H) * 1 / 1000))
      iter += 1;
      LastLyr = NextLyr;
    }

    return Math.round(10 * (N / iter)) / 10;
  }
}


export function EffInflowCalc(Sounding, sfc) {
  let Bot = 0;
  let Top = 999;
  let isSfc = false;
  let FoundBot = false;

  // OPTIMIZATION: Generate a lookup table for the entire atmosphere once.
  // This prevents recalculating the same math 10,000+ times inside the loops.
  // We use a sparse array where the index equals the pressure.
  let FastProfile = [];
  let StartP = Math.ceil(sfc.P);
  let EndSlice = GetLayerByPres(Sounding, "Last");
  let EndP = Math.floor(EndSlice.P);

  // Pre-calculate every integer pressure level needed for the lifts
  for (let p = StartP; p >= EndP; p--) {
    // We only need Thermo data (T/Td) for lifting, "Thermo" type usually skips vector wind math
    FastProfile[p] = GetLayerByPres(Sounding, p, "Thermo");
  }

  // Pass FastProfile as the 5th argument to LiftParcel
  for (let i = sfc.P; 500 <= i; i -= 5) {
    let N = LiftParcel(Sounding, "EFF", i, false, FastProfile);

    if (N == true && !FoundBot) {
      if (i == sfc.P) {
        isSfc = true;
      }
      Bot = i;
      Top = i;
      FoundBot = true;
      break;
    }
  }
  if (Bot == 0) {
    return false;
  }

  for (let i = Bot - 5; 500 <= i; i -= 5) {
    let N = LiftParcel(Sounding, "EFF", i, false, FastProfile);

    if (N == true && Bot != 0) {
      Top = i;
    } else {
      Top -= 5;
      break;
    }
  }

  if (Top == 999) {
    return false;
  }
  return { Bot, Top, isSfc };
}

function WindShearAvg(L1, L2) {
  return { x: (L2.x + L1.x) / 2, y: (L2.y + L1.y) / 2 };
}

export function WindShearFindP(Sounding, L1, L2, modify = false) {
  let Lower = GetLayerByPres(Sounding, L1);
  let Higher = GetLayerByPres(Sounding, L2);
  const Top = GetLayerByPres(Sounding, "Last");

  if (L2 < Top.P){
    return {x: NaN, y:NaN}
  }

  if (modify) {
    return WindShearAvg(ConvertPolartoCart(Lower), ConvertPolartoCart(Higher))
  }

  return WindShear(ConvertPolartoCart(Lower), ConvertPolartoCart(Higher));
}

function KTSTOM2(N) {
  return N * 0.514444444;
}

export function GetSRH(Sounding, Hbot, Htop, type, RMot = false) {
  let SRHP = 0;
  let SRHM = 0;

  let BM = 0;
  if (RMot) {
    BM = RMot;
  } else {
    BM = CSMot;
  }

  const Top = GetLayerByPres(Sounding, "Last");

  //BM.y = BM.y;

  if (type == "Pres") {
    if (Htop < Top.P){
      return {SRHM: NaN, SRHP: NaN}
    }
    for (let i = Hbot; i >= Htop; i--) {
      if (i <= Top.P){
        break;
      };
      if (i - 1 <= Htop && i > Htop) {
        i = Htop;
      }
      let Sect1 = ConvertPolartoCart(GetLayerByPres(Sounding, i, "Wind"));
      let Sect2 = ConvertPolartoCart(GetLayerByPres(Sounding, i - 1, "Wind"));
      Sect1.y = -Sect1.y;
      Sect2.y = -Sect2.y;

      let u1 = KTSTOM2(Sect1.y - BM.y);
      let v1 = KTSTOM2(Sect1.x - BM.x);

      let u2 = KTSTOM2(Sect2.y - BM.y);
      let v2 = KTSTOM2(Sect2.x - BM.x);

      let H = (u1 * v2) - (u2 * v1);

      if (H > 0) {
        SRHP += H;
      } else {
        SRHM += H;
      }
    }
  } else if (type == "Hght") {
    const SH = GetLayerByHght(Sounding, "SFC");
    if (Htop > Top.H){
      return {SRHM: NaN, SRHP: NaN}
    }

    for (let ir = Hbot; ir < Htop; ir += 10) {
      if (ir >= Top.H){
        break;
      };
      if (ir + 10 >= Htop && ir < Htop) {
        ir = Htop;
      }
      let Sect1 = ConvertPolartoCart(GetLayerByHght(Sounding, ir));
      let Sect2 = ConvertPolartoCart(GetLayerByHght(Sounding, ir + 10));
      Sect1.y = -Sect1.y;
      Sect2.y = -Sect2.y;

      let u1 = KTSTOM2(Sect1.y - BM.y);
      let v1 = KTSTOM2(Sect1.x - BM.x);

      let u2 = KTSTOM2(Sect2.y - BM.y);
      let v2 = KTSTOM2(Sect2.x - BM.x);

      let H = (u1 * v2) - (u2 * v1);

      if (H > 0) {
        SRHP += H;
      } else {
        SRHM += H;
      }
    }
  }

  return { SRHP, SRHM };
}

export function WindShearFind(Sounding, L1, L2, modify = false) {
  let Lower = GetLayerByHght(Sounding, L1);
  let Higher = GetLayerByHght(Sounding, L2);
  const Top = GetLayerByPres(Sounding, "Last");

  if (L2 > Top.H){
    return {x: NaN, y:NaN}
  }

  if (modify) {
    return WindShearAvg(ConvertPolartoCart(Lower), ConvertPolartoCart(Higher))
  }

  return WindShear(ConvertPolartoCart(Lower), ConvertPolartoCart(Higher));
}


export function GetLayerByTemp(Sounding, Level, wetbulb = false) {
  if (Level == "SFC") {
    let P = Sounding.Slice[0];
    if (QCCheck(P[0]) && QCCheck(P[1]) && QCCheck(P[2]) && QCCheck(P[3]) && QCCheck(P[4]) && QCCheck(P[5]) && QCCheck(P[6])) {
      return ConvertToInfo(Sounding.Slice[0], Sounding.Slice[0][0]);
    } else {
      return ConvertToInfo(Sounding.Slice[1], Sounding.Slice[1][0]);
    }
  }

  let Iter = 2;

  if (wetbulb) {
    Iter = 6;
  }

  let FirstLvl = Math.min(Sounding.Slice.length-1, 1);

  for (let i = 0; i < Sounding.Slice.length - 1; i++) {
    if (Sounding.Slice[i][Iter] == Level) {
      return ConvertToInfo(Sounding.Slice[i], Sounding.Slice[FirstLvl][0]);
    } else if ((Sounding.Slice[i][Iter] > Level && Sounding.Slice[i + 1][Iter] < Level) ||
      (Sounding.Slice[i][Iter] < Level && Sounding.Slice[i + 1][Iter] > Level)) {
      let Slice = {};
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][Iter], Sounding.Slice[i + 1][Iter], Level);
      //// console.log(LerpFactor, Sounding.Slice[i][1], Sounding.Slice[i+1][1]);

      let Rr = Sounding.Slice[i + 1];
      let Pr = Sounding.Slice[i];

      for (let x = 0; x < Sounding.Slice[i].length; x++) {
        if (x == 4 || x == 5) {
          if (x == 5) {
            continue;
          }

          let Cartesian = PolarToCartesianDeg(Pr[5], Pr[4]);
          let Cartesian2 = PolarToCartesianDeg(Rr[5], Rr[4]);

          let TrueCart = {
            x: Lerp(Cartesian.x, Cartesian2.x, LerpFactor),
            y: Lerp(Cartesian.y, Cartesian2.y, LerpFactor),
          };

          let TruePolarInterp = CartesianToPolarDeg(TrueCart);

          if (TruePolarInterp.theta < 0) {
            TruePolarInterp.theta = (TruePolarInterp.theta + 360) % 360;
          }

          Slice[4] = TruePolarInterp.theta;
          Slice[5] = TruePolarInterp.r;
        } else {
          Slice[x] = Lerp(Sounding.Slice[i][x], Sounding.Slice[i + 1][x], LerpFactor);
        }
      }

      return ConvertToInfo(Slice, Sounding.Slice[FirstLvl][0]);
    }
  }

  return ConvertToInfo(Sounding.Slice[Sounding.Slice.length-1], Sounding.Slice[FirstLvl][0], true);
}


export function MeanWind(Sounding, PBot, PTop, Inc) {
  let TWeight = 0;
  let WX = 0;
  let WY = 0;
  let Values = [];

  for (let i = PBot; i > PTop; i -= Inc) {
    let Layer = GetLayerByPres(Sounding, i);
    let Wind = ConvertPolartoCart(Layer);

    TWeight += i;
    WX += Wind.x * i;
    WY += Wind.y * i;
  }

  return { x: WX / TWeight, y: WY / TWeight };
}

export function VaporPressure(temp) {
  if (!qc(temp)) return RMISSD;
  // Polynomial approximation for Vapor Pressure
  var pol = temp * (1.1112018E-17 + temp * (-3.0994571E-20));
  pol = temp * (2.1874425E-13 + temp * (-1.789232E-15 + pol));
  pol = temp * (4.3884180E-09 + temp * (-2.988388E-11 + pol));
  pol = temp * (7.8736169E-05 + temp * (-6.111796E-07 + pol));
  pol = 0.99999683E-00 + temp * (-9.082695E-03 + pol);
  pol = pol * pol;
  pol = pol * pol;
  return 6.1078 / (pol * pol);
}

function ConvertCartToPolarReal(V1) {
  const dy = V1.y - 0;
  const dx = V1.x - 0;
  const radians = Math.atan2(dy, dx); // Angle in radians
  const degrees = radians * 180 / Math.PI; // Convert to degrees
  return { WD: Math.round((degrees + 270) % 360), WS: Mag(V1) };
}

function getAngleDifference(angle1, angle2) {
    let diff = (angle1 - angle2 + 180) % 360 - 180;
    return diff < -180 ? diff + 360 : diff;
}

export function mixratio(pres, temp) {
  if (!qc(pres) || !qc(temp)) return RMISSD;
  // Calculate mixing ratio given Pressure (mb) and Temp/Dewpoint (C)
  // Note: logic follows legacy script.js approximation
  var x = 0.02 * (temp - 12.5 + 7500.0 / pres);
  var wfw = 1.0 + 0.0000045 * pres + 0.0014 * x * x;
  var fwesw = wfw * VaporPressure(temp);
  return 621.97 * (fwesw / (pres - fwesw));
}

function KTStoMPH(k){
  return k * 1.15078;
}

function MPHtoKTS(k){
  return k/1.15078;
}

export function calculatePWAT(pressures, dewpoints) {
  if (!pressures || !dewpoints || pressures.length !== dewpoints.length) return null;

  let pwat = 0;

  // Iterate through layers
  for (let i = 0; i < pressures.length - 1; i++) {
    const p1 = pressures[i];
    const p2 = pressures[i + 1];
    const d1 = dewpoints[i];
    const d2 = dewpoints[i + 1];

    // Stop if we go too high (e.g., < 400mb) or invalid data
    if (p2 < 400 || !qc(p1) || !qc(p2) || !qc(d1) || !qc(d2)) continue;

    const mr1 = mixratio(p1, d1);
    const mr2 = mixratio(p2, d2);

    if (mr1 !== RMISSD && mr2 !== RMISSD) {
      // Layer average mixing ratio * pressure thickness * constant
      // Using absolute difference for pressure to handle sort order
      pwat += ((mr1 + mr2) / 2) * Math.abs(p1 - p2) * 0.00040173;
    }
  }

  return parseFloat(pwat.toFixed(2));
}

export function GetParams(Info, Type, STPF = false) {
  if (Type == "SCP") {
    let scp = 0;

    let EBWD = Info.Wnd.EBWD == "--" ? 0 : KTSTOM2(Mag(Info.Wnd.EBWD));

    if (EBWD > 20) {
      EBWD = 20;
    } else if (EBWD < 10) {
      EBWD = 0;
    }

    let mucapeT = Info.Parcels.MU.Cape / 1000;
    let esrhT = Info.Wnd.ESRH / 50;
    let ebwdT = EBWD / 20;

    return Math.round(10 * mucapeT * esrhT * ebwdT) / 10;
  } else if (Type == "STPF") {
    let sblcl = Info.Parcels.SB.LCL;

    if (sblcl < 1000) {
      sblcl = 1;
    } else if (sblcl > 2000) {
      sblcl = 0;
    } else {
      sblcl = (2000 - sblcl) / 1000;
    }

    let bwd = KTSTOM2(Mag(Info.Wnd.BWD06));

    if (bwd > 30) {
      bwd = 1.5;
    } else if (bwd < 12.5) {
      bwd = 0;
    } else {
      bwd /= 20;
    }

    let cape = Info.Parcels.SB.Cape / 1500;
    let srh = (Info.Wnd.SRH01.SRHP + Info.Wnd.SRH01.SRHM) / 150;

    return Math.round(10 * (cape * srh * bwd * sblcl)) / 10;
  } else if (Type == "STPC") {
    let cape = Info.Parcels.ML.Cape / 1500;
    let srh = Info.Wnd.ESRH / 150;

    let ebwd = Info.Wnd.EBWD == "--" ? 0 : KTSTOM2(Mag(Info.Wnd.EBWD));

    if (ebwd < 12.5) {
      ebwd = 0;
    } else if (ebwd > 30) {
      ebwd = 1.5;
    } else {
      ebwd = ebwd / 20;
    }

    let mllcl = Info.Parcels.ML.LCL;

    if (mllcl < 1000) {
      mllcl = 1;
    } else if (mllcl > 2000) {
      mllcl = 0;
    } else {
      mllcl = (2000 - mllcl) / 1000;
    }

    let mlcin = Info.Parcels.ML.CINH;

    if (mlcin > -50) {
      mlcin = 1;
    } else if (mlcin < -200) {
      mlcin = 0;
    } else {
      mlcin = (mlcin + 200) / 150;
    }

    return Math.round(10 * (cape * srh * ebwd * mllcl * mlcin)) / 10;
  } else if (Type == "VTPC") {
    let cape = Info.Parcels.ML.Cape / 1700;
    let srh = Info.Wnd.ESRH / 250;

    let ebwd = Info.Wnd.EBWD == "--" ? 0 : KTSTOM2(Mag(Info.Wnd.EBWD));

    if (ebwd < 20) {
      ebwd = 0;
    } else if (ebwd > 45) {
      ebwd = 1.5;
    } else {
      ebwd = ebwd / 30;
    }

    let mllcl = Info.Parcels.ML.LCL;

    if (mllcl < 750) {
      mllcl = 1;
    } else if (mllcl > 1750) {
      mllcl = 0;
    } else {
      mllcl = (1750 - mllcl) / 750;
    }

    let mlcin = Info.Parcels.ML.CINH;

    if (mlcin > -50) {
      mlcin = 1;
    } else if (mlcin < -200) {
      mlcin = 0;
    } else {
      mlcin = (mlcin + 200) / 150;
    }

    let cape3 = Info.Parcels.ML.Cape3;

    if (cape3 > 100){
      cape3 = 2;
    } else {
      cape3 = clamp(cape3/50, 0, 2);
    }

    let L700 = GetLayerByPres(Info.Sounding.Sounding, 700)
    let L500 = GetLayerByPres(Info.Sounding.Sounding, 500)

    let MLLR = 1000 * (L700.VT - L500.VT)/(L500.H - L700.H);

    if (MLLR > 8.5){
      MLLR = 2;
    } else {
      MLLR = clamp((MLLR-4.5)/2, 0, 2);
    }

    return Math.round(10 * (cape * srh * ebwd * mllcl * mlcin * cape3 * MLLR)) / 10;
  } else if (Type == "SHIP") {
    let Mucape = Info.Parcels.MU.Cape;
    let PrclStart = Info.Parcels.MU.Start;
    if (PrclStart == undefined){
      return 0;
    }
    let LR = LapseRatePres(Info.Sounding.Sounding, 700, 500, false);
    let BWD = clamp(KTSTOM2(Mag(Info.Wnd.BWD06)), 7, 27);
    let MR = clamp(mixratio(PrclStart.P, PrclStart.D), 11, 13.6);
    let tmp500 = -Math.min(-5.5, GetLayerByPres(Info.Sounding.Sounding, 500).T);
    let Ship = (Mucape * LR * tmp500 * MR * BWD) / 42000000;

    if (Mucape < 1300) {
      Ship *= (Mucape / 1300);
    }

    if (LR < 5.8) {
      Ship *= (LR / 5.8);
    }

    let FZL = GetLayerByTemp(Info.Sounding.Sounding, 0);


    if (FZL.H < 2400) {
      Ship *= (FZL.H / 2400)
    }

    return Math.round(10 * Ship) / 10;
  } else if (Type == "WNDG") {
    let lr03 = LapseRateHght(Info.Sounding.Sounding, "SFC", 3000, false);

    if (lr03 < 7) {
      lr03 = 0;
    }

    let mlcin = Info.Parcels.ML.CINH;

    if (mlcin < -50) {
      mlcin = -50;
    }

    let cape = Info.Parcels.ML.Cape;
    // console.log("A");
    let PB = GetLayerByHght(Info.Sounding.Sounding, 1000).P;
    let PT = GetLayerByHght(Info.Sounding.Sounding, 3500).P;
    let meanW = MeanWind(Info.Sounding.Sounding, PB, PT);

    meanW = Math.sqrt(Math.pow(meanW.x, 2) + Math.pow(meanW.y, 2));

    return Math.round(10 * (lr03 / 9) * (50 + mlcin) / 40 * cape / 2000 * meanW / 15) / 10;
  } else if (Type == "PWAT") {
    let snd = Info.Sounding.Sounding;
    return calculatePWAT(snd.P, snd.D);
  } else if (Type == "DerechoComp") {
    let PB = GetLayerByHght(Info.Sounding.Sounding, "SFC").P;
    let PT = GetLayerByHght(Info.Sounding.Sounding, 6000).P;
    let Shear06 = Mag(WindShearFindP(Info.Sounding.Sounding, PB, PT));
    let MeanW = MeanWind(Info.Sounding.Sounding, PB, PT);
    let meanW = Math.sqrt(Math.pow(MeanW.x, 2) + Math.pow(MeanW.y, 2));

    return Math.round(10 * (Info.TProf.DCapeProf.DCape / 980) * (Info.Parcels.MU.Cape / 2000) * (Shear06 / 20) * (meanW / 16)) / 10;
  } else if (Type == "EHI") {
    let cape = Info.DP.Cape;

    return Math.round(10 * (cape * (Info.SRHAmn)) / 160000) / 10;
  } else if (Type == "SigSvr") {
    return Math.round(Info.Parcels.ML.Cape * KTSTOM2(Mag(Info.Wnd.BWD06)));
  } else if (Type == "ttadiff") {
    let PB = GetLayerByHght(Info.Sounding.Sounding, "SFC");
    let PT = GetLayerByHght(Info.Sounding.Sounding, 3000);
    let fTta = thetae(PB.P, PB.T, PB.D);
    let lTta = thetae(PT.P, PT.T, PT.D);

    return Math.round(fTta - lTta);
  } else if (Type == "KI") {
    let mb500 = GetLayerByPres(Info.Sounding.Sounding, 500);
    let mb700 = GetLayerByPres(Info.Sounding.Sounding, 700);
    let mb850 = 0;
    let SfcL = GetLayerByPres(Info.Sounding.Sounding, "SFC");

    if (SfcL.P <= 850) {
      mb850 = SfcL;
    } else {
      mb850 = GetLayerByPres(Info.Sounding.Sounding, 850)
    }

    return (mb850.T - mb500.T) + mb850.D - (mb700.T - mb700.D);
  } else if (Type == "TT") {
    let mb500 = GetLayerByPres(Info.Sounding.Sounding, 500);
    let mb850 = 0;
    let SfcL = GetLayerByPres(Info.Sounding.Sounding, "SFC");

    if (SfcL.P <= 850) {
      mb850 = SfcL;
    } else {
      mb850 = GetLayerByPres(Info.Sounding.Sounding, 850)
    }

    return (mb850.T - mb500.T) + (mb850.D - mb500.T);
  } else if (Type == "HDWI") {
    let Mv = 0;

    for (let i = 0; i < 500; i += 250) {
      let Upr = GetLayerByHght(Info.Sounding.Sounding, i);
      Mv += (VaporPressure(Upr.T) - VaporPressure(Upr.D)) * Mag(ConvertPolartoCart(Upr));
    }

    return Math.round(100 * Math.round(Mv)/3)/100;
  } else if (Type == "BRN") {
    let SFC = GetLayerByHght(Info.Sounding.Sounding, "SFC");
    let s5 = GetLayerByHght(Info.Sounding.Sounding, 500);
    let s6 = GetLayerByHght(Info.Sounding.Sounding, 6000);
    let Meanin6km = MeanWind(Info.Sounding.Sounding, SFC.P, s6.P, 1);
    let Meanin500m = MeanWindNW(Info.Sounding.Sounding, SFC.P, s5.P, 1);

    const du = Meanin6km.x - Meanin500m.x;
    const dv = Meanin6km.y - Meanin500m.y;

    // Magnitude of shear vector
    const U = Math.sqrt(du * du + dv * dv);

    if (U === 0) return 0;
    return Info.Parcels.ML.Cape / (0.5 * U * U);
  } else if (Type == "Rot") {
    let M = 0;

    for (let i = 250; i < 3000; i += 250) {
      let Lwr = GetLayerByHght(Info.Sounding.Sounding, i - 250);
      let Upr = GetLayerByHght(Info.Sounding.Sounding, i);
      M += ((Lwr.WD - Upr.WD) + 540) % 360 - 180;
    }

    return Math.abs(Math.round(M / 3));
  } else if (Type == "DewDP1km") {
    let M = 9999999;

    for (let i = 0; i < 1000; i += 100) {
      let Upr = GetLayerByHght(Info.Sounding.Sounding, i);
      M = Math.min(M, Upr.T - Upr.D)
    }

    return Math.round(10 * M) / 10;
  } else if (Type == "LCLRH") {
    let sfc = GetLayerByHght(Info.Sounding.Sounding, "SFC");
    let LCL = GetLayerByHght(Info.Sounding.Sounding, Info.Parcels.SB.LCL || 1000);

    return Math.round(mean_rh_in_layer(Info.Sounding.Sounding, sfc.P, LCL.P));
  } else if (Type == "RFTI") {
    let sfc = GetLayerByHght(Info.Sounding.Sounding, "SFC");

    return Math.round(100 * (Mag(ConvertPolartoCart(sfc)) * 2.23694) / RelHum(sfc.T, sfc.D)) / 100;
  } else if (Type == "Fosberg") {
    let sfc = GetLayerByHght(Info.Sounding.Sounding, "SFC");
    let temp = CToF(sfc.T);
    let rh = RelHum(sfc.T, sfc.D);
    let windSpeed = Mag(ConvertPolartoCart(sfc)) * 2.23694;
    let m = 0;

    if (rh < 10) {
      m = 0.03229 + (0.281073 * rh) - (0.000578 * rh * temp);
    } else if (rh <= 50) {
      m = 2.22749 + (0.160107 * rh) - (0.01478 * temp);
    } else {
      m = 21.0606 + (0.005565 * Math.pow(rh, 2)) - (0.00035 * rh * temp) - (0.483199 * rh);
    }

    const m30 = m / 30;
    const eta = 1 - (2 * m30) + (1.5 * Math.pow(m30, 2)) - (0.5 * Math.pow(m30, 3));
    const result = (eta * Math.sqrt(1 + Math.pow(windSpeed, 2))) / 0.3002;

    return Math.round(Math.min(100, Math.max(0, result)));
  } else if (Type == "MaxT") {
    let SfcL = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let Upr = GetLayerByPres(Info.Sounding.Sounding, SfcL.P - 150);

    if (Info.Parcels.SB.Path == false || Info.Parcels.SB.Path.length < 150) {
      return "--"
    } else {
      let P = Info.Parcels.SB.Path[150] || -9999;
      return Math.round(CToF(P + 9.81 * (Upr.H - SfcL.H) / 1000));
    }
  } else if (Type == "TEHI") {
    let cape = Info.Parcels.ML.Cape;
    let cape3 = Info.Parcels.ML.Cape3;
    let mlcin = Info.Parcels.ML.CINH;
    let sbcin = Info.Parcels.SB.CINH;
    let srh = (Info.Wnd.SRH01.SRHP + Info.Wnd.SRH01.SRHM);

    if (mlcin < -100 || sbcin < -200 || Info.Parcels.ML.LCL > 1700) {
      return 0;
    }

    let ebwd = KTSTOM2(Mag(Info.Wnd.BWD06));

    if (ebwd < 12.5) {
      ebwd = 0;
    } else if (ebwd > 30) {
      ebwd = 1.5;
    } else {
      ebwd = ebwd / 20;
    }

    if (cape > 1500) {
      cape3 = Math.min(200, cape3);
    } else {
      cape3 = Math.min(300, cape3);
    }

    return clamp(((srh * cape) / 160000) * (cape3 / 200) * ebwd, 0, 1000);
  } else if (Type == "TTS") {
    let cape = Info.Parcels.ML.Cape;
    let cape3 = clamp(Info.Parcels.ML.Cape3, 0, 150);
    let mlcin = Info.Parcels.ML.CINH;
    let sbcin = Info.Parcels.SB.CINH;
    let srh = (Info.Wnd.SRH01.SRHP + Info.Wnd.SRH01.SRHM);

    if (mlcin < -100 || sbcin < -200 || Info.Parcels.ML.LCL > 1700) {
      return 0;
    }

    let ebwd = KTSTOM2(Mag(Info.Wnd.BWD06));

    if (ebwd < 12.5) {
      ebwd = 0;
    } else if (ebwd > 30) {
      ebwd = 1.5;
    } else {
      ebwd = ebwd / 20;
    }

    if (cape < 2000) {
      cape = 1
    } else {
      cape = clamp(cape / 2000, 1, 1.5);
    }

    return clamp(((srh * cape3) / 6500) * cape * ebwd, 0, 1000);
  } else if (Type == "MaxWB") {
    let Max = -999;
    let ST = GetLayerByPres(Info.Sounding.Sounding, "SFC");

    for (let i = ST.P; i > ST.P - 400; i -= 2) {
      Max = Math.max(Max, GetLayerByPres(Info.Sounding.Sounding, i).WB);
    }
    return Math.round(Max);
  } else if (Type == "SnowSquall") {
    let SL = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let TL = GetLayerByHght(Info.Sounding.Sounding, 2000);
    let RH = mean_rh_in_layer(Info.Sounding.Sounding, SL.P, TL.P);
    let Delta_T = thetae(SL.P, SL.T, RelHum(SL.T, SL.D)) - thetae(TL.P, TL.T, RelHum(TL.T, TL.D))
    let MW = Mag(MeanWind(Info.Sounding.Sounding, SL.P, TL.P));
    if (RH < 60) {
      RH = 0;
    } else {
      RH = (RH - 60) / 15;
    }
    Delta_T = (4 - Delta_T) / 4
    MW = MW / 9
    return Math.round(10 * RH * Delta_T * MW) / 10;
  } else if (Type == "ConvT") {
    let ST = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let StartTemp = ST.D;
    let FoundStart = false;
    let CCLTemp = 0;

    for (let i = ST.P - 1; i >= 500; i--) {
      let Slice = GetLayerByPres(Info.Sounding.Sounding, i);

      StartTemp = temp_at_mixrat(ST.D, i);

      if (StartTemp >= Slice.VT) {
        CCLTemp = Slice;
        FoundStart = true;
        break;
      }
    }

    let CT = (CCLTemp.VT + CCLTemp.H / 1000 * 9.81);

    if (!FoundStart || CT != CT) {
      return "--";
    }

    return Math.round(CToF(CT));
  } else if (Type == "LHP") {
    if (Info.Parcels.MU.Cape < 400 || KTSTOM2(Mag(Info.Wnd.BWD06)) < 14 || Info.Parcels.MU.EL == -9999){
      return 0;
    }

    let T10 = GetLayerByTemp(Info.Sounding.Sounding, -10);
    let T30 = GetLayerByTemp(Info.Sounding.Sounding, -30);
    let HGZDepth = Math.abs(T10.H - T30.H);

    let HGZTerm = (3200 - HGZDepth)/500;
    let LRTerm = (LapseRatePres(Info.Sounding.Sounding, 700, 500) - 6.5)/2;
    let mucapeTerm = (Info.Parcels.MU.Cape-2000)/1000;


    let ElVal = GetLayerByHght(Info.Sounding.Sounding, Info.Parcels.MU.EL);
    let LowerELVal = GetLayerByHght(Info.Sounding.Sounding, Info.Parcels.MU.EL - 1500);
    let MeanWind_EL = MeanWind(Info.Sounding.Sounding, LowerELVal.P, ElVal.P);
    let SFCWindLyr = ConvertPolartoCart(GetLayerByPres(Info.Sounding.Sounding, "SFC"));

    let ShearEL = KTSTOM2(Mag({
      x: MeanWind_EL.x - SFCWindLyr.x,
      y: MeanWind_EL.y - SFCWindLyr.y,
    }));

    let Shear_EL = (ShearEL - 25)/5;
    
    let GRW_dirEL = getAngleDifference(
      ConvertCartToPolarReal(MeanWind_EL).WD, 
      ConvertCartToPolarReal(MeanWind(Info.Sounding.Sounding, GetLayerByHght(Info.Sounding.Sounding, 3000).P, GetLayerByHght(Info.Sounding.Sounding, 6000).P)).WD
    );
    let GRW_EL = (GRW_dirEL + 5)/20;

    let SRWindHigher = ConvertCartToPolarReal({
      x: Info.Wnd.MeanWind.M36.x - Info.Wnd.BRM.x,
      y: Info.Wnd.MeanWind.M36.y + Info.Wnd.BRM.y,
    })

    let SRWindLower = ConvertCartToPolarReal({
      x: Info.Wnd.MeanWind.M01.x - Info.Wnd.BRM.x,
      y: Info.Wnd.MeanWind.M01.y + Info.Wnd.BRM.y,
    })

    let SRW_dirmid = (getAngleDifference(
      SRWindHigher.WD,
      SRWindLower.WD
    ) - 80)/10;
    
    let TermB = Shear_EL + GRW_EL + SRW_dirmid;
    let TermA = HGZTerm + LRTerm + mucapeTerm;

    return Math.round(((TermA * TermB) + 5));
  } else if (Type == "RFP"){
    let LCLP = GetLayerByHght(Info.Sounding.Sounding, Info.Parcels.SB.LCL);
    return LCLP.D + 2 * (Info.Parcels.SB.LCL/1000);
  } else if (Type == "FSI"){
    let SFC = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let mb850 = GetLayerByPres(Info.Sounding.Sounding, 850);
    return 4 * SFC.T - 2 * (mb850.T + SFC.D) + mb850.WS;
  } else if (Type == "FTV"){
    let SFC = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let mb850 = GetLayerByPres(Info.Sounding.Sounding, 850);

    let ttaE = thetae(850, mb850.T, mb850.D)
    let x = ttaE / 273.15
    let x2 = x * x
    let x3 = x2 * x
    let x4 = x2 * x2
    let a = 7.101574 - 20.68208 * x + 16.11182 * x2 + 2.574631 * x3 - 5.205688 * x4
    let b = 1 - 3.552497 * x + 3.781782 * x2 - 0.6899655 * x3 - 0.5929340 * x4

    let theta_w = ttaE - Math.exp(a / b)
    let true850WGBPT = ttaE <= 173.15 ? ttaE : theta_w;

    let LCLP = GetLayerByHght(Info.Sounding.Sounding, Info.Parcels.SB.LCL);
    return true850WGBPT - (LCLP.D + 2 * (Info.Parcels.SB.LCL/1000));
  } else if (Type == "FeelsLike"){
    let SFC = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    let SfcT_F = CToF(SFC.T);
    if (SfcT_F <= 50 && KTStoMPH(SFC.WS) > 3){
      const wc =
        35.74 +
        0.6215 * SfcT_F -
        35.75 * Math.pow(KTStoMPH(SFC.WS), 0.16) +
        0.4275 * SfcT_F * Math.pow(KTStoMPH(SFC.WS), 0.16);

      return Math.round(wc);
    } else if (SfcT_F >= 80 && RelHum(SFC.T, SFC.D) >= 40){
      let Sfc_RH = RelHum(SFC.T, SFC.D);
      let hi = 0;

      if (SfcT_F < 80 || Sfc_RH < 40) {
        hi = 0.5 * (SfcT_F + 61.0 + (SfcT_F - 68.0) * 1.2 + Sfc_RH * 0.094);
      } else {
        // Full Rothfusz regression equation
        hi =
          -42.379 +
          2.04901523  * SfcT_F +
          10.14333127  * Sfc_RH -
          0.22475541  * SfcT_F * Sfc_RH -
          0.00683783  * SfcT_F * SfcT_F -
          0.05481717  * Sfc_RH * Sfc_RH +
          0.00122874  * SfcT_F * SfcT_F * Sfc_RH +
          0.00085282  * SfcT_F * Sfc_RH * Sfc_RH -
          0.00000199  * SfcT_F * SfcT_F * Sfc_RH * Sfc_RH;

        // Rothfusz adjustment 1: low RH at high temp
        if (Sfc_RH < 13 && SfcT_F >= 80 && SfcT_F <= 112) {
          const adj = ((13 - Sfc_RH) / 4) * Math.sqrt((17 - Math.abs(SfcT_F - 95)) / 17);
          hi -= adj;
        }

        // Rothfusz adjustment 2: high RH at lower temps
        if (Sfc_RH > 85 && SfcT_F >= 80 && SfcT_F <= 87) {
          const adj = ((Sfc_RH - 85) / 10) * ((87 - SfcT_F) / 5);
          hi += adj;
        }
      }

      return Math.round(hi);
    } else {
      return Math.round(CToF(SFC.T));
    }
  } else if (Type == "WBGT"){
    let SFC = GetLayerByPres(Info.Sounding.Sounding, "SFC");
    // Saturation vapor pressure (hPa) using Magnus formula
    const es = 6.112 * Math.exp((17.67 * SFC.T) / (SFC.T + 243.5));
    const e  = (RelHum(SFC.T, SFC.D) / 100) * es; // Actual vapor pressure

    const wbgt_C = 0.567 * SFC.T + 0.393 * e + 3.94;
    const wbgt_F = CToF(wbgt_C);
    return wbgt_F;
  }
}

function CreateInsetParams(TitleText, otherText, fillStyle, coloumn, mColoumn, Scaley, MScaleY, Canv, ctx) {
  ctx.font = `normal 600 ${Canv.width / 55}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "left";
  ctx.fillText(TitleText, (0.01 + (coloumn - 1) / mColoumn) * Canv.width, Canv.height * Scaley / MScaleY);

  ctx.font = `${Canv.width / 55}px ${globalFont}`;
  ctx.fillStyle = fillStyle;
  ctx.textAlign = "right";
  ctx.fillText(otherText, (coloumn / mColoumn - 0.01) * Canv.width, Canv.height * Scaley / MScaleY);

  return Scaley + 1;
}

export function RelHum(tmp, dew) {
  return 100 * VaporPressure(dew) / VaporPressure(tmp);//(E/ES)*100;
}

export function mean_rh_in_layer(Sounding, pbot, ptop) {
  let totalRH = 0;
  let count = 0;

  // Ensure pbot is the higher pressure (lower altitude)
  if (pbot < ptop) {
    [pbot, ptop] = [ptop, pbot]; // Swap them
  }

  // Iterate by small pressure steps (e.g., 1mb) for accuracy using interpolation
  for (let p = pbot; p >= ptop; p--) {
    let layer = GetLayerByPres(Sounding, p);

    if (layer && layer.T !== -9999 && layer.D !== -9999) {
      let rh = RelHum(layer.T, layer.D);
      if (!isNaN(rh)) {
        totalRH += rh;
        count++;
      }
    }
  }

  // Return the average, or NaN if the layer was empty/invalid
  return count > 0 ? totalRH / count : NaN;
}

export function CToF(N) {
  return (N * (9 / 5)) + 32;
}

function MixRatioColor(N) {
  if (N == "--") {
    return "rgba(125,125,125,1)";
  }

  if (N < 6) {
    return "rgba(125,125,125,1)";
  } else if (N >= 6 && N < 8) {
    return "rgba(125,125,0,1)";
  } else if (N >= 8 && N < 10) {
    return "rgba(100, 175, 0, 1)";
  } else if (N >= 10 && N < 12) {
    return "rgba(50, 200, 50, 1)";
  } else if (N >= 12 && N < 14) {
    return "rgba(75,255,75,1)";
  } else if (N >= 14 && N < 17) {
    return "rgba(255,255,55,1)";
  } else if (N >= 17 && N < 20) {
    return "rgba(255,125,0,1)";
  } else {
    return "rgba(255,255,255,1)";
  }
}

function GetSTPColor(N) {
  if (N <= 1) {
    return "rgba(125,125,125,1)";
  } else if (N <= 2 && N > 1) {
    return "rgba(255,255,255,1)";
  } else if (N <= 3 && N > 2) {
    return "rgba(255,255,0,1)";
   } else if (N <= 5 && N > 3) {
    return "rgb(255, 149, 0)";
  } else if (N <= 8 && N > 5) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(255,0,255,1)";
  }
}

function GetSCPColor(N) {
  if (N <= 5) {
    return "rgba(125,125,125,1)";
  } else if (N <= 8 && N > 5) {
    return "rgba(255,255,255,1)";
  } else if (N <= 15 && N > 8) {
    return "rgba(255,255,0,1)";
  } else if (N <= 25 && N > 15) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(255,0,255,1)";
  }
}


export function GetCapeColor(N) {
  // Add check for non-numeric values
  if (N === "--" || N === undefined || N === null || isNaN(N)) {
    return "rgba(255,255,255,1)";
  }

  if (N <= 2000) {
    return "rgba(255,255,255,1)";
  } else if (N <= 3000 && N > 2000) {
    return "rgba(255,255,0,1)";
  } else if (N <= 4000 && N > 3000) {
    return "rgb(255, 123, 0)";
  } else if (N <= 5000 && N > 4000) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(255,0,255,1)";
  }
}

export function DrawInsetParams(Sounding, Wnd, TProf, SB, ML, MU, retrn = false, f = false, canvas = null) {
  let Parcels = { SB, ML, MU };
  let Scalex = 0;
  let Scaley = 0.8;
  let MScaleY = 6;

  if (f) {
    Presets = f;
  }

  let Coloumns = 4;

  let Sfc = GetLayerByPres(Sounding.Sounding, "SFC");
  let Low = GetLayerByHght(Sounding.Sounding, 1000);
  let Mid = GetLayerByHght(Sounding.Sounding, 3000);

  let D = drylift(Sfc.P, Sfc.T, Sfc.D);

  const dgzTop = GetLayerByTemp(Sounding.Sounding, -18);
  const dgzBottom = GetLayerByTemp(Sounding.Sounding, -12);
  let avgDGZ_RH = "--";

  if (dgzTop && dgzBottom) {
    const avgRH = mean_rh_in_layer(Sounding.Sounding, dgzTop.P, dgzBottom.P);
    if (!isNaN(avgRH)) {
      avgDGZ_RH = `${Math.round(avgRH)}%`;
    }
  }

  let DCape = TProf.DCapeProf.DCape;

  let SCP = GetParams({ Wnd, Parcels }, "SCP");
  SCP = isNaN(SCP) ? "--" : SCP;
  let STPF = GetParams({ Wnd, Parcels }, "STPF");
  STPF = isNaN(STPF) ? "--" : STPF;
  let STPC = GetParams({ Wnd, Parcels }, "STPC");
  STPC = isNaN(STPC) ? "--" : STPC;
  let VTPC = GetParams({ Wnd, Parcels, Sounding }, "VTPC");
  VTPC = isNaN(VTPC) ? "--" : VTPC;

  let SHIP = GetParams({ Wnd, Sounding, Parcels }, "SHIP");
  let WNDG = GetParams({ Wnd, Sounding, Parcels }, "WNDG");
  let PWAT = GetParams({ Sounding }, "PWAT");
  let ttadiff = GetParams({ Sounding, Wnd, Parcels }, "ttadiff");
  let MidRH = Math.round(RelHum(Mid.T, Mid.D));
  let FZL = Math.round(GetLayerByTemp(Sounding.Sounding, 0).H || "--");
  let MUMPL = Math.round(MU.MPL);
  let SfcRH = Math.round(RelHum(Sfc.T, Sfc.D));
  let LowRH = Math.round(RelHum(Low.T, Low.D));
  let DerechoComp = GetParams({ Wnd, Sounding, Parcels, TProf }, "DerechoComp");
  let LCLTemp = Math.round(CToF(D[1]));
  let ConvT = GetParams({ Sounding, Parcels }, "ConvT");
  let MaxT = GetParams({ Sounding, Parcels }, "MaxT");
  let TEHI = Math.round(GetParams({ Sounding, Parcels, Wnd }, "TEHI") * 100) / 100;
  let TTS = Math.round(GetParams({ Sounding, Parcels, Wnd }, "TTS") * 100) / 100;
  let MMR = Math.round(100 * mean_mixratio(Sounding.Sounding, Sfc.P, Low.P)) / 100;
  let SigSvr = GetParams({ Parcels, Wnd }, "SigSvr");
  let DownT = TProf.DCapeProf.DownT;
  //Severe
  let BRN = Math.round(GetParams({ Sounding, Parcels }, "BRN"));
  let TTIndex = Math.round(GetParams({ Sounding }, "TT"));
  let KIndex = Math.round(GetParams({ Sounding }, "KI"));
  let LHP = Math.round(GetParams({Sounding, Parcels, Wnd}, "LHP"));
  //Fire
  let HDWI = GetParams({ Sounding }, "HDWI"); //FIX THIS
  let RFTI = GetParams({ Sounding }, "RFTI");
  let Fosberg = GetParams({ Sounding }, "Fosberg");
  let RotP = GetParams({ Sounding }, "Rot");
  let DewDprs = GetParams({ Sounding }, "DewDP1km");
  let LCLRH = GetParams({ Sounding, Parcels }, "LCLRH");

  //Winter
  let MaxWB = GetParams({ Sounding }, "MaxWB");
  let SQ = GetParams({ Sounding }, "SnowSquall");

  //Fog
  let RFP = GetParams({Sounding, Parcels}, "RFP");
  let FSI = GetParams({Sounding, Parcels}, "FSI");
  let FTV = GetParams({Sounding, Parcels}, "FTV");

  //Feels Like:
  let FeelsLike = GetParams({Sounding}, "FeelsLike");
  let WBGT = GetParams({Sounding}, "WBGT");
  let thick1000500 = Math.round(Math.abs(GetLayerByPres(Sounding.Sounding, 1000).H - GetLayerByPres(Sounding.Sounding, 500).H ))/2;

  if (retrn) {
    return {
      "PWAT": PWAT,
      "Mean Mix Rat": MMR,
      "Sfc RelH": SfcRH,
      "Low RelH": LowRH,
      "Mid RelH": MidRH,
      "Avg DGZ RH": avgDGZ_RH,
      "Freezing Level": FZL,
      "MU MPL": MUMPL,
      "3km Theta Diff": ttadiff,
      "LCL Temp": LCLTemp,
      "ConvT": Math.round(ConvT),
      "MaxT": MaxT,
      "K Index": KIndex,
      "TT Index": TTIndex,
      "Supercell Comp": SCP,
      "STP (cin)": STPC,
      "STP (fixed)": STPF,
      "SigSvr": SigSvr,
      "WNDG": WNDG,
      "SHIP": SHIP,
      "Derecho Comp": DerechoComp,
      "DCape": Math.round(DCape),
      "DParcel Pres": Math.round(TProf.DCapeProf.StartPres.P),
      "DownT": Math.round(DownT)
    }
  }

  FZL = isNaN(FZL) ? "--" : FZL;
  ConvT = isNaN(ConvT) ? "--" : Math.round(ConvT)
  MUMPL = MU.MPL === -9999 ? "--" : Math.round(MU.MPL);

  const Canv = canvas || document.getElementById("Values3");
  const ctx = Canv.getContext("2d");

  Canv.width = 975;
  Canv.height = 150;

  let WhiteColorBase = "rgba(255,255,255,1)";

  for (let i = 1; i < 4; i++) {
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fillRect((0.25 * i) * Canv.width, 0.05 * Canv.height, 1, 0.9 * Canv.height);
  }

  Scaley = CreateInsetParams(`PWAT: `, `${PWAT} in`, MixRatioColor(PWAT * 7.5), 1, Coloumns, Scaley, MScaleY, Canv, ctx);
  Scaley = CreateInsetParams(`Mean Mix Rat:`, `${MMR} g/kg`, MixRatioColor(MMR), 1, Coloumns, Scaley, MScaleY, Canv, ctx);
  Scaley = CreateInsetParams(`Sfc RelH:`, `${SfcRH}%`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);
  Scaley = CreateInsetParams(`Low RelH:`, `${LowRH}%`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);
  Scaley = CreateInsetParams(`Mid RelH:`, `${MidRH}%`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);

  if (Presets['Inset'] == "Default") {
    Scaley = CreateInsetParams(`Avg DGZ RH:`, `${avgDGZ_RH}`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`Freezing Level:`, `${FZL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MU MPL:`, `${MUMPL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`3km Theta Diff:`, `${ttadiff}K`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`LCL Temp:`, `${LCLTemp}F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`ConvT:`, `${Math.round(ConvT)} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MaxT:`, `${MaxT} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`TEHI:`, `${TEHI}`, GetSTPColor(TEHI * 1.5), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`TTS:`, `${TTS}`, GetSTPColor(TTS * 1.5), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Supercell Comp:`, `${SCP}`, GetSCPColor(SCP), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`STP (cin):`, `${STPC}`, GetSTPColor(STPC), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`STP (fixed):`, `${STPF}`, GetSTPColor(STPF), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`VTP (mod):`, `${VTPC}`, GetSTPColor(VTPC), 3, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    //Scaley = CreateInsetParams(`DParcel Pres:`, `${Math.round(TProf.DCapeProf.StartPres.P)}mb`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
  } else if (Presets['Inset'] == "Severe") {
    Scaley = CreateInsetParams(`Avg DGZ RH:`, `${avgDGZ_RH}`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`Freezing Level:`, `${FZL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MU MPL:`, `${MUMPL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`3km Theta Diff:`, `${ttadiff}K`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`LCL Temp:`, `${LCLTemp}F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`ConvT:`, `${Math.round(ConvT)} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MaxT:`, `${MaxT} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`K Index:`, `${KIndex}`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`TT Index:`, `${TTIndex}`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Supercell Comp:`, `${SCP}`, GetSCPColor(SCP), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Bulk Rich. Num.:`, `${BRN}`, GetSTPColor(BRN * 3), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`STP (fixed):`, `${STPF}`, GetSTPColor(STPF), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`SigSvr:`, `${SigSvr} m³/s³`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

  } else if (Presets['Inset'] == "Fire") {
    Scaley = CreateInsetParams(`Avg DGZ RH:`, `${avgDGZ_RH}`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`Freezing Level:`, `${FZL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MU MPL:`, `${MUMPL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`3km Theta Diff:`, `${ttadiff}K`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`LCL Temp:`, `${LCLTemp}F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`ConvT:`, `${ConvT} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MaxT:`, `${MaxT} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`HDWI: `, `${HDWI}`, GetCapeColor(HDWI * 50), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`RFTI: `, `${RFTI}`, GetCapeColor(RFTI * 800), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Fosberg:`, `${Fosberg}`, GetSCPColor(Fosberg * 0.75), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`3km °change:`, `${RotP}°`, GetSTPColor(RotP), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`1km Min TD Dep.:`, `${DewDprs}C`, GetSTPColor(DewDprs / 5), 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Sfc-LCL RH:`, `${LCLRH}%`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;
  } else if (Presets['Inset'] == "Winter" || Presets['Inset'] == 'Ambient') {
    let DGOmega = mean_layer_temp(Sounding, -12, -18, "Omega")
    let DGPWAT = mean_layer_temp(Sounding, -12, -18, "PWAT")
    let DGMX = mean_layer_temp(Sounding, -12, -18, "MixRat")
    let LayerDepth = Math.abs(GetLayerByTemp(Sounding.Sounding, -12).H - GetLayerByTemp(Sounding.Sounding, -18).H);

    Scaley = CreateInsetParams(`Snow Sq. Param: `, `${SQ}`, WhiteColorBase, 1, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`Freezing Level:`, `${FZL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MU MPL:`, `${MUMPL}m`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`3km Theta Diff:`, `${ttadiff}K`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`LCL Temp:`, `${LCLTemp}F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`ConvT:`, `${Math.round(ConvT)} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`MaxT:`, `${MaxT} F`, WhiteColorBase, 2, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;

    Scaley = CreateInsetParams(`400mb Max WB:  `, `${MaxWB}C`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DGZ Depth: `, `${Math.round(LayerDepth)}m`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DGZ Omega:`, `${Math.round(100 * DGOmega) / 100}`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DGZ Pwat:`, `${Math.round(100 * DGPWAT) / 100}in`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DGZ Mix. Rat.:`, `${Math.round(100 * DGMX) / 100}g/kg`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Avg DGZ RH:`, `${avgDGZ_RH}`, WhiteColorBase, 3, Coloumns, Scaley, MScaleY, Canv, ctx);

    Scaley = 0.8;
  }

  if (Presets['Inset'] == "Fire" || Presets['Inset'] == "Winter"){
    Scaley = CreateInsetParams(`Feels Like:`, `${Math.round(FeelsLike)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`1k-500mb Dpth:`, `${Math.round(thick1000500)} m`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Wet Bulb Globe Temp: `, `${Math.round(WBGT)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DCape:`, `${Math.round(DCape)} J/kg`, GetCapeColor(DCape * 2), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DParcel Pres:`, `${Math.round(TProf.DCapeProf.StartPres.P)}mb`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DownT:`, `${Math.round(DownT)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
  } else if (Presets['Inset'] == "Severe" || Presets['Inset'] == "Default"){
    Scaley = CreateInsetParams(`SHIP:`, `${SHIP}`, GetSTPColor(SHIP * 2), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`LHP`, `${Math.round(LHP)}`, GetSTPColor(LHP / 3), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`WNDG:`, `${WNDG}`, GetSTPColor(WNDG * 1.1), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Derecho Comp:`, `${DerechoComp}`, GetSTPColor(DerechoComp / 1.75), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DCape:`, `${Math.round(DCape)} J/kg`, GetCapeColor(DCape * 2), 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`DownT:`, `${Math.round(DownT)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
  } else if (Presets['Inset'] == 'Ambient'){
    Scaley = CreateInsetParams(`Feels Like:`, `${Math.round(FeelsLike)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Wet Bulb Globe Temp: `, `${Math.round(WBGT)} F`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Rad. Fog Pt.:`, `${Math.round(RFP)} C`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Fog Threat Val.:`, `${Math.round(100 * FTV)/100} C`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`Fog Stab. Idx:`, `${Math.round(FSI * 100)/100}`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
    Scaley = CreateInsetParams(`1k-500mb Dpth:`, `${Math.round(thick1000500)} m`, WhiteColorBase, 4, Coloumns, Scaley, MScaleY, Canv, ctx);
  }
}

export function mean_layer_temp(Sounding, Temp1, Temp2, Stat) {
  let Snding = Sounding.Sounding;
  let Top = GetLayerByTemp(Snding, Temp1);
  let Bottom = GetLayerByTemp(Snding, Temp2);

  if (Bottom.P > Top.P) {
    Top = GetLayerByTemp(Snding, Temp2);
    Bottom = GetLayerByTemp(Snding, Temp1);
  }

  if (Stat == "Omega") {
    let Omega = 0;
    let Wght = 0;
    for (let x = Top.P; x >= Bottom.P; x -= 1) {
      let P = GetLayerByPres(Snding, x);
      let P2 = GetLayerByPres(Snding, x - 1);

      Omega += ((P.OM + P2.OM) * 0.5);
      Wght += 1;
    }
    return -Omega / Wght;
  } else if (Stat == "RH") {
    let RH = 0;
    let Wght = 0;
    for (let x = Top.P; x >= Bottom.P; x -= 1) {
      let P = GetLayerByPres(Snding, x);
      let P2 = GetLayerByPres(Snding, x - 1);
      RH += ((RelHum(P.T, P.D) + RelHum(P2.T, P2.D)) * 0.5);
      Wght += 1;
    }
    return RH / Wght;
  } else if (Stat == "PWAT") {
    let snd = Sounding.Sounding;
    return calculatePWAT(snd.P, snd.D);
  } else if (Stat == "MixRat") {
    let MMR = 0;
    let Wght = 0;
    for (let x = Top.P; x >= Bottom.P; x -= 1) {
      let P = GetLayerByPres(Snding, x);
      let P2 = GetLayerByPres(Snding, x - 1);
      let MX = mixratio(P.P, P.D);
      let MX2 = mixratio(P2.P, P2.D);
      MMR += ((MX + MX2) * 0.5);
      Wght += 1;
    }
    return MMR / Wght;
  }
}

function relh(p, t, td) {
  return 100 * VaporPressure(td) / VaporPressure(t);
}


export function mean_relh(Sounding, pbot, ptop) {
  let RH = 0;
  let Cout = 0;

  for (let i = pbot; ptop < i; i--) {
    let Slice = GetLayerByPres(Sounding, i);
    let rh = relh(i, Slice.T, Slice.D);

    RH += (rh * i);
    Cout += i;
  }

  return (RH / Cout);
}

export function calculateHeightsAboveGround(pressureLevels, temperatures) {
  const R = 287.05;
  const g = 9.80665;
  const heightsFromTop = [0];
  const heights = [];
  const n = pressureLevels.length;

  for (let i = 1; i < n; i++) {
    const meanTemp = (temperatures[i] + temperatures[i - 1]) / 2;
    const heightDifference =
      ((R * meanTemp) / g) *
      Math.log(pressureLevels[i] / pressureLevels[i - 1]);
    heightsFromTop.push(heightsFromTop[i - 1] + heightDifference);
  }

  const surfaceHeight = heightsFromTop[n - 1];
  for (let i = 0; i < n; i++) {
    heights.push(surfaceHeight - heightsFromTop[i]);
  }

  return heights;
}
