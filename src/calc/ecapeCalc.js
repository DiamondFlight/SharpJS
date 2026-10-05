//First Lets Define Some Constants
export const Constants = {
    sigma: 1.6,
    alpha: 0.8,
    k2: 0.16,
    L_mix: 120,
    Pr: 1/3,
    g: 9.81, //m^2
    c_pd: 1005, //J/(Kg*K)
    c_pv: 1870, //J/(Kg*K)
    c_pl: 4190, //J/(Kg*K)
    c_pi: 2106, //J/(Kg*K)
    R_d: 287.04, //J/(Kg*K)
    R_v: 461.5, //J/(Kg*K)
    L_v_trip: 2501000, //J/kg
    L_i_trip: 333000, //J/kg
    T_trip: 273.15, //K
    phi: 287.04/461.5, //Constants.R_d/Constants.R_v,
    xlv:2501000,// #LATENT HEAT OF VAPORIZATION AT TRIPLE POINT TEMPERATURE
    xls:2834000,// #LATENT HEAT OF SUBLIMATION AT TRIPLE POINT TEMPERATURE

    mgc: 8.314, //molar_gas_constant J/Kelvin/Moles
    amm: 0.029, //avg_molar_mass, Kg/Mole
    dagc: 287, //dry_air_gas_constant
    wvgc: 461.5, //water_vapor_gas_constant
    lhov: 2500000, //latent_heat_of_vaporization
};

//lets define some functions i geuss :3
function clamp(n, m, a){
  return Math.max(Math.min(n, a), m);
}

export function LastItem(arr){
    return arr[arr.length - 1];
}

function qc(val) {
  if (val < -998.0 || val > 2.0E+05) return 0;
  return 1;
}

function vappres(temp) {
  if (!qc(temp)) return -9999;

  var pol = temp * (1.1112018E-17 + temp * (-3.0994571E-20));
  pol = temp * (2.1874425E-13 + temp * (-1.789232E-15 + pol));
  pol = temp * (4.3884180E-09 + temp * (-2.988388E-11 + pol));
  pol = temp * (7.8736169E-05 + temp * (-6.111796E-07 + pol));
  pol = 0.99999683E-00 + temp * (-9.082695E-03 + pol);
  pol = pol * pol;
  pol = pol * pol;
  return 6.1078 / (pol * pol);
}

function mixratio(pres, temp) {
  if (!qc(pres) || !qc(temp)) return -9999;

  var x = 0.02 * (temp - 12.5 + 7500.0 / pres);
  var wfw = 1.0 + 0.0000045 * pres + 0.0014 * x * x;
  var fwesw = wfw * vappres(temp);
  return 621.97 * (fwesw / (pres - fwesw));
}

export function VirtTemp(Slice, SP, Thing = false, Conv = false){
  const ZEROCNK = 273.15;
  if (Thing){
    //let TopValue = Slice[2] + 273.15;
   // let BotValue = (1 - 0.379 * ( ( 6.11 * Math.pow(10, ((7.5 * Slice[3])/(237.7 + Slice[3]))))/Slice[0]));
    let tk = Slice[2] + ZEROCNK;
    let w = 0.001 * mixratio(SP, Slice[3]);
    let vt = (tk * (1 + (w/Constants.eps))/(1+w) -ZEROCNK);
    if (Conv){
      return Math.max(vt,Slice[2]);
      //return (TopValue/BotValue) - 273.15;
    } else {
      return Math.max(vt,Slice[2]);
     // return (TopValue/BotValue);
    }
    
  } else {
    let tk = Slice.T + ZEROCNK;
    let w = 0.001 * mixratio(SP, Slice.D);
    let vt = (tk * (1 + (w/Constants.eps))/(1+w))-ZEROCNK;
  //return (tk * (1.0 + w/eps) / (1.0 + w) - cta);
    if (Conv){
      return Math.max(vt,Slice.T);
      //return (TopValue/BotValue) - 273.15;
    } else {
      return Math.max(vt,Slice.T);
     // return (TopValue/BotValue);
    }
  }
}

function Lerp(a, b, t){
  return a + (b-a)*t;
}

function RadToDeg(rad) {
  return rad * (180 / Math.PI);
}

function DegToRad(deg) {
  return deg * (Math.PI / 180);
}

function GetLerpFactor(a, b, g){
  return (1-(g-b)/(a-b));
}

function QCCheck(N){
  return (N != -9999 && !isNaN(N))
}

export function PolarToCartesianDeg(Spd, Tta){
  return {x: Spd * Math.cos(DegToRad(Tta)), y: Spd * Math.sin(DegToRad(Tta))};
}

export function CartesianToPolarDeg(T){
  return {r: Math.sqrt(Math.pow(T.x, 2) + Math.pow(T.y, 2)), theta: RadToDeg(Math.atan2(T.y, T.x))};
}

/** First sounding row if every field passes QC, else the second row. */
function SurfaceLayerInfo(Sounding){
  let P = Sounding.Slice[0];
  if (QCCheck(P[0]) && QCCheck(P[1]) &&QCCheck(P[2]) &&QCCheck(P[3]) &&QCCheck(P[4]) &&QCCheck(P[5]) && QCCheck(P[6]) ){
    return ConvertToInfo(Sounding.Slice[0], Sounding.Slice[0][0]);
  } else {
    return ConvertToInfo(Sounding.Slice[1], Sounding.Slice[1][0]);
  }
}

/** Lerp every field between rows `Pr` and `Rr`; wind (4 = dir, 5 = speed) via u/v components. */
function LerpSoundingSlice(Pr, Rr, LerpFactor){
  let Slice = {};
  for (let x = 0; x < Pr.length; x++){
    if (x == 4 || x == 5){
      if (x == 5){
        continue;
      }

      let Cartesian = PolarToCartesianDeg(Pr[5], Pr[4]);
      let Cartesian2 = PolarToCartesianDeg(Rr[5], Rr[4]);

      let TrueCart = {
        x: Lerp(Cartesian.x, Cartesian2.x, LerpFactor),
        y: Lerp(Cartesian.y, Cartesian2.y, LerpFactor),
      };

      let TruePolarInterp = CartesianToPolarDeg(TrueCart);

      if (TruePolarInterp.theta < 0){
        TruePolarInterp.theta = (TruePolarInterp.theta + 360) % 360;
      }

      Slice[4] = TruePolarInterp.theta;
      Slice[5] = TruePolarInterp.r;
    } else {
      Slice[x] = Lerp(Pr[x], Rr[x], LerpFactor);
    }
  }
  return Slice;
}

export function GetLayerByPres(Sounding, Level, Type="All"){
  if (Level == "SFC") {
    return SurfaceLayerInfo(Sounding);
  }

  if (Level == "Last") {
    return ConvertToInfo(Sounding.Slice[Sounding.Slice.length-1], Sounding.Slice[1][0]);
  }
  
  for (let i = 0; i < Sounding.Slice.length; i++){
    if (Sounding.Slice[i][0] == Level){
      return ConvertToInfo(Sounding.Slice[i], Sounding.Slice[1][0]);
    } else if (Sounding.Slice[i][0] > Level && Sounding.Slice[i+1][0] < Level){
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][0], Sounding.Slice[i+1][0], Level);
      //// console.log(LerpFactor, Sounding.Slice[i][0], Sounding.Slice[i+1][0]);
      let Slice = LerpSoundingSlice(Sounding.Slice[i], Sounding.Slice[i+1], LerpFactor);

      //Slice.VT = VirtTemp(Slice);

      return ConvertToInfo(Slice, Sounding.Slice[1][0]);
    }
  }
}

export function ConvertToInfo(N, SP){
  return {
    P:N[0],
    H:N[1],
    T : N[2],
    D : N[3],
    VT : VirtTemp(N, SP, true, true),
    WD : N[4],
    WS : N[5],
    WB : N[6],
  }
}

export function ConvertToRaw(N, SP){
  return [N.P, N.H, N.T, N.D, N.WD, N.WS, N.WB];
}

export function GetLayerByTemp(Sounding, Level, wetbulb=false){
  if (Level == "SFC") {
    return SurfaceLayerInfo(Sounding);
  }

  let Iter = 2;
  
  if (wetbulb){
    Iter = 6;
  }
  
  for (let i = 0; i < Sounding.Slice.length-1; i++){
    if (Sounding.Slice[i][Iter] == Level){
      return ConvertToInfo(Sounding.Slice[i],  Sounding.Slice[1][0]);
    } else if ((Sounding.Slice[i][Iter] > Level && Sounding.Slice[i+1][Iter] < Level) || 
        (Sounding.Slice[i][Iter] < Level && Sounding.Slice[i+1][Iter] > Level)){
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][Iter], Sounding.Slice[i+1][Iter], Level);
      //// console.log(LerpFactor, Sounding.Slice[i][1], Sounding.Slice[i+1][1]);

      let Slice = LerpSoundingSlice(Sounding.Slice[i], Sounding.Slice[i+1], LerpFactor);

      return ConvertToInfo(Slice, Sounding.Slice[1][0]);
    }
  }
  
  return false;
}

export function GetLayerByHght(Sounding, Level, addTo=true){
  if (Level == "SFC") {
    return SurfaceLayerInfo(Sounding);
  }
  
  if (addTo){
    Level += Sounding.Slice[0][1];
  }

  for (let i = 0; i < Sounding.Slice.length; i++){
  if (Sounding.Slice[i+1] == undefined){
    return false;
  }
    if (Sounding.Slice[i][1] == Level){
      return ConvertToInfo(Sounding.Slice[i],  Sounding.Slice[1][0]);
    } else if (Sounding.Slice[i][1] < Level && Sounding.Slice[i+1][1] > Level){
      let LerpFactor = GetLerpFactor(Sounding.Slice[i][1], Sounding.Slice[i+1][1], Level);
      //// console.log(LerpFactor, Sounding.Slice[i][1], Sounding.Slice[i+1][1]);
      let Slice = LerpSoundingSlice(Sounding.Slice[i], Sounding.Slice[i+1], LerpFactor);

      return ConvertToInfo(Slice,  Sounding.Slice[1][0]);
    }
  }
}

/** Modified Lerpination
 * 
 * @param {*} m1 Number to be (1-V)
 * @param {*} m2 Number to be V
 * @param {*} v V
 * @returns {number} OH YEH
 */
export function ModifLerp(m1, m2, v){
    return (1 - v) * m1 + v * m2;
}






/** entrainment rate in 1/m
 * 
 * @param {*} cape in j/kg
 * @param {*} ecape in j/kg
 * @param {*} ncape in j/kg
 * @param {*} vsr idk
 * @param {*} sch storm coloumn height
 * @returns {number} entrainment rate (M^-1)
 */
export function entrainment_rate(cape, ecape, ncape, vsr, sch){
    const eat = ecape/cape;
    const nt = ncape/cape;
    const vsrt = vsr/Math.sqrt(2 * cape);
    const et = eat - Math.pow(vsrt, 2);

    return (2 * (1 - et)/(et + nt))/sch;
}

/** updraft size en meter
 * 
 * @param {*} erate floating
 * @returns updrafting meters
 */
export function updraft_radius(erate){
    return Math.sqrt(2 * Constants.k2 * Constants.L_mix / (Constants.Pr * erate));
}

/** Specific heat capacity of moist air .
 * 
 * @param {*} spechum in kg/kg i think
 * @returns the HEAT capacity i think
 */
export function spec_heat_cap_of_moist_air(spechum){
    return ModifLerp(Constants.c_pd, Constants.c_pv, spechum);
}

/** PRessure at height whatever
 * 
 * @param {*} pres in mb
 * @param {*} hghtabove in meters
 * @param {*} tmp in KELVIN
 * @returns {number} in mb
 */
export function pres_at_hght(pres, hghtabove, tmp){
    var shght = (Constants.mgc * tmp) / (Constants.amm * Constants.g);
    return pres * Math.exp(-hghtabove/shght);
}

/** Linearly interpolate amazing, morel ike arrayzing :D
 * 
 * @param {*} input_arr 
 * @param {*} output_arr 
 * @param {*} input 
 * @param {*} debug 
 * @returns 
 */
export function linear_interp(input_arr, output_arr, input, debug=false){
     if (input < input_arr[0]){
        return output_arr[0];
    } else if (input >= input_arr[-1]){
        return LastItem(output_arr)
    } else {
        for (let i = 0; i < input_arr.length-1; i++){
            var ip1 = input_arr[i];
            var ip2 = input_arr[i+1];

            if (input == ip1){
                return output_arr[i]
            } else if (input < ip2){
                const op1 = output_arr[i];
                const op2 = output_arr[i + 1];

                const w1 = (ip2 - input)/(ip2 - ip1);
                const w2 = (input - ip1)/(ip2 - ip1);

                return op1 * w1 + op2 * w2;
            } else {
                continue;
            }
        }
    }

    return null;
}

/** Its some sort of linera interpolation but idk and idc!
 * 
 * @param {*} input_arr 
 * @param {*} output_arr 
 * @param {*} input 
 * @param {*} debug 
 * @returns 
 */
export function rev_linear_interp(input_arr, output_arr, input, debug = false){
    //I got no idea but yeah
    if (input > input_arr[0]){
        return output_arr[0];
    } else if (input <= input_arr[-1]){
        return LastItem(output_arr)
    } else {
        for (let i = 0; i < input_arr.length-1; i++){
            var ip1 = input_arr[i];
            var ip2 = input_arr[i+1];

            if (input == ip1){
                return output_arr[i]
            } else if (input > ip2){
                const op1 = output_arr[i];
                const op2 = output_arr[i + 1];

                const w1 = (ip2 - input)/(ip2 - ip1);
                const w2 = (input - ip1)/(ip2 - ip1);

                return op1 * w1 + op2 * w2;
            } else {
                continue;
            }
        }
    }

    return null;
}

/** Specific humidity from Dewpoint
 * 
 * @param {*} prs in hPA i think
 * @param {*} dwp in kelvin maybe idk
 * @returns {number} number
 */
export function spechum_from_dwp(prs, dwp){
    return specHum(prs * 100, vp(dwp) * 100);
}

/** Vapor pressure
 * 
 * @param {*} dwp in kelvin
 * @returns {} in hPA
 */
export function vp(dwpC){
    return 6.112 * Math.exp((17.67 * dwpC) / (dwpC + 243.5));
}

/** SPECIFIC humidity (dislike this thing)
 * @param {*} prs pressure in Pa
 * @param {*} vp vapor pressure in Pa
 * @returns {} in kg m^-3 i think
 */
export function specHum(prs, vp){
    const wvD = absHum(vp, 280);//kg m^-3
    const aD = dry_air_density(prs - vp, 280); //kg m^-3
    return wvD/ (wvD + aD);
}

/** ABSOLUTE humidity (cinema)
 * 
 * @param {*} vp vapor pressure i think PA
 * @param {*} tmp temp in soemthing
 * @returns {number} the ABSOLTUE humdity
 */
export function absHum(vp, tmp){
    return vp/(Constants.wvgc * tmp);
}

/**dry air density, units idk
 * 
 * @param {*} dap dry air pressure Pa ?
 * @param {*} tmp tempereature
 * @returns {number} the density of this jawn
 */
export function dry_air_density(dap, tmp){
    return dap / (Constants.dagc * tmp);
}

/** dewpoiny from spec hum
 * 
 * @param {*} prs Pressure in Pa
 * @param {*} sh Specific hudmity (ew)
 * @returns {number} dew point in Kelvin?
 */
export function dwp_from_spechum(prs, sh){
    return dwp_from_vaporpres(vp_from_spechum(prs, sh));
}

/** vapor pressure from pres and spechiifih
 * 
 * @param {*} prs Pressure in Pa
 * @param {*} sh Specific hudmity (ew)
 * @returns {number} Vapor Pressure in Pa!
 */
export function vp_from_spechum(prs, sh){
    const nmtor = sh * prs;
    const dmtor = (1 / Constants.wvgc + sh / Constants.dagc - sh / Constants.wgvc);
    return nmtor / (Constants.dagc * dmtor);
}


/** DEW POINTY
 * 
 * @param {*} vp VAPOR PRESSURE!!!!!!!!!!!!!!! IN Pa
 * @returns {number} IN KELVIN
 */
export function dwp_from_vaporpres(vp){
    const e0 = 611;
    const t0 = 273.15; //in kevin
    const lhov = 2.5e6; //latent_heat_of_vaporization;

    const vp_nondim = vp;
    const dpr = 1/t0 - (461.5 / lhov) * Math.log(vp_nondim/e0);
    return (1 / dpr)
}

/** HOW MUCh ice in the air :D
 * 
 * @param {*} tmp in kevin idk
 * @param {*} warmest_mixed_phase_temp 273.15
 * @param {*} coldest_mixed_phase_temp 253.15
 */
export function ice_fraction(tmp, warmest_mixed_phase_temp, coldest_mixed_phase_temp){
    if (tmp >= warmest_mixed_phase_temp){
        return 0;
    } else if  (tmp <= coldest_mixed_phase_temp){
        return 1;
    } else {
        return (1/(coldest_mixed_phase_temp - warmest_mixed_phase_temp))*(tmp - warmest_mixed_phase_temp);
    }
}

/** HOW MUCH ICE IS IN THE AIR BRUH!
 * @param {*} tmp in kevin idk
 * @param {*} warmest_mixed_phase_temp 273.15
 * @param {*} coldest_mixed_phase_temp 253.15
 * @returns {number} IN KELVIN
 */
export function ice_fraction_deriv(tmp, warmest_mixed_phase_temp, coldest_mixed_phase_temp){
    if (tmp >= warmest_mixed_phase_temp || tmp <= coldest_mixed_phase_temp){
        return 0;
    } else {
        return (1/(coldest_mixed_phase_temp - warmest_mixed_phase_temp));
    }
}



const r_satCons = {
    vapor_pres_ref: 611.2,// * units("Pa")
    t1: (Constants.c_pv - Constants.c_pi) / Constants.R_v,
    t1a: (Constants.c_pv - Constants.c_pl) / Constants.R_v,
    t2: (Constants.L_v_trip - Constants.T_trip * (Constants.c_pv - Constants.c_pi)) / Constants.R_v,
    t2a: (Constants.L_v_trip - Constants.T_trip * (Constants.c_pv - Constants.c_pl)) / Constants.R_v,
}

// borrowed and adapted from ECAPE_FUNCTIONS
//temperature, pressure, ice_flag: int, warmest_mixed_phase_temp: pint.Quantity = 273.15 * units("K"), coldest_mixed_phase_temp: pint.Quantity = 253.15 * units("K")
/** something saturated OH I GET IT, basically mixing ratio between SOLID and LIQIUD :D
 * @param {*} tmp like it could be an array but i have no fucking idea lol
 * @param {*} prs 
 * @param {*} ice_flag integer
 * @param {*} warmest_mixed_phase_temp in kelvinm
 * @param {*} coldest_mixed_phase_temp in kevin
 */
export function r_sat(tmp, prs, ice_flag, warmest_mixed_phase_temp=273.15, coldest_mixed_phase_temp=253.15){
    if (ice_flag == 2){
        const t1 = r_satCons.t1;
        const t2 = r_satCons.t2;
        const esi = Math.exp((tmp - Constants.T_trip) * t2/(tmp * Constants.T_trip)) * r_satCons.vapor_pres_ref * Math.pow((tmp/Constants.T_trip), t1)
        return Constants.phi * esi/(prs - esi);
    } else if (ice_flag == 1){
        const omega = ice_fraction(tmp, warmest_mixed_phase_temp, coldest_mixed_phase_temp);

        const qsat_l = r_sat(tmp, prs, 0);
        const qsat_i = r_sat(tmp, prs, 2);

        return (1-omega)*qsat_l + (omega)*qsat_i;
    } else {
        const t1 = r_satCons.t1a;
        const t2 = r_satCons.t2a;
        const esi = Math.exp((tmp - Constants.T_trip) * t2/(tmp * Constants.T_trip)) * r_satCons.vapor_pres_ref * Math.pow((tmp/Constants.T_trip), t1)
        /*if (esi != esi){
          console.error(t1, t2, esi, tmp);
        }*/
        return Constants.phi * esi/(prs - esi);
    }
}

function heaviside(x1, x2) {
  if (x1 < 0) {
    return 0;
  } else if (x1 === 0) {
    return x2;
  } else {
    return 1;
  }
}

//Idk either
function omega(T, T1, T2){
    return ((T - T1)/(T2 - T1)) * heaviside((T - T1)/(T2 - T1), 1) * heaviside((1 - (T - T1)/(T2-T1)),1) + heaviside(-(1 - (T - T1)/(T2-T1)),1);
}

//Idk
function domega(T, T1, T2){
    return (heaviside(T1-T,1) - heaviside(T2-T,1))/(T2-T1);
}

/** Normal Cape
 * 
 * @param {*} T3 C array
 * @param {*} p0 Pa array
 * @param {*} q0 kg/kg array
 * @param {*} z0 m array
 * @param {*} Snding Sounding
 * @param {*} T1 kevin
 * @param {*} T2 kevin
 * @param {*} LFC m
 * @param {*} EL m
 */
export function compute_NCAPE(T0, p0, q0, z0, Snding, T1, T2, LFC, EL){
    const n = T0.length;
    const EndSlice = GetLayerByPres(Snding, "Last");

    var MSE0 = [];
    var rsat = [];
    var qsat = [];
    var MSE0_star = [];
    var MSE0_bar = [];
    var T1 = [];

    for (let i = 0; i < EndSlice.H; i+=100){
        const FSlice = GetLayerByHght(Snding, i, false);
        const RT = FSlice.T + 273.15;
        //console.log(Constants.c_pd * T0[i] + Constants.xlv * q0[i] + Constants.g * z0[i]);
        T1.push(RT);
        MSE0.push(Constants.c_pd * RT + Constants.xlv * spechum_from_dwp(FSlice.P, FSlice.D) + Constants.g * i);
        const Rsat = r_sat(RT, FSlice.P, 0, T1, T2)
        rsat.push(Rsat);
        const Qsat = (1 - Rsat) * Rsat
        qsat.push(Qsat );
        MSE0_star.push( Constants.c_pd * RT + Constants.xlv * Qsat + Constants.g * i);
        MSE0_bar.push(0);
    }

    MSE0_bar = new Array(T1.length).fill(0);
    MSE0_bar[0] = MSE0[0]

    for (let iz = 1; iz < MSE0_bar.length; iz++){
        var T = 0;

        for (let x = 0; x < iz-1; x++){
            const pp = ((MSE0[x] + MSE0[x+1]) * (100));

            if (pp == pp){
              T += pp;
            }
        }

        MSE0_bar[iz] = 0.5 * (T)/(iz * 100);
    }

    var int_arg = [];

    for (let a = 0; a < MSE0_bar.length; a++){
      int_arg.push( - (Constants.g / (Constants.c_pd * T1[a])) * (MSE0_bar[a] - MSE0_star[a]))
    }

    var ind_LFC = (Math.floor(LFC/100) == 0 ? 1 : Math.floor(LFC/100));
    var ind_EL = Math.floor(EL/100);

    //console.log(ind_LFC, ind_EL);

    if (ind_EL == 0 || ind_LFC == 0){
      return 0;
    }

    var NCAPE = 0;

    for (let i = ind_LFC; i < ind_EL-1; i++){
      const val = ((0.5 * int_arg[i] + 0.5 * int_arg[i+1])) * (100);
      if (val == val){
        NCAPE += val;
      }
    }

    NCAPE = Math.max(0, NCAPE);
    return {NCAPE, MSE0_star, MSE0_bar};
}

/**Calculate the entraining cape of a parcel
 * @param {*} sr_wind 0-1 km AGL average storm relative wind magnitude
 * @param {*} psi Parameter defined in eqn. 52, constant for a given equilibrium level
 * @param {*} ncape Buoyancy dilution potential of the free troposphere (eqn. 54)
 * @param {*} cape Convective available potential energy (CAPE, user-defined type)
 * @returns Entraining CAPE (eqn. 55)
 */
export function calc_ecape_a(sr_wind, psi, ncape, cape){
    const ta = Math.pow(sr_wind, 2)/2;
    const tb = ((-1 - psi - (2 * psi / Math.pow(sr_wind, 2)) * ncape) / ((4 * psi) / Math.pow(sr_wind, 2)));
    const tc = (
        Math.sqrt(Math.pow((1 + psi + (2 * psi / Math.pow(sr_wind, 2)) * ncape), 2) + 8 * (psi / Math.pow(sr_wind, 2)) * (cape - (psi * ncape)))
    ) / ((4 * psi) / Math.pow(sr_wind, 2));
    var eCape = ta+tb+tc;

    return (eCape >= 0 ? eCape : 0);
}

//NOW WE DO THE HIGHER END ONES
/** Calculate the mean storm relative (as compared to Bunkers right motion) wind magnitude in the 0-1 km AGL layer
 * 
 * @param {*} pres 
 * @param {*} uwind 
 * @param {*} vwind 
 * @param {*} hght 
 * @param {*} ifb 
 * @param {*} ift 
 * @param {*} CSMot 
 * @param {*} V 
 * @returns {number} storm sr wind in m/s i thinkies
 */
export function calc_sr_wind(pres, uwind, vwind, hght, ifb, ift, CSMot, V){
    const hghtAGL = hght.map(row => row - hght[0]);

    var u_sr = uwind.map(row => row - CSMot.x);
    var v_sr = vwind.map(row => row + CSMot.y);
    var srwind = 0;
    var amn = 0;

    for (let i = 0; i < hghtAGL.length; i++){
        if (hghtAGL[i] > ift){
            break;
        }

        if (hghtAGL[i] <= ift){
            srwind += (hghtAGL[i+1] - hghtAGL[i])/1000 * Math.sqrt(Math.pow(u_sr[i] , 2) + Math.pow(v_sr[i], 2))/1.94384;
        }
    }

    return srwind;
}

/** Parameter defined in eqn. 52, constant for a given equilibrium level, see COMPUTE_ECAPE.m L88 (pitchfork)
 * 
 * @param {*} el meters equilibirum lebel
 * @returns psi
 */
export function calc_psi(el){
    var sigma = 1.1;
    var alpha = 0.8;
    var l_mix = 120; //m
    var pr = 1/3;
    var ksq = 0.18;

    return (ksq * Math.pow(alpha, 2) * Math.pow(Math.PI, 2) * l_mix) / (pr * Math.pow(sigma, 2) * el)
}

/**Calculate the entraining CAPE (ECAPE) of a parcel
 * @param {*} hght height Meters
 * @param {*} pres pressure mb
 * @param {*} tmp temp Celsius
 * @param {*} spechum specific humidity
 * @param {*} u_wind x comp of wind
 * @param {*} v_wind y comp of wind
 * @param {*} snding the sounding
 * @param {*} ifb 0 meters
 * @param {*} ift 1000 meters
 * @param {*} sm  right
 * @param {*} passedInfo includes {lfc, el, StormMotion:{u,v}, Cape}
 * @returns 
 */
export function calc_ecape_ncape(hght, pres, tmp, spechum, u_wind, v_wind, snding, ifb=0, ift=1000, sm="right", passedInfo){
    var el_z = passedInfo.EL;
    var lfc_z = passedInfo.LFC;

    const {NCAPE, MSE0_star, MSE0_bar} = compute_NCAPE(tmp.map(row => row+273.15), pres.map(row => row*100), spechum, hght, snding, 273.15, 253.15, lfc_z, el_z);
    
    const sr_wind = calc_sr_wind(pres, u_wind, v_wind, hght, ifb, ift, passedInfo.StormMotion, sm)
    const psi = calc_psi(el_z);
    const ECape = calc_ecape_a(sr_wind, psi, NCAPE, passedInfo.Cape);
    const NCape = NCAPE;

    return {ECape, NCape}
}