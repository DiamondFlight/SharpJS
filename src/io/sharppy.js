/**
 * SHARPpy-style text parser (also CM1 input_sounding and Chaser Archive JSON).
 * Produces the SharpJS sounding object used everywhere else:
 *
 *   { Title, STitle, Location, Sounding: { P, H, T, D, W, TW, DW, Slice, OMEGA, SRW }, DWL, TWL, WWL, Len }
 *
 * Each Slice row is [pres mb, hght m, temp C, dwpt C, wdir deg, wspd kt, wetbulb C, omega].
 * Pure functions: no DOM, no network.
 */
import { Lerp, clamp, VirtTemp, wetbulb } from '../calc/skewtCalcs.js';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function GetNumFromRange(V, B, T) {
  return (B - V) / (B - T);
}

function MPStoKTS(n){
  return n * 1.94384;
}

function KTStoMPS(n){
  return n / 1.94384;
}

function calcNxtPrs(pLower, deltaZ, theta, qv_gkg) {
  const Rd = 287.04;
  const g = 9.80665;
  const qv_kg = qv_gkg / 1000;

  const tempK = theta * Math.pow(pLower / 1000, 287.04 / 1005.7);

  const vTemp = tempK * (1 + qv_kg / 0.622) / (1 + qv_kg);

  return pLower / Math.exp(deltaZ / (vTemp * (Rd / g)));
}

function tempCFromTheta(theta, p) {
  return theta * Math.pow(p / 1000.0, 0.2854) - 273.15;
}

function dewpointCFromQv(qv, p) {
  const eps = 0.62195691;
  const w = qv / 1000.0; 
  const e = (w * p) / (eps + w);
  const ln = Math.log(Math.max(e, 1e-12) / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

function parseCM1Sounding(header, lines) {
  const [sfcP, sfcTheta, sfcQV] = header;

  let currentP = sfcP;
  let currentZ = 0;

  return lines.slice(1).map(line => {
    const [hght, tta, qv, u, v] = line.trim().split(/\s+/).map(Number);
    
    const dz = hght - currentZ;
    const p = calcNxtPrs(currentP, dz, tta, qv);

    const tmpC = tempCFromTheta(tta, p); 
    const dewC = dewpointCFromQv(qv, p);

    const speed = Math.hypot(u, v);
    const dir =  (270 - Math.atan2(v, u) * 180 / Math.PI) % 360;

    currentP = p;
    currentZ = hght;

    return {
      p: p,
      hght: hght,
      tmpC: tmpC,
      dewC: dewC,
      dir: dir,
      speed: speed,
    };
  });
}

function breakdownCM1(Text){
  const lines = Text.trim().split('\n');

  const header = lines[0].trim().split(/\s+/).map(Number);
  
  const TrueProfiles = parseCM1Sounding(header, lines);

  let InfoString = "";
  
  for (let i = 0; i < TrueProfiles.length; i++) {
    let PC = TrueProfiles[i].p;
    let HC = TrueProfiles[i].hght;
    let TC = TrueProfiles[i].tmpC;
    let DC = TrueProfiles[i].dewC;
    let WDC = TrueProfiles[i].dir;
    let WSC = MPStoKTS(TrueProfiles[i].speed);
    InfoString += ` ${PC},\t${HC},\t${TC},\t${DC},\t${WDC},\t${WSC},\t${0}\n`;
  }

  let Title = "No Title Provided";

  let txt = `%TITLE%
  ${Title}
      LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD       OMEGA
  --------------------------------------------------------------------------------
  %RAW%
  ${InfoString}%END%`;

  return txt;
}

export function Process(text) {
  let Json = {
    Sounding: {
      T: [],
      D: [],
      W: [],
      H: [],
      P: [],
      TW: [],
      SRW: [],
      DW: [],
      Slice: [],
      OMEGA: [],
    },
    Len: 0,
    Location: false,
  };

  let Info = text;
  if (Info == null) {
    console.error("Error reading the file");
    return false;
  }


  if (Info.includes('"level"')){
    //ChaserArchive
    let True_Info = JSON.parse(text);
    let InfoString = "";
    for (let i = 0; i < True_Info["hght"].length; i++) {
      let PC = True_Info["level"][i];
      let HC = True_Info["hght"][i];
      let TC = True_Info["temp"][i];
      let DC = True_Info["dwpt"][i];
      let WDC = True_Info['wdir'][i];
      let WSC = True_Info['wspd'][i];
      InfoString += ` ${PC},\t${HC},\t${TC},\t${DC},\t${WDC},\t${WSC},\t${0}\n`;
    }

    let Title = "No Title Provided";

    let txt = `%TITLE%
    ${Title}
        LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD       OMEGA
    --------------------------------------------------------------------------------
    %RAW%
    ${InfoString}%END%`;
    Info = txt;
  } else if(Info.includes("%START%")){
    //SHARPPY
  } else if (!/\p{L}/u.test(Info)) {
    //CM1
    Info = breakdownCM1(Info);
  } else if (Info.includes("#")){
    //ICGB: not supported yet
  }
  //Build the Return JSON Object
  let Lines = Info.split("\n");
  let Split = Info.split("%RAW%");

  Json.Title = Lines[1];
  Json.STitle = Lines[1];

  if (Lines[1].indexOf("WRF") > -1 && Lines[1].indexOf("AT: ") > -1){
    let SplitFinder = Lines[1].indexOf("N, ") > -1 ? Lines[1].indexOf("N, ") : Lines[1].indexOf("S, ")
    let Lat = Lines[1].substring(Lines[1].indexOf("AT: "), SplitFinder)
    let Lon = Lines[1].substring(SplitFinder, Lines[1].length)

    if (Lat.indexOf("S")){
      Lat = parseFloat(Lat.substring(4, Lat.length-2));
    } else {
      Lat = -parseFloat(Lat.substring(4, Lat.length-2));
    }

    if (Lon.indexOf("E")){
      Lon = -(360-parseFloat(Lon.substring(2, Lon.length-2)))%360;
    } else {
      Lon = -parseFloat(Lon.substring(2, Lon.length-2))%360;
    }

    Json.Location = [Lat, Lon];
    Json.Location2 = [Lat, -Lon];
  }
  

  Split = Split[1].split("%END%");
  let PL = Split[0].split("\n");
  // let PL = Pr[1].split("%END%");

  Json.Len = PL.length;

  let DWL = 0;
  let TWL = 0;
  let WWL = 0;

  let SFCLayer = 9999;
  let sfc = PL[1].split(",");

  let GoodData = [];

  for (let x = 0; x < sfc.length; x++) {
    sfc[x] = parseFloat(sfc[x]);
  }

  for (let i = 0; i < PL.length; i++) {
    let Ln = PL[i].split(",");

    if (Ln.length == 1) {
      continue;
    }


    for (let x = 0; x < Ln.length; x++) {
      Ln[x] = parseFloat(Ln[x]);
    }

    if (Ln.length == 6){
      Ln[Ln.length] = wetbulb(parseFloat(Ln[0]), parseFloat(Ln[2]), parseFloat(Ln[3]))
      Ln[Ln.length] = 0
    } else {
      Ln.splice(Ln.length-1, 0, wetbulb(parseFloat(Ln[0]), parseFloat(Ln[2]), parseFloat(Ln[3])))
    }
    

    if (Ln[2] == -9999 && Ln[3] == -9999 && Ln[4] == -9999 && Ln[5] == -9999) {
      continue;
    }

    if (Ln[2] != -9999 && Ln[3] != -9999 && Ln[4] != -9999 && Ln[5] != -9999) {
      GoodData.push(Json.Sounding.Slice.length);
    }

    Json.Sounding.P.push(parseFloat(Ln[0]));
    Json.Sounding.H.push(parseFloat(Ln[1]));
    Json.Sounding.T.push(parseFloat(Ln[2]));
    Json.Sounding.D.push(parseFloat(Ln[3]));

    if (parseFloat(Ln[2]) != -9999 && !isNaN(parseFloat(Ln[2]))) {
      Json.Sounding.TW.push(
        { T: parseFloat(Ln[2]), VT: VirtTemp(Ln, sfc[0], true, true), WB: Ln[6], P: parseFloat(Ln[0]), H: parseFloat(Ln[1]) }
      );
      TWL += 1;

      SFCLayer = Math.min(SFCLayer, i);
    };

    if (parseFloat(Ln[3]) != -9999 && !isNaN(parseFloat(Ln[3]))) {
      Json.Sounding.DW.push(
        { D: parseFloat(Ln[3]), P: parseFloat(Ln[0]), H: parseFloat(Ln[1]) }
      );
      DWL += 1;

      SFCLayer = Math.min(SFCLayer, i);
    };

    Json.Sounding.Slice.push(Ln);
    Json.Sounding.OMEGA.push(Ln[7]/10);    
  }

  Json.DWL = DWL;
  Json.TWL = TWL;


  //Fix -9999 Missing data

  // // console.log(Json.Sounding.Slice, GoodData);

  let Iterator = 0;
  let NewSlices = Json.Sounding.Slice;

  if (GoodData.length < 1) {

  } else {
    let Bottom = Json.Sounding.Slice[GoodData[0]];
    let Top = Json.Sounding.Slice[GoodData[1]];

    for (let i = 0; i < Json.Sounding.Slice.length; i++) {
      if (GoodData.indexOf(i) != -1) {
        Bottom = Json.Sounding.Slice[i];

        if ((GoodData.indexOf(i) + 1) >= GoodData.length) {
          break;
        }
        Top = Json.Sounding.Slice[Math.min(Json.Sounding.Slice.length - 1, GoodData[GoodData.indexOf(i) + 1])];
      } else {
        let S = Json.Sounding.Slice[i];
        let LerpFactor = clamp(GetNumFromRange(S[1], Bottom[1], Top[1]), 0, 1);

        for (let a = 2; a < S.length; a++) {
          if (S[a] == -9999) {
            S[a] = Lerp(Bottom[a], Top[a], LerpFactor);

            if (a == 3){
              Json.Sounding.D[i] = Lerp(Bottom[a], Top[a], LerpFactor);
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < Json.Sounding.Slice.length; i++){
    let P = Json.Sounding.Slice[i];

    for (let x = 0; x < P.length; x++) {
      let Drat = P[x];
      if (Drat == -9999) {
        if (i == Json.Sounding.Slice.length - 1) {
          Drat = Json.Sounding.Slice[i - 1][x];
        } else {
          let Higher = i;
          let Lower = i;
          while (true) {
            Lower -= 1;
            if (Json.Sounding.Slice[Lower] == undefined) {
              Lower += 1;
              break;
            }
            if (Json.Sounding.Slice[Lower][x] != -9999 || Lower < 0) {
              break;
            }
          }

          while (true) {
            Higher += 1;
            if (Json.Sounding.Slice[Higher] == undefined) {
              Higher -= 1;
              break;
            }
            if (Json.Sounding.Slice[Higher][x] != -9999 || Higher > Json.Sounding.Slice.length) {
              break;
            }
          }

          let Lwr = Json.Sounding.Slice[Lower];
          let Hgr = Json.Sounding.Slice[Higher];

          if (Hgr[x] == -9999 && Json.Sounding.Slice.length-1 <= Higher && (x == 3 || Json.Sounding.Slice.length-1 == i)){
            if (x == 3){
              P[x] = Hgr[2] - Math.abs(Lwr[3] - Lwr[2]);
              Json.Sounding.D[i] = clamp(P[x], -9999, Json.Sounding.T[i]);
              Json.Sounding.Slice[i][x] = clamp(P[x], -9999, Json.Sounding.T[i]);
            }
            
            continue;
          }

          P[x] = lerp(
            Hgr[x],
            Lwr[x],
            clamp(
              (P[1] - Hgr[1]) / (Lwr[1] - Hgr[1]),
              0,
              1
            )
          )
        }
      }
    }
  }
  

  for (let i = 0; i < Json.Sounding.Slice.length; i++) {
    let Ln = Json.Sounding.Slice[i];
    Json.Sounding.W.push(
      { WD: parseFloat(Ln[4]), WS: parseFloat(Ln[5]), H: parseFloat(Ln[1]) }
    );
    WWL += 1;
  }

  Json.WWL = WWL;

  return Json;
}
