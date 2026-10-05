import { r_sat, ice_fraction, ice_fraction_deriv, ModifLerp, dwp_from_vaporpres, vp_from_spechum,
    dwp_from_spechum, dry_air_density, absHum, specHum, vp, spechum_from_dwp, rev_linear_interp, 
    linear_interp, entrainment_rate, updraft_radius, spec_heat_cap_of_moist_air, pres_at_hght,
    GetLayerByPres, GetLayerByTemp, PolarToCartesianDeg, CartesianToPolarDeg, ConvertToInfo,
    ConvertToRaw, GetLayerByHght, LastItem, calc_ecape_ncape, calc_sr_wind, Constants
 } from './ecapeCalc.js';

//Next Functionos
export function density_temperature(tmp, qv, qt){
    if (Array.isArray(tmp)){
        if (tmp[0] == null){
            return new Array(tmp.length).fill(0);
        } else {
            let R = [];
            for (let i = 0; i < tmp.length; i++){
                R.push(tmp[i] * (1 - qt[i] + qv[i]/Constants.phi));
            }
            return R;
        }
    }

    return tmp * (1 - qt + qv/Constants.phi);
}

//Next, Lets Define Lapse Rates

// Equation 19 in Peters et. al. 2022 (https://journals.ametsoc.org/view/journals/atsc/79/3/JAS-D-21-0118.1.xml)
//@check_units('[temperature]', '[dimensionless]', '[temperature]', '[dimensionless]')
/** UNSAUTRATED Parkel
 * 
 * @param {*} tmp_prcl 
 * @param {*} qv_prcl 
 * @param {*} tmp_env 
 * @param {*} qv_env specific humidity is weird and i dont liek it at ALL!
 * @param {*} eRate entrainment rate
 * @returns 
 */
function USALR(tmp_prcl, qv_prcl, tmp_env, qv_env, eRate){
    const tEntrain = -eRate * (tmp_prcl - tmp_env);
    const dTempPrcl = density_temperature(tmp_prcl, qv_prcl, qv_prcl);
    const dTempEnv = density_temperature(tmp_env, qv_env, qv_env);
    
    const Bplus = Constants.g * (dTempPrcl - dTempEnv)/dTempEnv;

    const c_pmv = ModifLerp(Constants.c_pd, Constants.c_pv, qv_prcl);

    return (-Constants.g/Constants.c_pd) * ((1 + Bplus/Constants.g)/(c_pmv/Constants.c_pd)) + tEntrain;
}

// Equation 24 in Peters et. al. 2022 (https://journals.ametsoc.org/view/journals/atsc/79/3/JAS-D-21-0118.1.xml)
// @check_units('[temperature]', '[dimensionless]',  '[dimensionless]', '[temperature]', '[dimensionless]', '[dimensionless]')
/** The saturated lapse rate, believe me if i knew what i was looking at i would write it downb
 * 
 * @param {*} tmp_prcl 
 * @param {*} qt_prcl 
 * @param {*} pres_prcl 
 * @param {*} tmp_env 
 * @param {*} qv_env 
 * @param {*} eRate 
 * @param {*} prate 
 * @param {*} warmest_mixed_phase_temp Kelvin
 * @param {*} coldest_mixed_phase_temp Kelvin
 * @param {*} qt_e 
 * @returns {} saturated_adiabatic_lapse_rate idk :(
 */ 
function SALR(tmp_prcl, qt_prcl, pres_prcl, tmp_env, qv_env, eRate, prate, warmest_mixed_phase_temp=273.15, coldest_mixed_phase_temp=253.13, qt_e){
    const omega = ice_fraction(tmp_prcl, warmest_mixed_phase_temp, coldest_mixed_phase_temp);
    const d_omega = ice_fraction_deriv(tmp_prcl, warmest_mixed_phase_temp, coldest_mixed_phase_temp);

    const q_vsl = (1 - qt_prcl) * r_sat(tmp_prcl, pres_prcl, 0);
    const q_vsi = (1 - qt_prcl) * r_sat(tmp_prcl, pres_prcl, 2);

    const qv_parcel = (1 - omega) * q_vsl + omega * q_vsi;

    const tEntrain = -eRate * (tmp_prcl - tmp_env);
    const qEntrain = -eRate * (qv_parcel - qv_env);

    qt_e = (qt_e !== null ? qt_e : -eRate * (qt_prcl - qv_env) - prate * (qt_prcl - qv_parcel));

    //Water or something
    const q_condensate = qt_prcl - qv_parcel;

    const ql_parcel = q_condensate * (1 - omega);
    const qi_parcel = q_condensate * omega;

    //ITS JUST LIKE LETTERS 
    const c_pm = (1 - qt_prcl) * Constants.c_pd + 
                qv_parcel * Constants.c_pv +
                ql_parcel * Constants.c_pl +
                qi_parcel * Constants.c_pi;

    const dTempPrcl = density_temperature(tmp_prcl, qv_parcel, qt_prcl);
    const dTempEnv = density_temperature(tmp_env, qv_env, qv_env);

    const Bplus = Constants.g * (dTempPrcl - dTempEnv)/dTempEnv;

    const L_v = Constants.L_v_trip + (tmp_prcl - Constants.T_trip) * (Constants.c_pv - Constants.c_pl);
    const L_i = Constants.L_i_trip + (tmp_prcl - Constants.T_trip) * (Constants.c_pl - Constants.c_pi);

    //I DONT KNOW WHAT IT MEANS : ((((
    const L_s = L_v + omega * L_i;

    const Q_vsl = q_vsl / (Constants.phi - (Constants.phi * qt_prcl) + qv_parcel);
    const Q_vsi = q_vsi / (Constants.phi - (Constants.phi * qt_prcl) + qv_parcel);

    const Q_M = (1 - omega) * (q_vsl)/(1 - Q_vsl) + omega * (q_vsi)/(1 - Q_vsi);
    const L_M = (1 - omega) * L_v * (q_vsl)/(1 - Q_vsl) + omega * (L_v + L_i) * (q_vsi)/(1 - Q_vsi);
    const R_m0 = (1 - qv_env) * Constants.R_d + qv_env * Constants.R_v;

    const Terms = [
        Bplus, //nan
        Constants.g,
        ((L_s * Q_M) / (R_m0 * tmp_env)) * Constants.g,
        (c_pm - L_i * (qt_prcl - qv_parcel) * d_omega) * tEntrain,
        L_s * (qEntrain + qv_parcel/(1 - qt_prcl) * qEntrain), // undefined
        c_pm,
        (L_i * (qt_prcl - qv_parcel) - L_s * (q_vsi - q_vsl)) * d_omega,
        (L_s * L_M)/(Constants.R_v * tmp_prcl * tmp_prcl),
    ];

    const tA = Terms[0] + Terms[1] + Terms[2];
    const tB = Terms[3] + Terms[4];
    const tC = Terms[5] + Terms[7];
    const tD = Terms[6];

    return -(tA - tB)/(tC - tD);
}

let EXAMPLEParcel = {
    Path : [],
    ECape : {
      Path : [],
      Cape : 0,
    },
    Cape : 0,
    Cape3 : 0,
    Cape6 : 0,
    HGZCape : 0,
    PreHGZCape : 0,
    CINH : 0,
    LCL : -9999,
    LFC : -9999,
    EL : -9999,
    MPL: 16000,
    Levels: 0,
    Start: null,
  }

const ECAPE_PARCEL_DZ = 20; //meters

//THE BIG ONE!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
/**
 * 
 * @param {*} pres array
 * @param {*} hght array
 * @param {*} tmp array celsuis
 * @param {*} dwp array celsiius
 * @param {*} u_wind array
 * @param {*} v_wind array
 * @param {*} atipv align_to_input_pressure_values
 * @param {*} e_switch entrainment_switch
 * @param {*} pa_switch pseudoadiabatic_switch
 * @param {*} Sounding the sounding
 * @param {*} passedInfo {lfc, el, StormMotion:{u,v}, Cape}
 * @param {*} CSMot storm motion passed
 * @param {*} ilb inflow_layer_bottom
 * @param {*} ilt inflow_layer_top
 * @param {} parcelObject The rest of params, in the parcel object that is given from the other stuff and things
 * @returns {[]} [Pressure, Height, Temperature, QV, QT];
 */
export function ecape_parcel(pres, hght, tmp, dwp, u_wind, v_wind, atipv, e_switch = true, pa_switch=true, Sounding, passedInfo, CSMot, ilb=0, ilt=1, parcelObject){
    //Begin by first getting the specific humidty of them mfs
    var SpecHum = [];

    for (let i = 0; i < pres.length; i++){
        SpecHum.push(spechum_from_dwp(pres[i], dwp[i]));
    }

    const ParcelInfo = parcelObject;
//EXAMPLEParcel.Cape
    if (e_switch == true){
        if (ParcelInfo.Cape <= 0){
            if (atipv == true){
                return new Array(5).fill(new Array(pres.length).fill(null));
            } else {
                return new Array(5).fill(null);
            }
        }
    }

    var entr_rate = null;

    var ecape = 0;
    var ncape = 0;
    var vsr = 0;
    var storm_column_height = 0;

    var pTemp = ParcelInfo.Start.T + 273.15;
    var pDewp = ParcelInfo.Start.D + 273.15;
    var pPres = ParcelInfo.Start.P  * 100;
    var pHght = ParcelInfo.Start.H;

    if (e_switch == true){
        var { ECape, NCape } = calc_ecape_ncape(hght, pres, tmp, SpecHum, u_wind, v_wind, Sounding, ilb, ilt, CSMot, passedInfo)
        ecape = ECape;
        ncape = NCape;
        vsr = calc_sr_wind(pres, u_wind, v_wind, hght, ilb, ilt, CSMot);
        storm_column_height = passedInfo.EL - pHght;
    }

    var epsilon = 0;

    if (e_switch == true){
        epsilon = entrainment_rate(passedInfo.Cape, ecape, ncape, vsr, storm_column_height)

        entr_rate = epsilon // / meters
    } else {
        entr_rate = 0;
    }

    
    var pQv = spechum_from_dwp(pPres / 100, pDewp - 273.15);
    var pQt = pQv;

    var pres_raw = []
    var hght_raw = []
    var tmp_raw = []
    var qv_raw = []
    var qt_raw = []

    pres_raw.push(pPres)
    hght_raw.push(pHght)
    tmp_raw.push(pTemp)
    qv_raw.push(pQv)
    qt_raw.push(pQt)

    var prate = 1 / ECAPE_PARCEL_DZ;

    if (!pa_switch){
        prate = 0;
    }

    //Parcel pressure in Pa maybe? idk

    var dqt_dz = 0 / ECAPE_PARCEL_DZ;

    var tmp_K = tmp.map(row => row + 273.15);

    while (pPres >= LastItem(pres)*100){
        var eTemp = linear_interp(hght, tmp_K, pHght);

        var p_SatQ = (1 - pQt) * r_sat(pTemp, pPres, 1);

        if (p_SatQ >= pQv){
            pPres = pres_at_hght(pPres, ECAPE_PARCEL_DZ, eTemp);
            pHght += ECAPE_PARCEL_DZ;

            var ev_Temp = linear_interp(hght, tmp_K, pHght);
            var ev_qv = linear_interp(hght, SpecHum, pHght);

            var dT_dz = USALR(pTemp, pQv, ev_Temp, ev_qv, entr_rate);
            var dqv_dz = -entr_rate * (pQv - ev_qv);

            pTemp += dT_dz * ECAPE_PARCEL_DZ;
            pQv += dqv_dz * ECAPE_PARCEL_DZ;
            pQt = pQv;

            pDewp = dwp_from_spechum(pPres, pQv);
        } else {
            pPres = pres_at_hght(pPres, ECAPE_PARCEL_DZ, eTemp);
            pHght += ECAPE_PARCEL_DZ;

            var ev_Temp = linear_interp(hght, tmp_K, pHght);
            var ev_qv = linear_interp(hght, SpecHum, pHght);

            var dT_dz = 0;
            var dqt_dz = 0;

            if (pa_switch == true){
                dT_dz = SALR(pTemp, pQt, pPres, ev_Temp, ev_qv, entr_rate, prate, 273.15, 253.15, dqt_dz)
            } else {
                dT_dz = SALR(pTemp, pQt, pPres, ev_Temp, ev_qv, entr_rate, prate)
            }

            const H255 = r_sat(pTemp, pPres, 1, 273.15, 253.15);
            var n_Prclqv = (1 - pQt) * H255; //to kg/kg?

            if (pa_switch == true){
                dqt_dz = (n_Prclqv - pQt) / ECAPE_PARCEL_DZ;
            } else {
                dqt_dz = -entr_rate * (pQt - ev_qv) - prate * (pQt - pQv);
            }

            pTemp += dT_dz * ECAPE_PARCEL_DZ;
            pQv = n_Prclqv;

            if (pa_switch == true){
                pQt = pQv;
            } else {
                pQt += dqt_dz * ECAPE_PARCEL_DZ;
            }

            if (pQt < pQv){
                pQv = pQt;
            }
        }

        pres_raw.push(pPres);
        hght_raw.push(pHght);
        tmp_raw.push(pTemp);
        qv_raw.push(pQv);
        qt_raw.push(pQt);
    }

    return [pres_raw, hght_raw, tmp_raw, qv_raw, qt_raw];
}