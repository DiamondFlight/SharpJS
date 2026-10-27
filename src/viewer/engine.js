
/**
 * SharpJS rendering engine.
 *
 * createEngine(root, options) returns one independent chart instance. All DOM lookups are
 * scoped to `root` (see viewer/template.js for the elements it expects), so several charts
 * can live on one page. Hosts normally use the SharpJS() wrapper in viewer/index.js rather
 * than calling the engine directly.
 */
import {
  GetBM, LiftParcel, GetDCape, LapseRateHght, LapseRatePres,
  GetLayerByPres, EffInflowCalc, GetLayerByHght, WindShearFindP,
  GetSRH, GetSWV, WindShearFind, WindShear, ConvertPolartoCart,
  GetParams, DrawInsetParams, thetae, wetbulb, mean_layer_temp, mean_relh,
  GetLayerByTemp, RelHum, mixratio, MeanWind, MeanWindNW, ConvertToInfo, virtemp,
  CtoK, clamp, Mag, VirtTemp, degtoRad, Lerp, RMISSD, ROCP, temp_at_mixrat, qc, DewFromTRh,
  mean_rh_in_layer, GetCapeColor, CToF, UpdateCSMotStorm, UpdatePresets, VaporPressure, FtoC,
  GetAngleFromVector, theta
} from "../calc/skewtCalcs.js";
import { ConvertToRaw, ln, lerp, noop, arrayIndex, absoluteValue } from '../io/general.js';

import { computeWindParams } from '../calc/params.js';
import { Process } from '../io/sharppy.js';
import { exportSounding } from '../io/export.js';
import { DISPLAY_VERSION } from '../version.js';

import numbs from '../data/climo/Cases.js';
import numbs2 from '../data/climo/CasesEF2.js';

// Tornado side-panel percentile tables (~2 MB) load on first use in Tornado mode, not with
// the page. Cases*.js above stay static: the bounds check needs them synchronously.
// The cache is shared by every chart on the page.
let tornadoClimo = null;
let tornadoClimoLoading = null;
const HODO_MAP_TILE_SIZE = 256;
const HODO_MAP_ZOOM = 5;
const HODO_MAP_TILE_URL = 'https://tile.openstreetmap.org';
const hodographMapTiles = new Map();

/**
 * Begins, traces, and strokes a single line.
 * @param {CanvasRenderingContext2D} ctx Canvas drawing context.
 * @param {number} x1 Starting x-coordinate.
 * @param {number} y1 Starting y-coordinate.
 * @param {number} x2 Ending x-coordinate.
 * @param {number} y2 Ending y-coordinate.
 * @returns {void}
 */
function strokeCanvasLine(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Begins, traces, and optionally closes, strokes, and fills a path.
 * @param {CanvasRenderingContext2D} ctx Canvas drawing context.
 * @param {Array<{x: number, y: number}>} points Points in drawing order.
 * @param {boolean} closePath Whether to close the path.
 * @param {boolean} stroke Whether to stroke the path.
 * @param {boolean} fill Whether to fill the path.
 * @returns {void}
 */
function drawCanvasPath(ctx, points, closePath = false, stroke = true, fill = false) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (closePath) ctx.closePath();
  if (stroke) ctx.stroke();
  if (fill) ctx.fill();
}

/**
 * Begins and strokes independent line segments in a single canvas path.
 * @param {CanvasRenderingContext2D} ctx Canvas drawing context.
 * @param {Array<[number, number, number, number]>} segments [x1, y1, x2, y2] segments.
 * @returns {void}
 */
function strokeCanvasSegments(ctx, segments) {
  if (!segments.length) return;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

/**
 * Projects latitude and longitude into Web Mercator world pixels.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @param {number} zoom Slippy-map zoom level.
 * @returns {{x:number, y:number}} Projected world-pixel coordinates.
 */
function projectHodographMapCoordinate(lat, lon, zoom) {
  const worldSize = HODO_MAP_TILE_SIZE * (2 ** zoom);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sinLat = Math.sin(clampedLat * Math.PI / 180);
  return {
    x: ((lon + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
  };
}

/**
 * Loads or retrieves a cached OpenStreetMap tile.
 * @param {number} zoom Slippy-map zoom level.
 * @param {number} x Tile x-coordinate before world wrapping.
 * @param {number} y Tile y-coordinate.
 * @param {Window} view Window that supplies the Image constructor.
 * @param {() => void} onReady Schedules a hodograph redraw after loading completes.
 * @returns {{image:HTMLImageElement|null, state:string}} Tile image and load state.
 */
function getHodographMapTile(zoom, x, y, view, onReady) {
  const tileCount = 2 ** zoom;
  if (y < 0 || y >= tileCount) return { image: null, state: 'outside' };
  const wrappedX = ((x % tileCount) + tileCount) % tileCount;
  const key = `${zoom}/${wrappedX}/${y}`;
  let tile = hodographMapTiles.get(key);
  if (tile) {
    if (tile.state === 'loading') tile.listeners.add(onReady);
    return tile;
  }

  const ImageConstructor = view?.Image;
  if (!ImageConstructor) return { image: null, state: 'unavailable' };

  tile = { image: new ImageConstructor(), state: 'loading', listeners: new Set([onReady]) };
  hodographMapTiles.set(key, tile);
  tile.image.crossOrigin = 'anonymous';
  tile.image.onload = () => {
    tile.state = 'loaded';
    for (const listener of tile.listeners) listener();
    tile.listeners.clear();
  };
  tile.image.onerror = () => {
    tile.state = 'error';
    for (const listener of tile.listeners) listener();
    tile.listeners.clear();
  };
  tile.image.src = `${HODO_MAP_TILE_URL}/${zoom}/${wrappedX}/${y}.png`;
  return tile;
}

/**
 * Draws an OpenStreetMap inset centered on a sounding's coordinates.
 * OpenStreetMap tiles include mapped state and county administrative boundaries.
 * @param {CanvasRenderingContext2D} ctx Hodograph drawing context.
 * @param {HTMLCanvasElement} canvas Hodograph canvas.
 * @param {object} sounding Current sounding object.
 * @param {() => void} onTilesReady Schedules a redraw when pending tiles finish.
 * @param {{x:number,y:number,width:number,height:number}} [bounds] Optional inset bounds.
 * @returns {void}
 */
function drawHodographLocationInset(ctx, canvas, sounding, onTilesReady, bounds) {
  const location = sounding?.Coords;
  const lat = Number(location?.lat ?? sounding?.Location?.[0]);
  const lon = Number(location?.lon ?? sounding?.Location?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

  const insetWidth = bounds?.width ?? 200;
  const insetHeight = bounds?.height ?? 200;
  const insetX = bounds?.x ?? canvas.width - insetWidth;
  const insetY = bounds?.y ?? canvas.height - insetHeight;
  const center = projectHodographMapCoordinate(lat, lon, HODO_MAP_ZOOM);
  const north = projectHodographMapCoordinate(Math.min(85.05112878, lat + 2.5), lon, HODO_MAP_ZOOM);
  const south = projectHodographMapCoordinate(Math.max(-85.05112878, lat - 2.5), lon, HODO_MAP_ZOOM);
  const worldSpanY = Math.max(
    HODO_MAP_TILE_SIZE * (2 ** HODO_MAP_ZOOM) * (5 / 360),
    south.y - north.y,
  );
  const worldSpanX = worldSpanY * insetWidth / insetHeight;
  const scale = insetHeight / worldSpanY;
  const left = center.x - worldSpanX / 2;
  const top = center.y - worldSpanY / 2;
  const firstTileX = Math.floor(left / HODO_MAP_TILE_SIZE);
  const lastTileX = Math.floor((left + worldSpanX) / HODO_MAP_TILE_SIZE);
  const firstTileY = Math.floor(top / HODO_MAP_TILE_SIZE);
  const lastTileY = Math.floor((top + worldSpanY) / HODO_MAP_TILE_SIZE);
  let failedTiles = 0;
  let loadedTiles = 0;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#17232c';
  ctx.fillRect(insetX, insetY, insetWidth, insetHeight);
  ctx.beginPath();
  ctx.rect(insetX, insetY, insetWidth, insetHeight);
  ctx.clip();

  for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
    for (let tileX = firstTileX; tileX <= lastTileX; tileX++) {
      const tile = getHodographMapTile(HODO_MAP_ZOOM, tileX, tileY, canvas.ownerDocument.defaultView, onTilesReady);
      if (tile.state === 'loaded' && tile.image) {
        const x = insetX + (tileX * HODO_MAP_TILE_SIZE - left) * scale;
        const y = insetY + (tileY * HODO_MAP_TILE_SIZE - top) * scale;
        const size = HODO_MAP_TILE_SIZE * scale;
        ctx.drawImage(tile.image, x, y, size, size);
        loadedTiles++;
      } else if (tile.state === 'error' || tile.state === 'unavailable') {
        failedTiles++;
      }
    }
  }

  ctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (loadedTiles === 0 && failedTiles > 0) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(insetX, insetY, insetWidth, insetHeight);
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Map unavailable', insetX + insetWidth / 2, insetY + insetHeight / 2);
  }
  ctx.beginPath();
  ctx.arc(insetX + insetWidth / 2, insetY + insetHeight / 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#f04438';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(insetX + 1, insetY + 1, insetWidth - 2, insetHeight - 2);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(insetX + insetWidth - 27, insetY + insetHeight - 12, 25, 10);
  ctx.fillStyle = '#fff';
  ctx.font = '7px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('© OSM', insetX + insetWidth - 4, insetY + insetHeight - 4);
  ctx.restore();
}

/** Lazily loads and caches tornado climatology tables.
 * @returns {*} Result of the function.
 */
function loadTornadoClimo() {
  tornadoClimoLoading ??= Promise.all([
    import('../data/climo/EffSRHClimo.js'),
    import('../data/climo/STPFClimo.js'),
    import('../data/climo/EffShearClimo.js'),
    import('../data/climo/MLCapeClimo.js'),
    import('../data/climo/EffSRHClimoEF2.js'),
    import('../data/climo/STPFClimoEF2.js'),
    import('../data/climo/EffShearClimoEF2.js'),
    import('../data/climo/MLCapeClimoEF2.js'),
  ]).then(([effsrhc, stpfc, effshrc, mlcapec, effsrhc2, stpfc2, effshrc2, mlcapec2]) => {
    tornadoClimo = {
      effsrhc: effsrhc.default, stpfc: stpfc.default, effshrc: effshrc.default, mlcapec: mlcapec.default,
      effsrhc2: effsrhc2.default, stpfc2: stpfc2.default, effshrc2: effshrc2.default, mlcapec2: mlcapec2.default,
    };
    return tornadoClimo;
  }).catch((err) => {
    tornadoClimoLoading = null; // allow a retry on the next draw
    throw err;
  });
  return tornadoClimoLoading;
}

/**
 * @param {HTMLElement} root  element containing the chart markup from viewer/template.js
 * @param {object} [options]
 * @param {string} [options.brandLabel]  host label drawn before "powered by SharpJS" (e.g. "example.com")
 * @param {string} [options.savedBy]     "Saved by:" line in exported text
 * @param {string} [options.filePrefix]  exported file name prefix
 * @param {(event: string, detail?: any) => void} [options.emit]  state-change notifications

 * @returns {*} Result of the function.
 */
export function createEngine(root, options = {}) {
// ---------------------------------------------------------------------------------------------
// Everything below is per-chart state and behaviour. It keeps the layout of the original
// single-file script so changes can be compared side by side with older SharpJS builds.
// ---------------------------------------------------------------------------------------------
const elementCache = new Map();
/** Root-scoped replacement for document.getElementById (elements carry data-sjs="<id>").
 * @param {*} id Parameter for $.
 * @returns {*} Result of the function.
 */
function $(id) {
  let el = elementCache.get(id);
  if (!el || !el.isConnected) {
    el = root.querySelector(`[data-sjs="${id}"]`);
    if (el) elementCache.set(id, el);
  }
  return el;
}
const emit = typeof options.emit === 'function' ? options.emit : noop;

const globalFont = options.font || '"IBM Plex Sans", "Segoe UI", Roboto, Arial, sans-serif';
const verString = DISPLAY_VERSION;
/** "SharpJS v1.7", or "<label><sep>SharpJS v1.7" when the host sets options.brandLabel.
 * @param {*} sep Parameter for brandLine.
 * @returns {*} Result of the function.
 */
function brandLine(sep) {
  const label = typeof options.brandLabel === 'string' ? options.brandLabel.trim() : '';
  return label ? `${label}${sep}SharpJS v${verString}` : `SharpJS v${verString}`;
}

var skv = {};
const marginTop = 30;//30;
const marginBottom = 15;
const marginLeft = 30;
const marginRight = 45;
skv.tlx = marginLeft;
skv.tly = marginTop;
skv.brx = 800;
skv.bry = 800;
skv.hspread = 90;
skv.vspread = 70;
skv.brtemp = 50;
skv.type = 1;
skv.font = `10px ${globalFont}`;
skv.pbot = 1100;
skv.ptop = 100;
skv.plevels = new Array(1000, 850, 700, 500, 400, 300, 200, 100);
skv.tleft = -50;
skv.tspread = 102;

const DEFAULT_PBOT = 1100;
const DEFAULT_PTOP = 100;
const DEFAULT_TLEFT = -50;
const DEFAULT_TSPREAD = 102;
/** Keep enough vertical span that skew-T isotherm/adiabat geometry stays readable. */
const MIN_PRESSURE_SPAN = 400;
const MIN_TEMP_SPREAD = 60;
/**
 * log-P mapping is undefined at 0. Never fit or draw against ptop/pres <= 0
 * or the entire skew-T collapses onto the bottom edge.
 */
const MIN_PTOP = 50;
const MIN_VALID_PRES_MB = 20;
const MAX_VALID_PRES_MB = 1100;

//Why
var PRESSURE_LABEL_CANDIDATES = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 50];
var PRESSURE_TOP_CANDIDATES = [850, 700, 500, 400, 300, 250, 200, 150, 100, 50];

/** Checks is valid sounding pressure.
 * @param {*} p Parameter for isValidSoundingPressure.
 * @returns {*} Result of the function.
 */
function isValidSoundingPressure(p) {
  return Number.isFinite(p) && p >= MIN_VALID_PRES_MB && p <= MAX_VALID_PRES_MB;
}

/** Get the top layer for pressure
 * @param {*} desiredTop Parameter for pickPressureTop.
 * @param {*} observedTop Parameter for pickPressureTop.
 * @returns {*} Result of the function.
 */
function pickPressureTop(desiredTop, observedTop) {
  const usable = (p) => Number.isFinite(p) && p >= MIN_PTOP && p < DEFAULT_PBOT;
  let ptop = PRESSURE_TOP_CANDIDATES.find((p) => usable(p) && p <= desiredTop) ?? DEFAULT_PTOP;
  if (ptop >= observedTop) {
    ptop = PRESSURE_TOP_CANDIDATES.find((p) => usable(p) && p < observedTop)
      ?? Math.max(MIN_PTOP, Math.min(DEFAULT_PTOP, observedTop - 25));
  }
  return ptop;
}

/** Quality Check
 * @param {*} val Parameter for tqc.
 * @returns {*} Result of the function.
 */
function tqc(val){
  if (val < -998.0 || val > 2.0E+05 || isNaN(val)) return 0;
  return 1;
}
/**
 * 0 = default
 * 1 = metric
 * 2 = imperal
 */
let useImperialUnits = 0;

/** Returns position scale data.
 * @param {*} x Parameter for GetPositionScale.
 * @param {*} y Parameter for GetPositionScale.
 * @param {*} canvas Parameter for GetPositionScale.
 * @returns {*} Result of the function.
 */
function GetPositionScale(x, y, canvas) {
  return { x: (x / 100) * canvas.width, y: (y / 100) * canvas.height };
}

/** Identifies a dropsonde sounding from its metadata.
 * @param {*} soundingObj Parameter for isDropsondeSounding.
 * @returns {*} Result of the function.
 */
function isDropsondeSounding(soundingObj) {
  if (!soundingObj) return false;
  if (soundingObj.isDropsonde === true) return true;
  const title = `${soundingObj.STitle || ''} ${soundingObj.Title || ''}`;
  return /dropsonde|·\s*drop\b/i.test(title);
}

/** Dropsonde surface/splash MSLP (mb), from payload or reduced from SFC level.
 * @param {*} soundingObj Parameter for resolveDropsondeMslpMb.
 * @param {*} startSlice Parameter for resolveDropsondeMslpMb.
 * @returns {*} Result of the function.
 */
function resolveDropsondeMslpMb(soundingObj, startSlice) {
  if (!isDropsondeSounding(soundingObj)) return null;

  const reported = Number(soundingObj.mslpMb);
  if (Number.isFinite(reported) && reported >= 850 && reported <= 1100) {
    return Math.round(reported);
  }

  if (!startSlice || !qc(startSlice.P)) return null;
  const p = startSlice.P;
  const z = qc(startSlice.H) ? startSlice.H : 0;
  if (z < 15) {
    return p >= 850 && p <= 1100 ? Math.round(p) : null;
  }

  // Hypsometric reduction (same approach as recon MSLP estimate).
  const RD = 287.05;
  const G0 = 9.80665;
  const GAMMA = 0.0065;
  let tFlK;
  if (qc(startSlice.T) && startSlice.T > -90 && startSlice.T < 50) {
    tFlK = startSlice.T + 273.15;
  } else {
    tFlK = Math.max(200, 288.15 - GAMMA * z);
  }
  const tMeanK = tFlK + (GAMMA * z) / 2;
  if (!(tMeanK > 180 && tMeanK < 340)) return null;
  const mslp = p * Math.exp(z / ((RD * tMeanK) / G0));
  if (!(mslp >= 850 && mslp <= 1100)) return null;
  return Math.round(mslp);
}

/** Restores the default skew-T pressure and temperature domains.
 * @returns {void} No value.
 */
function resetSkewTDomains() {
  skv.pbot = DEFAULT_PBOT;
  skv.ptop = DEFAULT_PTOP;
  skv.plevels = PRESSURE_LABEL_CANDIDATES.filter((p) => p < skv.pbot && p >= skv.ptop);
  skv.tleft = DEFAULT_TLEFT;
  skv.tspread = DEFAULT_TSPREAD;
}

/** Finds the valid pressure range in a sounding.
 * @param {*} soundingObj Parameter for getSoundingPressureExtents.
 * @returns {*} Result of the function.
 */
function getSoundingPressureExtents(soundingObj) {
  const sound = soundingObj && soundingObj.Sounding;
  if (!sound) return null;

  let sfcP = null;
  let topP = null;
  const consider = (raw) => {
    const p = Number(raw);
    if (!isValidSoundingPressure(p)) return;
    sfcP = sfcP == null ? p : Math.max(sfcP, p);
    topP = topP == null ? p : Math.min(topP, p);
  };

  if (Array.isArray(sound.P) && sound.P.length > 0) {
    sound.P.forEach(consider);
  } else if (Array.isArray(sound.Slice)) {
    sound.Slice.forEach((slice) => consider(slice && slice[0]));
  }

  if (sfcP == null || topP == null) return null;
  return { sfcP, topP };
}

/**
 * Dropsonde-only: trim empty upper levels, keep classic bottom (1100)
 * and a wide enough span so the skew geometry doesn't collapse.
 * Chart top tracks the sounding top (e.g. ~175 mb → 150 mb, not 100 mb).

 * @param {*} primarySounding Parameter for setPressureDomainFromSounding.
 * @param {*} comparisonSoundings Parameter for setPressureDomainFromSounding.
 * @returns {void} No value.
 */
function setPressureDomainFromSounding(primarySounding, comparisonSoundings = []) {
  let sfcP = null;
  let topP = null;


  const consider = (snd) => {
    const ext = getSoundingPressureExtents(snd);
    if (!ext) return;
    sfcP = sfcP == null ? ext.sfcP : Math.max(sfcP, ext.sfcP);
    topP = topP == null ? ext.topP : Math.min(topP, ext.topP);
  };

  consider(primarySounding);
  if (Array.isArray(comparisonSoundings)) {
    comparisonSoundings.forEach((comp) => {
      if (comp && comp.sounding) consider(comp.sounding);
      else consider(comp);
    });
  }

  if (sfcP == null || topP == null || !(sfcP > topP)) {
    skv.pbot = DEFAULT_PBOT;
    skv.ptop = DEFAULT_PTOP;
    skv.plevels = PRESSURE_LABEL_CANDIDATES.filter((p) => p < skv.pbot && p >= skv.ptop);
    return;
  }

  const pbot = DEFAULT_PBOT;

  // Modest pad above the highest observation so the profile isn't glued to the top.
  const pad = topP >= 700 ? 75 : topP >= 400 ? 40 : 25;
  const desiredTop = topP - pad;

  let ptop = pickPressureTop(desiredTop, topP);

  // Never zoom in so far that skew angles look wrong.
  const maxPtop = pbot - MIN_PRESSURE_SPAN; // e.g. 700 mb
  if (ptop > maxPtop) ptop = maxPtop;

  if (!(ptop > 0 && ptop < pbot)) {
    ptop = DEFAULT_PTOP;
  }

  skv.pbot = pbot;
  skv.ptop = ptop;
  skv.plevels = PRESSURE_LABEL_CANDIDATES.filter((p) => p < pbot && p >= ptop);
  if (skv.plevels.length === 0) {
    skv.plevels = [Math.round((pbot + ptop) / 2)];
  }
}

/**
 * Dropsonde-only: fit the temperature axis to observed T so tropical
 * profiles sit in the middle of the chart instead of the warm edge.

 * @param {*} primarySounding Parameter for setTemperatureDomainFromSounding.
 * @returns {void} No value.
 */
function setTemperatureDomainFromSounding(primarySounding) {
  const sound = primarySounding && primarySounding.Sounding;
  const temps = Array.isArray(sound?.T)
    ? sound.T.filter((t) => Number.isFinite(t) && t > -90 && t < 55)
    : [];
  const minT = temps.length ? Math.min(...temps) : 0;
  const maxT = temps.length ? Math.max(...temps) : 30;

  let tleft = Math.floor((minT - 8) / 10) * 10;
  tleft = Math.max(-50, Math.min(0, tleft));

  let tright = Math.ceil((maxT + 10) / 10) * 10;
  tright = Math.max(40, tright, tleft + MIN_TEMP_SPREAD);
  tright = Math.min(50, tright);
  if (tright - tleft < MIN_TEMP_SPREAD) {
    tleft = Math.max(-50, tright - MIN_TEMP_SPREAD);
  }

  skv.tleft = tleft;
  skv.tspread = tright - tleft;
}

/** Apply dropsonde-only chart fitting; restore classic domains otherwise.
 * @param {*} primarySounding Parameter for setSkewTDomainsFromSounding.
 * @param {*} comparisonSoundings Parameter for setSkewTDomainsFromSounding.
 * @returns {void} No value.
 */
function setSkewTDomainsFromSounding(primarySounding, comparisonSoundings = []) {
  if (!isDropsondeSounding(primarySounding)) {
    PRESSURE_LABEL_CANDIDATES = [1000, 825, 700, 500, 300, 200, 100, 50];
    PRESSURE_TOP_CANDIDATES = [1000, 100, 50];
    // Normal soundings use the user's skew; dropsondes below force a low skew.
    SkewNumber = UserSkewNumber;
    resetSkewTDomains();
    return;
  }

  //Set settings stuff
  PRESSURE_LABEL_CANDIDATES = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 50];
  PRESSURE_TOP_CANDIDATES = [1000, 900, 800, 700, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100, 50];
  // Low skew (same as the "Low" control). 0.9 slammed tropical T/Td off the right edge.
  SkewNumber = 0.5;

  setPressureDomainFromSounding(primarySounding, comparisonSoundings);
  setTemperatureDomainFromSounding(primarySounding);
}

/** Logarithmic pressure scale for skew-T mapping. Returns null if the inputs are invalid.
 * @param {*} pbot Parameter for logPressureScale.
 * @param {*} ptop Parameter for logPressureScale.
 * @returns {*} Result of the function.
 */
function logPressureScale(pbot, ptop) {
  if (!(pbot > 0) || !(ptop > 0) || !(pbot > ptop)) return null;
  return Math.log(pbot) - Math.log(ptop);
}

/** Convert pressure to pixel coordinates.
 * @param {*} pres Parameter for pres_to_pix.
 * @returns {*} Result of the function.
 */
function pres_to_pix(pres) {
  var scl1 = logPressureScale(skv.pbot, skv.ptop);
  if (scl1 == null || !(pres > 0)) return skv.bry;
  var scl2 = Math.log(skv.pbot) - Math.log(pres);
  return (skv.bry - (scl2 / scl1) * (skv.bry - skv.tly));
}

/** Convert pixel coordinates to pressure.
 * @param {*} y Parameter for pix_to_pres.
 * @returns {*} Result of the function.
 */
function pix_to_pres(y) {
  var scl1 = logPressureScale(skv.pbot, skv.ptop);
  if (scl1 == null) return skv.pbot;
  var scl2 = skv.bry - y;
  var scl3 = skv.bry - skv.tly + 1;
  return (skv.pbot / Math.exp((scl2 / scl3) * scl1));
}

/** Convert pressure to skew-T skew coordinates (0 → 1).
 * @param {*} N Parameter for PressuretoSkew.
 * @param {*} BP Parameter for PressuretoSkew.
 * @returns {*} Result of the function.
 */
function PressuretoSkew(N, BP) {
  var scl1 = logPressureScale(skv.pbot, skv.ptop);
  if (scl1 == null || !(N > 0) || !(skv.bry > 0)) return 1;
  var scl2 = Math.log(skv.pbot) - Math.log(N);
  return (skv.bry - (scl2 / scl1) * (skv.bry - skv.tly)) / skv.bry;
}

var SkewNumber = 0.75;
/** The skew the user picked (SkewNumber can be overridden per sounding, e.g. dropsondes). */
var UserSkewNumber = 0.75;
/** Convert a level to horizontal skew position
 * @param {*} N Parameter for LevelToSkewNum.
 * @param {*} BP Parameter for LevelToSkewNum.
 * @returns {*} Result of the function.
 */
function LevelToSkewNum(N, BP) {
  return SkewNumber - SkewNumber * Lerp(0, 1, PressuretoSkew(N));
}

var LapseType = false;

const SKEW_STEPS = [0.5, 0.625, 0.75, 0.825];

/** Cycle the skew-T skew (Low → Medium → Default → High), or just redraw with Change=false.
 * @param {*} Change Parameter for ChangeStateSkewTSkew.
 * @returns {*} Result of the function.
 */
function ChangeStateSkewTSkew(Change = true) {
  if (Change) {
    const i = SKEW_STEPS.indexOf(UserSkewNumber);
    UserSkewNumber = SKEW_STEPS[(i + 1) % SKEW_STEPS.length];
    SkewNumber = UserSkewNumber;
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  }
  return UserSkewNumber;
}

/** Convert meters to feet.
 * @param {*} N Parameter for MToFt.
 * @returns {*} Result of the function.
 */
function MToFt(N) {
  return N * 3.28084;
}

/** Convert knots to miles per hour.
 * @param {*} N Parameter for KtsToMph.
 * @returns {*} Result of the function.
 */
function KtsToMph(N) {
  return N * 1.15078;
}

/** Convert degrees Celsius per kilometer to degrees Celsius per thousand feet.
 * @param {*} N Parameter for CPerKmToCPerKft.
 * @returns {*} Result of the function.
 */
function CPerKmToCPerKft(N) {
  return N / 3.28084;
}

var HodographScaleMulti = 1.0;
var OutsideFitBase = 0;

// Viridis-like colortable (low → high)
const HODO_COLORS = [
  "#ffffff",
  "#5c3dff",
  "#2f8cff",
  "#00c8b4",
  "#79f04b",
  "#04ff1f",
  "#ffb000",
  "#ff6a00",
  "#ff0000"
];

// Convert hex → RGB
/** Convert a hex color to RGB values.
 * @param {*} hex Parameter for hexToRgb.
 * @returns {*} Result of the function.
 */
function hexToRgb(hex) {
  const bigint = parseInt(hex.slice(1), 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
}

// Convert RGB → hex
/** Convert RGB values to a hex color.
 * @param {*} r Parameter for rgbToHex.
 * @param {*} g Parameter for rgbToHex.
 * @param {*} b Parameter for rgbToHex.
 * @returns {*} Result of the function.
 */
function rgbToHex(r, g, b) {
  return "#" + [r, g, b]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

// NEXRAD VWP RMS on hodograph: strict errKt→px matches vector units but reads smaller than common VAD/AWIPS-style displays (~2× is typical visual envelope).
const VWP_HODOGRAPH_RMS_RADIUS_SCALE = 1.3;
const VWP_HODOGRAPH_RMS_FILL_ALPHA = 0.15;

/** Returns hodograph color data.
 * @param {*} Hght Parameter for GetHodographColor.
 * @param {*} ctx Parameter for GetHodographColor.
 * @param {*} trans Parameter for GetHodographColor.
 * @returns {*} Result of the function.
 */
function GetHodographColor(Hght, ctx, trans=1) {
  if (HodographColorTable == 0) {
    if (Hght <= 1000) {
      return `rgba(225,0,225,${trans})`;
    } else if (Hght <= 3000 && Hght > 1000) {
      return `rgba(225,0,0,${trans})`;
    } else if (Hght <= 6000 && Hght > 3000) {
      return `rgba(0,225,0,${trans})`;
    } else if (Hght <= 9000 && Hght > 6000) {
      return `rgba(225,225,0,${trans})`;
    } else if (Hght <= 12000 && Hght > 9000) {
      return `rgba(0,225,225,${trans})`;
    }
  } else if (HodographColorTable == 1) {
    if (Hght <= 1000) {
      return `rgba(128,0,128,${trans})`;
    } else if (Hght <= 3000 && Hght > 1000) {
      return `rgba(255,0,0,${trans})`;
    } else if (Hght <= 6000 && Hght > 3000) {
      return `rgba(255,140,0,${trans})`;
    } else if (Hght <= 9000 && Hght > 6000) {
      return `rgba(255,215,0,${trans})`;
    } else if (Hght <= 12000 && Hght > 9000) {
      return `rgba(255,240,159,${trans})`;
    }
  } else if (HodographColorTable == 2) {
    const maxHeight = 12000;
    const clamped = Math.max(0, Math.min(Hght, maxHeight));

    const scaled = (clamped / maxHeight) * (HODO_COLORS.length - 1);

    const lowerIndex = Math.floor(scaled);
    const upperIndex = Math.ceil(scaled);
    const t = scaled - lowerIndex;

    if (lowerIndex === upperIndex) {
      return HODO_COLORS[lowerIndex];
    }

    const c1 = hexToRgb(HODO_COLORS[lowerIndex]);
    const c2 = hexToRgb(HODO_COLORS[upperIndex]);

    const r = Math.round(lerp(c1.r, c2.r, t));
    const g = Math.round(lerp(c1.g, c2.g, t));
    const b = Math.round(lerp(c1.b, c2.b, t));

    return `rgba(${r}, ${g}, ${b}, ${trans})`;
  } else if (HodographColorTable == 3) {
    const N = Hght * 205 / 12000 + 50;

    return `rgba(${N}, ${N}, ${N}, ${trans})`;
  }
}

let mapImage = null;
let hodographDrawVersion = 0;
let hodographMapRedrawFrame = null;
let hodographMapRedrawRequest = null;

// --- ADD THIS EXPORT FUNCTION ---
/** Sets or applies map image state.
 * @param {*} img Parameter for SetMapImage.
 * @returns {void} No value.
 */
function SetMapImage(img) {
  mapImage = img;
}

/**
 * Schedules one redraw after one or more map tiles finish loading.
 * @param {object} sounding Sounding currently being drawn.
 * @param {boolean} ghost Whether this is a ghost sounding redraw.
 * @param {object[]} comparisonSoundings Comparison soundings for the current chart.
 * @param {number} drawVersion Version of the hodograph render that requested tiles.
 * @returns {void}
 */
function scheduleHodographMapRedraw(sounding, ghost, comparisonSoundings, drawVersion) {
  hodographMapRedrawRequest = { sounding, ghost, comparisonSoundings, drawVersion };
  if (hodographMapRedrawFrame !== null) return;
  const view = root.ownerDocument.defaultView;
  hodographMapRedrawFrame = view.requestAnimationFrame(() => {
    hodographMapRedrawFrame = null;
    const request = hodographMapRedrawRequest;
    hodographMapRedrawRequest = null;
    if (!request || request.drawVersion !== hodographDrawVersion) return;
    DrawHodograph(request.sounding, request.ghost, request.comparisonSoundings);
  });
}

/** User preference: thin RAOB/import hodograph to SPC-like spacing (default on). Model grid rules unchanged. */
let HodographTrimWindProfile = true;

/**
 * Model grid soundings (sounding.meta.isModel) already have modest vertical resolution on the hodograph.
 * RAOB / IMET / uploaded profiles often have hundreds of wind levels — thin to SPC-like spacing
 * so the hodograph shows bulk shear instead of instrument noise.

 * @param {*} meta Parameter for shouldThinHodographForDisplay.
 * @returns {*} Result of the function.
 */
function shouldThinHodographForDisplay(meta) {
  if (VWPActive) return false;
  if (!meta || meta.WWL < 2) return false;
  const st = meta.STitle || '';
  const low = st.toLowerCase();
  const isModelAgua = meta.isModel === true || (meta.meta && meta.meta.isModel === true);

  if (!HodographTrimWindProfile) {
    if (isModelAgua) {
      if (meta.WWL <= 90) return false;
      return meta.WWL > 90;
    }
    return false;
  }

  if (isModelAgua && meta.WWL <= 90) return false;
  if (/radiosonde|raob|upper.?air|imet|sonde|balloon|pibal/.test(low)) return true;
  if (!isModelAgua) return true;
  return meta.WWL > 90;
}

/** Get the minimum height step for a given altitude.
 * @param {*} aglM Parameter for minHeightStepForAglHodo.
 * @returns {*} Result of the function.
 */
function minHeightStepForAglHodo(aglM) {
  if (aglM < 2200) return 190;
  if (aglM < 6000) return 320;
  return 520;
}

/**
 * @returns {number[] | null} Indices into W[] (ascending height) for endpoints of hodograph segments, or null to use full resolution.

 * @param {*} W Parameter for computeThinnedHodographWindIndices.
 * @param {*} SH Parameter for computeThinnedHodographWindIndices.
 * @param {*} maxAglM Parameter for computeThinnedHodographWindIndices.
 */
function computeThinnedHodographWindIndices(W, SH, maxAglM = 12000) {
  const n = W.length;
  if (n < 2) return null;

  let start = -1;
  for (let i = 0; i < n; i++) {
    const w = W[i];
    if (w.WS !== -9999 && w.WD !== -9999 && !isNaN(w.WS) && !isNaN(w.WD) && w.H - SH < maxAglM) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const idx = [start];
  let last = start;

  for (let i = start + 1; i < n; i++) {
    const w = W[i];
    if (w.WS === -9999 || w.WD === -9999 || isNaN(w.WS) || isNaN(w.WD)) continue;
    if (w.H - SH >= maxAglM) break;

    const aglLast = W[last].H - SH;
    const dh = w.H - W[last].H;
    const minD = minHeightStepForAglHodo(aglLast);
    if (dh >= minD) {
      idx.push(i);
      last = i;
    }
  }

  let top = last;
  for (let j = last + 1; j < n; j++) {
    const w = W[j];
    if (w.WS === -9999 || w.WD === -9999 || isNaN(w.WS) || isNaN(w.WD)) continue;
    if (w.H - SH >= maxAglM) break;
    top = j;
  }
  if (top > idx[idx.length - 1]) {
    idx.push(top);
  }

  return idx.length >= 2 ? idx : null;
}

/** Returns hodograph wind step indices data.
 * @param {*} meta Parameter for getHodographWindStepIndices.
 * @param {*} W Parameter for getHodographWindStepIndices.
 * @param {*} SH Parameter for getHodographWindStepIndices.
 * @returns {*} Result of the function.
 */
function getHodographWindStepIndices(meta, W, SH) {
  if (!shouldThinHodographForDisplay(meta)) return null;
  return computeThinnedHodographWindIndices(W, SH);
}

/** Builds adjacent sounding-index pairs for hodograph segments.
 * @param {*} WWL Parameter for hodographSegmentIndexPairs.
 * @param {*} stepIdx Parameter for hodographSegmentIndexPairs.
 * @returns {*} Result of the function.
 */
function hodographSegmentIndexPairs(WWL, stepIdx) {
  if (stepIdx && stepIdx.length >= 2) {
    const out = [];
    for (let j = 0; j < stepIdx.length - 1; j++) {
      out.push([stepIdx[j], stepIdx[j + 1]]);
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < WWL - 1; i++) {
    out.push([i, i + 1]);
  }
  return out;
}

/** Returns hodograph storm offset mod data.
 * @returns {*} Result of the function.
 */
function getHodographStormOffsetMod() {
  if (!HodoMode) {
    return {
      x: isNaN(CSMot.x) ? 0 : -CSMot.x,
      y: isNaN(CSMot.y) ? 0 : CSMot.y,
    };
  }
  return { x: 0, y: 0 };
}

/** Converts wind data to canvas coordinates.
 * @param {*} Center Parameter for hodographWindToCanvas.
 * @param {*} Scale Parameter for hodographWindToCanvas.
 * @param {*} slice Parameter for hodographWindToCanvas.
 * @returns {*} Result of the function.
 */
function hodographWindToCanvas(Center, Scale, slice) {
  let Pos = ConvertPolartoCart(slice);
  if (!HodoMode) {
    Pos.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
    Pos.y += isNaN(CSMot.y) ? 0 : CSMot.y;
  }
  return {
    x: Center.x / 2 + Pos.x * (Scale / 10),
    y: Center.y / 2 + Pos.y * (Scale / 10),
  };
}

/** Converts storm motion data to canvas coordinates.
 * @param {*} Center Parameter for hodographStormMotionToCanvas.
 * @param {*} Scale Parameter for hodographStormMotionToCanvas.
 * @param {*} Mod Parameter for hodographStormMotionToCanvas.
 * @returns {*} Result of the function.
 */
function hodographStormMotionToCanvas(Center, Scale, Mod) {
  const mx = isNaN(CSMot.x) ? 0 : CSMot.x;
  const my = isNaN(CSMot.y) ? 0 : CSMot.y;
  return {
    x: Center.x / 2 + (Mod.x + mx) * (Scale / 10),
    y: Center.y / 2 + (Mod.y - my) * (Scale / 10),
  };
}

/** Checks whether a wind level has valid height and wind data.
 * @param {*} slice Parameter for isUsableHodographWind.
 * @returns {*} Result of the function.
 */
function isUsableHodographWind(slice) {
  return slice &&
    slice.WS !== -9999 &&
    slice.WD !== -9999 &&
    !isNaN(slice.WS) &&
    !isNaN(slice.WD);
}

/** Resolves the layer bounds used for hodograph SRH shading.
 * @param {*} Sounding Parameter for resolveHodographSrhFillLayer.
 * @param {*} inflow Parameter for resolveHodographSrhFillLayer.
 * @returns {*} Result of the function.
 */
function resolveHodographSrhFillLayer(Sounding, inflow) {
  if (!Sounding) return null;
  const sfc = GetLayerByHght(Sounding, "SFC");
  if (inflow && inflow !== false && inflow.Top != null && inflow.Top !== 999 && inflow.Bot) {
    const bot = inflow.isSfc === true ? GetLayerByPres(Sounding, "SFC") : GetLayerByPres(Sounding, inflow.Bot);
    const top = GetLayerByPres(Sounding, inflow.Top);
    if (bot && top && isUsableHodographWind(bot) && isUsableHodographWind(top) && top.H > bot.H) {
      return { bot, top };
    }
  }
  return null;
}

/**
 * Shade the area swept between the selected storm motion (RM by default)
 * and the hodograph curve. Uses effective inflow when it exists, else 0-3 km.

 * @param {*} ctx Parameter for drawHodographStormMotionFill.
 * @param {*} Sounding Parameter for drawHodographStormMotionFill.
 * @param {*} Center Parameter for drawHodographStormMotionFill.
 * @param {*} Scale Parameter for drawHodographStormMotionFill.
 * @param {*} Mod Parameter for drawHodographStormMotionFill.
 * @param {*} W Parameter for drawHodographStormMotionFill.
 * @param {*} stepIdx Parameter for drawHodographStormMotionFill.
 * @param {*} inflow Parameter for drawHodographStormMotionFill.
 * @returns {void} No value.
 */
function drawHodographStormMotionFill(ctx, Sounding, Center, Scale, Mod, W, stepIdx, inflow) {
  if (!ctx || !Sounding || !W || !W.length) return;
  if (isNaN(CSMot.x) || isNaN(CSMot.y)) return;

  const layer = resolveHodographSrhFillLayer(Sounding, inflow);
  if (!layer) return;

  const sm = hodographStormMotionToCanvas(Center, Scale, Mod);
  const pts = [];

  const pushWind = (slice) => {
    if (!isUsableHodographWind(slice)) return;
    pts.push(hodographWindToCanvas(Center, Scale, slice));
  };

  pushWind(layer.bot);

  const indices = stepIdx && stepIdx.length ? stepIdx : W.map(arrayIndex);
  for (const i of indices) {
    const w = W[i];
    if (!isUsableHodographWind(w)) continue;
    if (w.H <= layer.bot.H + 0.5 || w.H >= layer.top.H - 0.5) continue;
    pushWind(w);
  }

  pushWind(layer.top);
  if (pts.length < 1) return;

  ctx.save();
  ctx.fillStyle = "rgba(125,200,255,0.18)";
  drawCanvasPath(ctx, [sm, ...pts], true, false, true);

  ctx.strokeStyle = "rgba(125,200,255,0.55)";
  ctx.lineWidth = 1.5;
  strokeCanvasSegments(ctx, [
    [sm.x, sm.y, pts[0].x, pts[0].y],
    [sm.x, sm.y, pts[pts.length - 1].x, pts[pts.length - 1].y],
  ]);
  ctx.restore();
}

/** Draws hodograph content.
 * @param {*} Json Parameter for DrawHodograph.
 * @param {*} ghst Parameter for DrawHodograph.
 * @param {*} comparisonSoundings Parameter for DrawHodograph.
 * @returns {void} No value.
 */
function DrawHodograph(Json, ghst = false, comparisonSoundings = []) {
  const drawVersion = ++hodographDrawVersion;
  const Canv = $("hodograph");
  const ctx = Canv.getContext("2d");

  Canv.width = 800;
  Canv.height = 800;

  // --- START AUTO-SCALE LOGIC ---
  let maxWindSpeed = 0;

  // Check main sounding winds
  if (Json.Sounding && Json.Sounding.W) {
    for (let i = 0; i < Json.Sounding.W.length; i++) {
      if (Json.Sounding.W[i].WS !== -9999  && !isNaN(Json.Sounding.W[i].WS)) {
        maxWindSpeed = Math.max(maxWindSpeed, Json.Sounding.W[i].WS);
      }
    }
  }

  // Check comparison soundings winds so they fit too
  if (comparisonSoundings && comparisonSoundings.length > 0 && !VWPActive) {
    comparisonSoundings.forEach(comp => {
      if (comp.sounding && comp.sounding.Sounding && comp.sounding.Sounding.W) {
        let cw = comp.sounding.Sounding.W;
        for (let i = 0; i < cw.length; i++) {
          if (cw[i].WS !== -9999 && !isNaN(cw[i].WS)) {
            maxWindSpeed = Math.max(maxWindSpeed, cw[i].WS);
          }
        }
      }
    });
  }

  // Calculate base scale to fit max wind within the canvas radius (approx 380px)
  // 3800 is derived from: Radius (380px) * 10 (units per scale step)
  // We set a minimum denominator of 100 to prevent zooming in too far on calm days
  let fitBase = 3800 / Math.max(maxWindSpeed + 20, 100);

  // Apply the multiplier
  if (HodographScaleMode == 2){ 
    OutsideFitBase = fitBase;
  } else { 
    OutsideFitBase = 3800/160;
    fitBase = 3800/160;
  }
  
  const Scale = fitBase * HodographScaleMulti;

  // 1. Clear the canvas
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 0, 1000, 1000);

  // 2. Draw the copyright text
  ctx.fillStyle = "rgba(255,255,255,1)"
  ctx.strokeStyle = "rgb(0, 0, 0)"
  ctx.lineWidth = 1.2;
  ctx.font = `bold ${Canv.width / 55}px ${globalFont}`;
  ctx.textAlign = "left"; // Align to the right
  ctx.strokeText(brandLine(" - powered by "), Canv.width * 0.02, Canv.height * 0.03);
  ctx.fillText(brandLine(" - powered by "), Canv.width * 0.02, Canv.height * 0.03);
  
  if (comparisonSoundings && comparisonSoundings.length > 0 && !VWPActive) {
    let legendY = Canv.height * 0.05; // Starting Y position
    const legendX = Canv.width * 0.02;
    const legendBoxSize = Canv.width * 0.025;

    comparisonSoundings.forEach(comp => {
      if (!comp.metadata.isVisible) return;
      const metadata = comp.metadata;
      const color = metadata.comparisonColor || "rgba(0, 191, 255, 1)";

      ctx.fillStyle = color;
      ctx.fillRect(legendX, legendY, legendBoxSize, legendBoxSize);

      const date = metadata.date;
      const formattedDate = `${date.substring(4, 6)}-${date.substring(6, 8)}-${date.substring(0, 4)}`;
      let legendText = "";

      if (metadata.title == undefined){
        legendText = `${metadata.model.toUpperCase()} ${formattedDate} ${metadata.run}Z F${metadata.fh}`;
      } else {
        legendText = metadata.title;
      }

      ctx.fillStyle = "rgba(255, 255, 255, 1)";
      ctx.font = `bold ${Canv.width / 50}px ${globalFont}`;
      ctx.textAlign = "left";
      ctx.fillText(legendText, legendX + legendBoxSize + 10, legendY + legendBoxSize / 1.4);

      legendY += legendBoxSize + 8; // Move down for the next legend
    });
  }

  ctx.fillStyle = "rgba(255,255,255,1)"
  ctx.textAlign = "left";

  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 4;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);

  let Sounding = Json.Sounding;
  let BRM = GetBM(Sounding, GlobalEffInflow);

  ctx.fillStyle = "rgba(255,255,255,1)";

  const CT = GetPositionScale(50, 50, Canv);
  ctx.font = `bold ${Canv.width / 75}px ${globalFont}`;
  ctx.scale(2, 2); // Scaling now happens AFTER the legend is drawn

  ctx.font = `${Canv.width / 75}px ${globalFont}`;

  let BrmComps = ConvertCartToPolarRealRnd(BRM.RM);
  let BlmComps = ConvertCartToPolarRealRnd(BRM.LM);
  let CustomComps = ConvertCartToPolarRealRnd(CUMot);
  let MeanComps = ConvertCartToPolarRealRnd(BRM.MM);
  let USComps = ConvertCartToPolarRealRnd(BRM.US);
  let DSComps = ConvertCartToPolarRealRnd(BRM.DS);
  let DTMRComps = ConvertCartToPolarRealRnd(BRM.DTMR);
  let DTMLComps = ConvertCartToPolarRealRnd(BRM.DTML);

  if (HodographScaleMode == 0) { // None (Fixed Center)
    HodographCenter = [50, 50];
  } else { // Storm Relative or Dynamic (Shifted Center)
    HodographCenter = [
      50 - ((isNaN(CSMot.x) ? 0 : CSMot.x) * (Scale / 10)) /4 ,
      50 + ((isNaN(CSMot.y) ? 0 : CSMot.y) * (Scale / 10)) /4
    ]
  }

  // console.log(CT.x)

  let Center = GetPositionScale(HodographCenter[0], HodographCenter[1], Canv);

  if (!HodoMode) {
    Center = GetPositionScale(50, 50, Canv);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.setLineDash([]);
  ctx.moveTo(0, Center.y / 2);
  ctx.lineTo(Canv.width, Center.y / 2);
  ctx.stroke();
  ctx.beginPath();
  //ctx.setLineDash([4, 4]);
  ctx.moveTo(Center.x / 2, 0);
  ctx.lineTo(Center.x / 2, Canv.height);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";

  // Update loop limit to ensure rings cover the maximum wind speed
  for (let i = 10; i < Math.max(200, maxWindSpeed + 20); i += 10) {
    ctx.beginPath();
    ctx.arc(Center.x / 2, Center.y / 2, i * Scale / 10, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = "rgba(200,200,200,1)";
    ctx.textAlign = "left";
    const speedLabel = useImperialUnits === 2 ? Math.round(KtsToMph(i)) : i;
    ctx.fillText(speedLabel, Center.x / 2 + i * Scale / 10 - 5, Center.y / 2 + 3 + 10);
    ctx.fillText(speedLabel, Center.x / 2 - i * Scale / 10 - 5, Center.y / 2 + 3 + 10);
    ctx.textAlign = "center";
    ctx.fillText(speedLabel, Center.x / 2 + 10, Center.y / 2 - i * Scale / 10 + 3);
    ctx.fillText(speedLabel, Center.x / 2 + 10, Center.y / 2 + i * Scale / 10 + 3);
    ctx.closePath();
  }


  ctx.setLineDash([]);


  const SH = GetLayerByHght(Json.Sounding, "SFC").H;

  //DrawHodograph

  //let Start = ConvertPolartoCart(Sounding.W[0]);
  ctx.fillStyle = "rgba(225,0,0,1)";
  ctx.strokeStyle = "rgba(225,0,0,1)";

  //ctx.moveTo(Center.x, Center.y);

  ctx.lineWidth = 1.5;

  // ctx.lineStyle = "rgba(255,0,0,1)";
  if (ghst != false) {

    ghost.forEach((O) => {
      let Center = GetPositionScale(HodographCenter[0], HodographCenter[1], Canv);

      if (!HodoMode) {
        Center = GetPositionScale(50, 50, Canv);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(25,100,100,0.5)";
      ctx.fillStyle = "rgba(25,100,100,0.5)";
      let Obj = O.Sounding;
      const ghostMeta = { STitle: O.STitle || Json.STitle || '', WWL: O.WWL };
      const ghostStepIdx = getHodographWindStepIndices(ghostMeta, Obj.W, SH);
      const ghostPairs = hodographSegmentIndexPairs(O.WWL, ghostStepIdx);
      ctx.beginPath();
      for (const pr of ghostPairs) {
        const i = pr[0];
        const i2 = pr[1];

        if (Obj.H[i] - SH >= 12000 || Obj.W[i].H - SH >= 12000) {
          break;
        }

        if (Obj.W[i].WS == -9999 || Obj.W[i].WD == -9999) {
          continue;
        }

        if (Number.isNaN(Obj.W[i].WS) || Number.isNaN(Obj.W[i].WD)) {
          continue;
        }

        let Pos = ConvertPolartoCart(Obj.W[i]);
        let Pos2 = ConvertPolartoCart(Obj.W[i2]);

        if (!HodoMode) {
          Pos.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
          Pos.y += isNaN(CSMot.y) ? 0 : CSMot.y;
          Pos2.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
          Pos2.y += isNaN(CSMot.y) ? 0 : CSMot.y;
        }
        //// console.log(Center.x + Pos.x, Center.y + Pos.y);

        ctx.moveTo(Center.x / 2 + Pos.x * (Scale / 10), Center.y / 2 + Pos.y * (Scale / 10));
        ctx.lineTo(Center.x / 2 + Pos2.x * (Scale / 10), Center.y / 2 + Pos2.y * (Scale / 10));
        //ctx.moveTo(Center.x/2 + Pos2.x, Center.y + Pos2.y);
        ctx.stroke();
        ctx.fill();
      }
      ctx.stroke();
      ctx.fill();
    });
    ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(225,0,0,1)";
    ctx.strokeStyle = "rgba(225,0,0,1)";
  }

  if (comparisonSoundings && comparisonSoundings.length > 0 && !VWPActive) {
    comparisonSoundings.forEach(comp => {
      if (!comp.metadata.isVisible) return;
      const comparisonColor = comp.metadata.comparisonColor || "rgba(0, 191, 255, 1)";
      ctx.strokeStyle = comparisonColor;
      ctx.lineWidth = 2;

      let compObj = comp.sounding.Sounding;
      let Center = GetPositionScale(HodographCenter[0], HodographCenter[1], Canv);
      if (!HodoMode) {
        Center = GetPositionScale(50, 50, Canv);
      }

      const compSH = GetLayerByHght(compObj, "SFC").H;
      const compStepIdx = getHodographWindStepIndices(comp.sounding, compObj.W, compSH);
      const compPairs = hodographSegmentIndexPairs(comp.sounding.WWL, compStepIdx);

      for (const pr of compPairs) {
        const i = pr[0];
        const i2 = pr[1];
        if (compObj.W[i].H - compSH >= 12000 || compObj.W[i2].H - compSH >= 12000) break;
        if (compObj.W[i].WS === -9999 || compObj.W[i].WD === -9999) continue;
        if (compObj.W[i2].WS === -9999 || compObj.W[i2].WD === -9999) continue;

        let Pos = ConvertPolartoCart(compObj.W[i]);
        let Pos2 = ConvertPolartoCart(compObj.W[i2]);

        if (!HodoMode) {
          Pos.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
          Pos.y += isNaN(CSMot.y) ? 0 : CSMot.y;
          Pos2.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
          Pos2.y += isNaN(CSMot.y) ? 0 : CSMot.y;
        }

        ctx.beginPath();
        ctx.moveTo(Center.x / 2 + Pos.x * (Scale / 10), Center.y / 2 + Pos.y * (Scale / 10));
        ctx.lineTo(Center.x / 2 + Pos2.x * (Scale / 10), Center.y / 2 + Pos2.y * (Scale / 10));
        ctx.stroke();
      }
    });
  }

  let Obj = Json.Sounding;

  ctx.strokeStyle = "rgba(225,0,225,1)";
  ctx.lineWidth = 2;

  const mainStepIdx = getHodographWindStepIndices(Json, Obj.W, SH);
  const mainPairs = hodographSegmentIndexPairs(Json.WWL, mainStepIdx);

  let Mod = getHodographStormOffsetMod();
  drawHodographStormMotionFill(
    ctx,
    Obj,
    Center,
    Scale,
    Mod,
    Obj.W,
    mainStepIdx,
    typeof Info !== "undefined" ? Info.EffInflow : false
  );

  for (const pr of mainPairs) {
    const i = pr[0];
    const iNext = pr[1];
    const currentLevel = Obj.W[i];
    const nextLevel = Obj.W[iNext];

    if (Obj.H[i] - SH >= 12000 || currentLevel.H - SH >= 12000 || nextLevel.H - SH >= 12000) {
      break;
    }

    if (
      currentLevel.WS === -9999 ||
      currentLevel.WD === -9999 ||
      nextLevel.WS === -9999 ||
      nextLevel.WD === -9999
    ) {
      continue;
    }

    if (isNaN(currentLevel.WS) || isNaN(currentLevel.WD) || isNaN(nextLevel.WS) || isNaN(nextLevel.WD)) {
      continue;
    }

    let Hght = currentLevel.H;
    let HghtMax = nextLevel.H;
    ctx.strokeStyle = GetHodographColor(HghtMax - SH, ctx);

    let Pos = ConvertPolartoCart(currentLevel);
    let Pos2 = ConvertPolartoCart(nextLevel);

    if (!HodoMode) {
      Pos.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
      Pos.y += isNaN(CSMot.y) ? 0 : CSMot.y;
      Pos2.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
      Pos2.y += isNaN(CSMot.y) ? 0 : CSMot.y;
    }

    // NEXRAD VWP RMS: circle radius in hodograph space = RMS (kt) × same scale as wind components
    const errKts = Obj.W[i].ERR_KTS;
    if (errKts != null && errKts > 0 && Number.isFinite(errKts)) {
      const cx = Center.x / 2 + Pos.x * (Scale / 10);
      const cy = Center.y / 2 + Pos.y * (Scale / 10);
      const rPx = errKts * (Scale / 10) * VWP_HODOGRAPH_RMS_RADIUS_SCALE;
      ctx.fillStyle = GetHodographColor(Hght - SH, ctx, VWP_HODOGRAPH_RMS_FILL_ALPHA);
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(Center.x / 2 + Pos.x * (Scale / 10), Center.y / 2 + Pos.y * (Scale / 10));
    ctx.lineTo(Center.x / 2 + Pos2.x * (Scale / 10), Center.y / 2 + Pos2.y * (Scale / 10));
    ctx.stroke();
    ctx.fill();
  }

  const topIdx =
    mainStepIdx && mainStepIdx.length >= 1 ? mainStepIdx[mainStepIdx.length - 1] : Json.WWL - 1;
  if (topIdx >= 0) {
    const top = Obj.W[topIdx];
    const errTop = top && top.ERR_KTS;
    if (
      top &&
      errTop != null &&
      errTop > 0 &&
      Number.isFinite(errTop) &&
      top.WS != -9999 &&
      top.WD != -9999 &&
      top.H - SH < 12000
    ) {
      let Ptop = ConvertPolartoCart(top);
      if (!HodoMode) {
        Ptop.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
        Ptop.y += isNaN(CSMot.y) ? 0 : CSMot.y;
      }
      const cx = Center.x / 2 + Ptop.x * (Scale / 10);
      const cy = Center.y / 2 + Ptop.y * (Scale / 10);
      ctx.fillStyle = GetHodographColor(top.H - SH, ctx, VWP_HODOGRAPH_RMS_FILL_ALPHA);
      ctx.beginPath();
      ctx.arc(cx, cy, errTop * (Scale / 10) * VWP_HODOGRAPH_RMS_RADIUS_SCALE, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  // Drop stray stroke/fill: last path was often the top RMS arc — stroking it drew the red outline bug.
  ctx.beginPath();

  // Numbers
  if (DisplayHodographNumbers) {
    ctx.strokeStyle = "rgba(255,225,225,1)";
    ctx.font = `bold 8px ${globalFont}`;

    for (var x of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const Lyr = GetLayerByHght(Json.Sounding, x * 1000);

      let Pos = ConvertPolartoCart(Lyr);
      if (!HodoMode) {
        Pos.x -= isNaN(CSMot.x) ? 0 : CSMot.x;
        Pos.y += isNaN(CSMot.y) ? 0 : CSMot.y;
      }

      ctx.fillStyle = "rgba(255,225,225,0.75)";
      ctx.beginPath();
      ctx.arc(Center.x / 2 + Pos.x * (Scale / 10), Center.y / 2 + Pos.y * (Scale / 10), 4, 0, 2 * Math.PI);
      //ctx.moveTo(Center.x/2 + Pos2.x, Center.y + Pos2.y);
      ctx.fill();

      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fillText(`${x}`, Center.x / 2 + Pos.x * (Scale / 10), Center.y / 2 + Pos.y * (Scale / 10) + 2);
    }
    ctx.font = `${Canv.width / 75}px ${globalFont}`;
  }

  ctx.font = `10px ${globalFont}`;

  const unitSuffix = useImperialUnits === 2 ? "mph" : "kts";

  ctx.fillStyle = CSMot == Motions.RM && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var rmSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(BrmComps.WS)) : BrmComps.WS;
  rmSpeed = CSMot === Motions.RM ? `${BrmComps.WD} / ${rmSpeed}` : rmSpeed;
  ctx.fillText(`${rmSpeed}${unitSuffix} RM`, Center.x / 2 + (Mod.x + BRM.RM.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.RM.y) * (Scale / 10) + 10);

  ctx.fillStyle = CSMot == Motions.LM && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var lmSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(BlmComps.WS)) : BlmComps.WS;
  lmSpeed = CSMot === Motions.LM ? `${BlmComps.WD} / ${lmSpeed}` : lmSpeed;
  ctx.fillText(`${lmSpeed}${unitSuffix} LM`, Center.x / 2 + (Mod.x + BRM.LM.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.LM.y) * (Scale / 10) + 10);

  ctx.fillStyle = CSMot == CUMot && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var cmSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(CustomComps.WS)) : CustomComps.WS;
  cmSpeed = CSMot === CUMot ? `${(360 + 180 - CustomComps.WD)%360} / ${cmSpeed}` : cmSpeed;
  ctx.fillText(`${cmSpeed}${unitSuffix} CM`, Center.x / 2 + (Mod.x + CUMot.x) * (Scale / 10) + 5, Center.y / 2 - (-Mod.y + CUMot.y) * (Scale / 10) + 10);

  ctx.font = `8px ${globalFont}`;

  ctx.fillStyle = CSMot == Motions.US && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var usSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(USComps.WS)) : USComps.WS;
  usSpeed = CSMot === Motions.US ? `${USComps.WD} / ${usSpeed}` : usSpeed;
  ctx.fillText(`${usSpeed}${unitSuffix} UP`, Center.x / 2 + (Mod.x + BRM.US.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.US.y) * (Scale / 10) + 10);

  ctx.fillStyle = CSMot == Motions.DS && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var dsSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(DSComps.WS)) : DSComps.WS;
  dsSpeed = CSMot === Motions.DS ? `${DSComps.WD} / ${dsSpeed}` : dsSpeed;
  ctx.fillText(`${dsSpeed}${unitSuffix} DN`, Center.x / 2 + (Mod.x + BRM.DS.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.DS.y) * (Scale / 10) + 10);


  ctx.fillStyle = CSMot == Motions.DTMR && "rgba(161, 161, 161, 1)" || "rgba(161, 161 ,161 ,0.7)";
  ctx.textAlign = "left";
  var dtmrSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(DTMRComps.WS)) : DTMRComps.WS;
  dtmrSpeed = CSMot === Motions.DTMR ? `${DTMRComps.WD} / ${dtmrSpeed}` : dtmrSpeed;
  ctx.fillText(`${dtmrSpeed}${unitSuffix} DTMR`, Center.x / 2 + (Mod.x + BRM.DTMR.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.DTMR.y) * (Scale / 10) + 10);

  ctx.fillStyle = CSMot == Motions.DTML && "rgba(161, 161, 161, 1)" || "rgba(161, 161 ,161 ,0.7)";
  ctx.textAlign = "left";
  var dtmlSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(DTMLComps.WS)) : DTMLComps.WS;
  dtmlSpeed = CSMot === Motions.DTML ? `${DTMLComps.WD} / ${dtmlSpeed}` : dtmlSpeed;
  ctx.fillText(`${dtmlSpeed}${unitSuffix} DTML`, Center.x / 2 + (Mod.x + BRM.DTML.x) * (Scale / 10) + 5, Center.y / 2 + (Mod.y + BRM.DTML.y) * (Scale / 10) + 10);

  ctx.font = `10px ${globalFont}`;

  ctx.strokeStyle = CSMot == Motions.RM && "rgba(255,0,0,0.9)" || "rgba(255,0,0,0.5)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.RM.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.RM.y) * (Scale / 10), 4, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = CSMot == Motions.LM && "rgba(255,0,0,0.9)" || "rgba(255,0,0,0.5)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.LM.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.LM.y) * (Scale / 10), 4, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = CSMot == CUMot && "rgba(255,0,0,0.9)" || "rgba(255,0,0,0.5)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + CUMot.x) * (Scale / 10), Center.y / 2 - (-Mod.y + CUMot.y) * (Scale / 10), 4, 0, 2 * Math.PI);
  ctx.stroke();

  //Others

  ctx.strokeStyle = CSMot == Motions.US && "rgba(0, 255, 255, 0.9)" || "rgba(0, 255, 255, 0.4)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.US.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.US.y) * (Scale / 10), 3, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = CSMot == Motions.DS && "rgba(0, 255, 255, 0.9)" || "rgba(0, 255, 255, 0.4)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.DS.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.DS.y) * (Scale / 10), 3, 0, 2 * Math.PI);
  ctx.stroke();

  //Deviant Motions
  ctx.strokeStyle = CSMot == Motions.DTMR && "rgba(170, 115, 83, 0.9)" || "rgba(170, 115, 83, 0.4)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.DTMR.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.DTMR.y) * (Scale / 10), 3, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = CSMot == Motions.DTML && "rgba(170, 115, 83, 0.9)" || "rgba(170, 115, 83, 0.4)";
  ctx.beginPath();
  ctx.arc(Center.x / 2 + (Mod.x + BRM.DTML.x) * (Scale / 10), Center.y / 2 + (Mod.y + BRM.DTML.y) * (Scale / 10), 3, 0, 2 * Math.PI);
  ctx.stroke();


  let hght0km = GetLayerByHght(Sounding, "SFC");
  //Possibly Wrong
  let hght6km = GetLayerByHght(Sounding, 6000);

  let MM = MeanWind(Sounding, hght0km.P, hght6km.P, 1);

  ctx.strokeStyle = CSMot == Motions.MM && "rgba(255,100,50,0.9)" || "rgba(200,100,50,0.5)";
  ctx.strokeRect(Center.x / 2 + (Mod.x + MM.x) * (Scale / 10), Center.y / 2 + (Mod.y + MM.y) * (Scale / 10), 6, 6);
  ctx.fillStyle = CSMot == Motions.MM && "rgba(255,255,255,1)" || "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  var mmSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(MeanComps.WS)) : Math.round(MeanComps.WS);
  mmSpeed = CSMot === Motions.MM ? `${MeanComps.WD} / ${mmSpeed}` : mmSpeed;
  ctx.fillText(`${mmSpeed}${unitSuffix} MM`, Center.x / 2 + (Mod.x + MM.x) * (Scale / 10) + 10, Center.y / 2 + (Mod.y + MM.y) * (Scale / 10) + 10);

  var P = 195;

  if (CSMot == CUMot) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillText(`Custom Motion`, Center.x / 2 + (Mod.x + CSMot.x) * (Scale / 10) - 180, Center.y / 2 - (-Mod.y + CSMot.y) * (Scale / 10) + P);
    P -= 15;
  }

  if (ModifiedWind) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillText("Custom Surface Data", Center.x / 2 + (Mod.x + CSMot.x) * (Scale / 10) - 180, Center.y / 2 - (-Mod.y + CSMot.y) * (Scale / 10) + P);
    // console.log("AYO");
    P -= 15;
  }
  if (!HodoMode) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillText("Storm-Relative", Center.x / 2 + (Mod.x + CSMot.x) * (Scale / 10) - 180, Center.y / 2 - (-Mod.y + CSMot.y) * (Scale / 10) + P);
  }
  ctx.textAlign = "center";

  if (!VWPActive) {
    drawHodographLocationInset(ctx, Canv, Json, () => {
      scheduleHodographMapRedraw(Json, ghst, comparisonSoundings, drawVersion);
    });
  }

  if (mapImage && !VWPActive) {
    const mapSize = 200;
    const padding = 0; // You can increase this if you want some spacing from the edge
    
    // CHANGED: Calculate X to be on the right side
    const x = Canv.width - mapSize - padding;
    
    // Y remains at the bottom
    const y = Canv.height - mapSize - padding;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.drawImage(mapImage, 0, 0, mapImage.width || mapSize, mapImage.height || mapSize, x, y, mapSize, mapSize);

    ctx.restore();
  }

  //ctx.fill();
  // ctx.closePath();
}

/** Draws skew numbers content.
 * @returns {void} No value.
 */
function DrawSkewNumbers() {
  const Canv = $("skewTNumbers");
  const ctx = Canv.getContext("2d");
  const dropsondeMode = !!root.querySelector(".sjs-viz.dropsonde-mode");

  Canv.width = 800;
  Canv.height = 45;

  //ctx.translate(SkewTPosition.x,0);

  ctx.fillStyle = dropsondeMode ? "#0a0c0e" : "rgba(0,0,0,0)";
  if (dropsondeMode) ctx.fillRect(0, 0, Canv.width, Canv.height);

  ctx.font = `${dropsondeMode ? 600 : 400} ${Canv.width / (dropsondeMode ? 36 : 40)}px ${globalFont}`;

  let Bounds = {
    l: -SkewTPosition.x,
    u: -SkewTPosition.x + Canv.width / SkewTScale,
  };

  const tStart = Math.ceil(skv.tleft / 10) * 10;
  const tEnd = Math.floor((skv.tleft + skv.tspread) / 10) * 10;
  for (let i = tStart; i <= tEnd; i += 10) {
    let N = GetSkewRatio(i) * Canv.width * SkewTScale * 0.9;
    ctx.fillStyle = dropsondeMode ? "#8ea3b3" : "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    const tempLabel = useImperialUnits === 2 ? Math.round(CToF(i)) : i;

    ctx.fillText(`${tempLabel}`, N + SkewTPosition.x * SkewTScale * 0.9, Canv.height * 2 / 3);
  }

  ctx.fillStyle = dropsondeMode ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,1)";
  ctx.fillRect(25, 1, 700, dropsondeMode ? 1 : 1);
}

let iterbb = 0;

/** Returns skew ratio data.
 * @param {*} N Parameter for GetSkewRatio.
 * @returns {*} Result of the function.
 */
function GetSkewRatio(N) {
  return ((N - skv.tleft) / skv.tspread + 0.01);
}

/** Returns the color for a wind barb based on its speed.
 * @param {*} N Parameter for BarbColor.
 * @returns {*} Result of the function.
 */
function BarbColor(N) {
  let ColorIndex = [
    "rgba(100,100,255,1)",
    "rgba(0,125,255,1)",
    "rgba(0,255,0,1)",
    "rgba(255,255,0,1)",
    "rgba(255,125,0,1)",
    "rgba(255,0,0,1)",
    "rgba(255,0,125,1)",
    "rgba(255,0,255,1)",
    "rgba(125,0,255,1)",
    "rgba(0,0,255,1)",
    "rgba(125,125,125,1)",
    "rgba(255,255,255,1)",
  ];

  return ColorIndex[Math.min(Math.floor(N / 10), 11)];
}

/** Saffir–Simpson colors — dropsonde barbs only (matches side-panel badges).
 * @param {*} kt Parameter for dropsondeHurricaneBarbColor.
 * @returns {*} Result of the function.
 */
function dropsondeHurricaneBarbColor(kt) {
  const n = Number(kt);
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (v >= 200) return '#a9eaff';
  if (v >= 160) return '#372df9';
  if (v >= 137) return '#1b239a';
  if (v >= 113) return '#561761';
  if (v >= 96) return '#f44336';
  if (v >= 83) return '#ff9800';
  if (v >= 64) return '#ffeb3b';
  if (v >= 34) return '#4caf50';
  return '#5c6bc0';
}

/** Draws barb vwp content.
 * @param {*} params Parameter for drawBarbVWP.
 * @param {*} overrideColor Parameter for drawBarbVWP.
 * @param {*} lat Parameter for drawBarbVWP.
 * @returns {*} Result of the function.
 */
function drawBarbVWP(params, overrideColor = null, lat = 0){
  const Canv = $("Values8");
  const ctx = Canv.getContext("2d");

  // If an override color is provided, use it. Otherwise, calculate it based on speed.
  let barbColor = overrideColor;

  let wdir = params[1];
  let wspd = params[0];

  let S = SkewTPosition.y / Canv.height;
  //let ScaleBot = PressuretoSkew(SkewTPosition.y
  let Bounds = {
    l: -SkewTPosition.y,
    u: -SkewTPosition.y + Canv.height / SkewTScale,
  };

  let siz = 1.5;
  // --- MODIFIED: Center the barb horizontally ---
  let x = params[2];
  let y = params[3];

  ctx.fillStyle = barbColor;
  ctx.lineWidth = 3;
  ctx.strokeStyle = barbColor;

  if (!qc(wdir) || !qc(wspd)) return RMISSD;
  ctx.beginPath();

  let Polar = ConvertPolartoCart({ WS: 1, WD: (-wdir) });

  var dx = 50 * Polar.x * (siz / 1.5);
  var dy = 50 * Polar.y * (siz / 1.5);

  var x1 = x;
  var y1 = y;
  var x2 = x1 + dx;
  var y2 = y1 - dy;

  // Draw backbone of wind barb, along with origin dot 
  ctx.rect(x1 - 1, y1 - 1, 2, 2);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);

  var sped = wspd;
  x1 = x2;
  y1 = y2;

  var wid = 7;                        // Number of flags that will fit 
  var spcx = dx / wid;
  var spcy = dy / wid;
  x1 = x1 + spcx;
  y1 = y1 - spcy;

  // Draw wind flags (increments of 50kt) 
  var flag = 0;
  var hgt, x3, y3;

  // EDITED: Determine direction of flags based on hemisphere (Lat < 0 is Southern Hemisphere)
  const flipFactor = lat < 0 ? -1 : 1;

  ctx.fillStyle = ctx.strokeStyle;
  //// console.log(wdir + " " + wspd + " " + ctx.strokeStyle + " " + x + " " + y);
  while (sped > 50) {
    var flag = 1;
    x1 = x1 - spcx;
    y1 = y1 + spcy;
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;

    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fill();

    x2 = (x1 + x2 + x3) / 3;
    y2 = (y1 + y2 + y3) / 3;
    sped -= 50;
    x1 = x3;
    y1 = y3;
  }

  // Draw wind barbs (increments of 5kt)
  while (sped > 10) {
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;

    ctx.moveTo(x3, y3);
    ctx.lineTo(x2, y2);
    sped -= 10;
    x1 = x3;
    y1 = y3;
  }

  // Draw short barb
  if (sped >= 5) {
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;
    dx = (x3 - x2) / 2;
    dy = (y3 - y2) / 2;
    x2 = x3 - dx;
    y2 = y3 - dy;

    ctx.moveTo(x3, y3);
    ctx.lineTo(x2, y2);
  }

  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Draws barb content.
 * @param {*} params Parameter for drawBarb.
 * @param {*} overrideColor Parameter for drawBarb.
 * @param {*} lat Parameter for drawBarb.
 * @param {*} useHurricaneColors Parameter for drawBarb.
 * @returns {*} Result of the function.
 */
function drawBarb(params, overrideColor = null, lat = 0, useHurricaneColors = false) {
  const Canv = $("barbs");
  const ctx = Canv.getContext("2d");

  // Override wins; dropsonde uses SS category colors; otherwise classic speed ramp.
  let barbColor =
    overrideColor ||
    (useHurricaneColors ? dropsondeHurricaneBarbColor(params[5]) : BarbColor(params[5]));

  let wdir = params[4];
  let wspd = params[5];

  let S = SkewTPosition.y / Canv.height;
  //let ScaleBot = PressuretoSkew(SkewTPosition.y
  let Bounds = {
    l: -SkewTPosition.y,
    u: -SkewTPosition.y + Canv.height / SkewTScale,
  };

  let siz = 1;
  // --- MODIFIED: Center the barb horizontally ---
  let x = Canv.width / 2;
  let y = 0.05 + 0.99 * Canv.height * (PressuretoSkew(params[0]));
  y = (y - Bounds.l) / (Bounds.u - Bounds.l);
  y *= Canv.height;

  ctx.fillStyle = barbColor;
  ctx.lineWidth = 2;
  ctx.strokeStyle = barbColor;

  if (!qc(wdir) || !qc(wspd)) return RMISSD;

  // Calm / 0 kt: station-plot circle only (no staff or barbs).
  if (wspd < 2.5) {
    const r = Math.max(2.5, Canv.width * 0.035);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    return;
  }

  ctx.beginPath();

  let Polar = ConvertPolartoCart({ WS: 1, WD: (-wdir) });

  var dx = 50 * Polar.x * (siz / 1.5);
  var dy = 50 * Polar.y * (siz / 1.5);


  var x1 = x;
  var y1 = y;
  var x2 = x1 + dx;
  var y2 = y1 - dy;

  // Draw backbone of wind barb, along with origin dot 
  ctx.rect(x1 - 1, y1 - 1, 2, 2);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);

  var sped = wspd;
  x1 = x2;
  y1 = y2;

  var wid = 7;                        // Number of flags that will fit 
  var spcx = dx / wid;
  var spcy = dy / wid;
  x1 = x1 + spcx;
  y1 = y1 - spcy;

  // Draw wind flags (increments of 50kt) 
  var flag = 0;
  var hgt, x3, y3;

  // EDITED: Determine direction of flags based on hemisphere (Lat < 0 is Southern Hemisphere)
  const flipFactor = lat < 0 ? -1 : 1;

  ctx.fillStyle = ctx.strokeStyle;
  //// console.log(wdir + " " + wspd + " " + ctx.strokeStyle + " " + x + " " + y);
  while (sped > 50) {
    var flag = 1;
    x1 = x1 - spcx;
    y1 = y1 + spcy;
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;

    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fill();

    x2 = (x1 + x2 + x3) / 3;
    y2 = (y1 + y2 + y3) / 3;
    sped -= 50;
    x1 = x3;
    y1 = y3;
  }

  // Draw wind barbs (increments of 5kt)
  while (sped > 10) {
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;

    ctx.moveTo(x3, y3);
    ctx.lineTo(x2, y2);
    sped -= 10;
    x1 = x3;
    y1 = y3;
  }

  // Draw short barb
  if (sped >= 5) {
    hgt = .5 * flipFactor; // EDITED: Apply flipFactor
    x2 = x1 + (dy * hgt);
    y2 = y1 + (dx * hgt);
    x3 = x1 - spcx;
    y3 = y1 + spcy;
    dx = (x3 - x2) / 2;
    dy = (y3 - y2) / 2;
    x2 = x3 - dx;
    y2 = y3 - dy;

    ctx.moveTo(x3, y3);
    ctx.lineTo(x2, y2);
  }

  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Draws barbs content.
 * @param {*} Sounding Parameter for DrawBarbs.
 * @param {*} comparisonSoundings Parameter for DrawBarbs.
 * @returns {void} No value.
 */
function DrawBarbs(Sounding, comparisonSoundings = []) {
  const Canv = $("barbs");
  const ctx = Canv.getContext("2d");

  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 0, 1000, 1000);

  Canv.height = 800;
  Canv.width = 100;

  // EDITED: Get main sounding latitude
  const mainLat = Sounding.Location ? Sounding.Location[0] : 0;
  const hurricaneBarbColors = isDropsondeSounding(Sounding);

  if (comparisonSoundings && comparisonSoundings.length > 0) {
    comparisonSoundings.forEach(comp => {
      if (!comp.metadata.isVisible) return;
      // Use the model's assigned color for its barbs
      const color = comp.metadata.comparisonColor || "rgba(0, 191, 255, 1)";
      const sound = comp.sounding.Sounding;

      // EDITED: Get comparison sounding latitude
      const compLat = comp.sounding.Location ? comp.sounding.Location[0] : 0;

      // Draw a barb for each data level in the comparison sounding
      for (let i = 0; i < sound.Slice.length; i++) {
        drawBarb(sound.Slice[i], color, compLat, false);
      }
    });
  }

  // For radiosonde data, only draw barbs at specific pressure levels
  if (Sounding.STitle.toLowerCase().includes('radiosonde') || hurricaneBarbColors) {
    // Always draw the first (surface) point
    drawBarb(Sounding.Sounding.Slice[0], null, mainLat, hurricaneBarbColors);

    // Define the pressure levels we want
    const targetPressures = [];

    // From 1000 to 800mb: every 50mb
    for (let p = 1000; p >= 800; p -= 50) {
      targetPressures.push(p);
    }

    // From 775 to 100mb: every 25mb  
    for (let p = 775; p >= 100; p -= 25) {
      targetPressures.push(p);
    }

    // Draw barbs only for these pressure levels
    targetPressures.forEach(targetP => {
      // Find the closest level in the sounding data
      let closestIndex = 0;
      let minDiff = Math.abs(Sounding.Sounding.Slice[0][0] - targetP);

      for (let i = 1; i < Sounding.Sounding.Slice.length; i++) {
        const diff = Math.abs(Sounding.Sounding.Slice[i][0] - targetP);
        if (diff < minDiff) {
          minDiff = diff;
          closestIndex = i;
        }
      }

      // Only draw if we're within 5mb of the target pressure and it's not the first point (already drawn)
      if (minDiff <= 5 && closestIndex !== 0) {
        drawBarb(Sounding.Sounding.Slice[closestIndex], null, mainLat, hurricaneBarbColors);
      }
    });
  } else {
    // Original logic for model data
    drawBarb(Sounding.Sounding.Slice[0], null, mainLat, false);

    for (let i = 1; i < Math.floor(Sounding.TWL / 2); i += 1) {
      drawBarb(Sounding.Sounding.Slice[i], null, mainLat, false);
    }

    for (let i = Math.floor(Sounding.TWL / 2); i < Sounding.TWL; i += 2) {
      drawBarb(Sounding.Sounding.Slice[i], null, mainLat, false);
    }
  }
};

/** Draws mix ratio line content.
 * @param {*} val Parameter for MixRatioLine.
 * @returns {void} No value.
 */
function MixRatioLine(val) {
  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");

  var pbot = 1045;//Math.min(1045, skv.pbot);
  var ptop = 600;//Math.max(skv.ptop, Math.min(600, pbot - 50));

  var temp = temp_at_mixrat(val, pbot);
  var x0 = Canv.width * (GetSkewRatio(temp) + LevelToSkewNum(pbot));
  var y0 = pres_to_pix(pbot);

  temp = temp_at_mixrat(val, ptop);
  var x1 = Canv.width * (GetSkewRatio(temp) + LevelToSkewNum(ptop));
  var y1 = pres_to_pix(ptop);

  ctx.save();
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = CheckMode("rgba(4,125,4,1)", "rgba(4,75,4,1)");
  ctx.lineWidth = 3;
  strokeCanvasLine(ctx, x0, y0, x1, y1);
  ctx.fillStyle = CheckMode('rgba(45, 200, 45, 1)', 'rgba(25, 100, 25, 1)');
  ctx.textAlign = "center";
  ctx.fillText(`${val}`, x1, y1);
  ctx.restore();
}

/** Draws line content.
 * @param {*} Sounding Parameter for DrawLine.
 * @param {*} type Parameter for DrawLine.
 * @param {*} ghost Parameter for DrawLine.
 * @param {*} overrideColor Parameter for DrawLine.
 * @returns {void} No value.
 */
function DrawLine(Sounding, type, ghost = false, overrideColor = null) {
  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");

  // --- START GHOST LOGIC ---
  // This block handles drawing the faint "ghost" lines from previous model runs.
  // If the 'ghost' parameter is provided, we execute this and then exit the function.
  if (ghost) {
    ghost.forEach((Lop) => {
      let Sound = Lop.Sounding;
      let Loop, LoopVar, EndVar;

      if (type == "Dew") {
        Loop = Sound.DW;
        LoopVar = Lop.DWL;
        EndVar = "D";
      } else if (type == "Temp") {
        Loop = Sound.TW;
        LoopVar = Lop.TWL;
        EndVar = "T";
      } else if (type == "VTemp") {
        Loop = Sound.TW;
        LoopVar = Lop.TWL;
        EndVar = "VT";
      } else if (type == "WetBulb") {
        Loop = Sound.TW;
        LoopVar = Lop.TWL;
        EndVar = "WB";
      }

      ctx.lineWidth = 3;
      ctx.strokeStyle = CheckMode("rgba(0,200,200,0.5)", "rgba(30,144,255,0.5)");

      ctx.beginPath();

      for (let i = 0; i < LoopVar - 1; i++) {
        if (Loop[i].P < 100) {
          break;
        }

        let OBJ = Loop[i];
        let OBJ2 = Loop[i + 1];
        let PosX = LevelToSkewNum(OBJ.P, Loop[0].P);
        let PosY = PressuretoSkew(OBJ.P, Loop[0].P);
        let Ratio = GetSkewRatio(OBJ[EndVar]);

        let PosX2 = LevelToSkewNum(OBJ2.P, Loop[0].P);
        let PosY2 = PressuretoSkew(OBJ2.P, Loop[0].P);
        let Ratio2 = GetSkewRatio(OBJ2[EndVar]);

        ctx.moveTo((Ratio + PosX) * Canv.width, PosY * Canv.height);
        ctx.lineTo((Ratio2 + PosX2) * Canv.width, PosY2 * Canv.height);
      }
      ctx.stroke();
    });

    // IMPORTANT: Exit here so we don't draw the main lines afterward.
    return;
  }
  // --- END GHOST LOGIC ---

  

  let Sound = Sounding.Sounding;
  let Loop;
  let LoopVar;
  let EndVar;
  let Layers = [];

  // --- START OF COMBINED LOGIC FOR PRIMARY AND COMPARISON LINES ---
  if (overrideColor) {
    // This is a COMPARISON line. Use the provided color.
    ctx.lineWidth = 4;
    ctx.strokeStyle = overrideColor;

    if (type == "Dew") {
      Loop = Sound.DW; LoopVar = Sounding.DWL; EndVar = "D";
    } else if (type == "Temp") {
      Loop = Sound.TW; LoopVar = Sounding.TWL; EndVar = "T";
    }
  } else {
    // This is a PRIMARY line. Use the original logic to determine color and style.
    const dropStyle = isDropsondeSounding(Sounding);
    if (type == "Dew") {
      ctx.lineWidth = dropStyle ? 5 : 4;
      ctx.strokeStyle = CheckMode("rgba(0,225,0,1)", "rgba(0,139,0,1)");
      Loop = Sound.DW; LoopVar = Sounding.DWL; EndVar = "D";
    } else if (type == "Temp") {
      ctx.lineWidth = dropStyle ? 5 : 4;
      ctx.strokeStyle = CheckMode("rgba(225,0,0,1)", "rgba(139,0,0,1)");
      Loop = Sound.TW; LoopVar = Sounding.TWL; EndVar = "T";
    } else if (type == "VTemp") {
      ctx.lineWidth = 4;
      ctx.strokeStyle = CheckMode("rgba(255,0,0,0.7)", "rgba(139,0,0,0.7)");
      Loop = Sound.TW; LoopVar = Sounding.TWL; EndVar = "VT";
    } else if (type == "WetBulb") {
      ctx.lineWidth = 2;
      ctx.strokeStyle = CheckMode("rgba(0,200,200,1)", "rgba(30,144,255,1)");
      Loop = Sound.TW; LoopVar = Sounding.TWL; EndVar = "WB";
    }
    if (dropStyle && (type == "Temp" || type == "Dew")) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    } else {
      ctx.lineCap = "butt";
      ctx.lineJoin = "butt";
    }
  }
  // --- END OF COMBINED LOGIC ---

  if (Sounding.Sounding.SliceMin !== undefined && Sounding.Sounding.SliceMax !== undefined && (type == "Temp" || type == "Dew")){
    ctx.beginPath();

    if (type == "Temp") {
      ctx.fillStyle = CheckMode("rgba(255,75,75,.3)", "rgba(139,20,20,.3)");
      Loop = Sound.TW; 
      LoopVar = Sounding.TWL; 
      EndVar = "T";
    } else if (type == "Dew"){
      ctx.fillStyle = CheckMode("rgba(0,225,0,.2)", "rgba(0,139,0,.2)");
      Loop = Sound.DW; 
      LoopVar = Sounding.DWL; 
      EndVar = "D";
    }

    if (type == "VTemp") {
      ctx.setLineDash([5, 5]);
    } else {
      ctx.setLineDash([]);
    }

    let StartSlicer = ConvertToInfo(Sounding.Sounding.SliceMin[0], Sounding.Sounding.SliceMin[0]);

    let PrevLocation = {x:0, y:0}
    let FirstLocation = false;

    for (let i = 0; i < Sounding.Sounding.SliceMin.length-1; i++){
      let RS = ConvertToInfo(Sounding.Sounding.SliceMin[i], Sounding.Sounding.SliceMin[0]);
      let RS2 = ConvertToInfo(Sounding.Sounding.SliceMin[i+1], Sounding.Sounding.SliceMin[0]);
      if (RS.P < 100) {
        break;
      }

      if (!tqc(RS[EndVar])){
        continue;
      }

      let OBJ = RS;
      let OBJ2 = RS2;
      let PosX = LevelToSkewNum(OBJ.P, StartSlicer.P);
      let PosY = PressuretoSkew(OBJ.P, StartSlicer.P);
      let Ratio = GetSkewRatio(OBJ[EndVar]);

      let PosX2 = LevelToSkewNum(OBJ2.P, StartSlicer.P);
      let PosY2 = PressuretoSkew(OBJ2.P, StartSlicer.P);
      let Ratio2 = GetSkewRatio(OBJ2[EndVar]);

      if (FirstLocation == false){
        FirstLocation = {x:(Ratio + PosX) * Canv.width, y: PosY * Canv.height}
      }

      ctx.lineTo((Ratio2 + PosX2) * Canv.width, PosY2 * Canv.height);
      PrevLocation = {x: (Ratio2 + PosX2) * Canv.width, y : PosY2 * Canv.height}
    }

    StartSlicer = ConvertToInfo(Sounding.Sounding.SliceMax[0], Sounding.Sounding.SliceMax[0]);

    for (let i = Sounding.Sounding.SliceMax.length-1; i > 0; i--){
      let RS = ConvertToInfo(Sounding.Sounding.SliceMax[i], Sounding.Sounding.SliceMax[0]);
      let RS2 = ConvertToInfo(Sounding.Sounding.SliceMax[i-1], Sounding.Sounding.SliceMax[0]);

      if (RS.P < 100) {
        continue;
      }

      if (!tqc(RS[EndVar])){
        continue;
      }

      let OBJ = RS;
      let OBJ2 = RS2;
      let PosX = LevelToSkewNum(OBJ.P, StartSlicer.P);
      let PosY = PressuretoSkew(OBJ.P, StartSlicer.P);
      let Ratio = GetSkewRatio(OBJ[EndVar]);

      let PosX2 = LevelToSkewNum(OBJ2.P, StartSlicer.P);
      let PosY2 = PressuretoSkew(OBJ2.P, StartSlicer.P);
      let Ratio2 = GetSkewRatio(OBJ2[EndVar]);

      if (PrevLocation.x != false){
        ctx.lineTo((Ratio + PosX) * Canv.width, PosY * Canv.height);
        PrevLocation.x = false;
      }

      ctx.lineTo((Ratio2 + PosX2) * Canv.width, PosY2 * Canv.height);
    }

    ctx.lineTo(FirstLocation.x, FirstLocation.y);

    ctx.fill();
  }

  ctx.beginPath();
  if (type == "VTemp") {
    ctx.setLineDash([5, 5]);
  } else {
    ctx.setLineDash([]);
  }

  for (let i = 0; i < LoopVar - 1; i++) {
    if (!(Loop[i].P > 0)) continue;
    if (skv.ptop > 0 && Loop[i].P < skv.ptop) continue;

    let OBJ = Loop[i];
    let OBJ2 = Loop[i + 1];
    if (!OBJ2 || !(OBJ2.P > 0)) continue;
    const v1 = OBJ[EndVar];
    const v2 = OBJ2[EndVar];
    if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;
    if (v1 < -90 || v1 > 60 || v2 < -90 || v2 > 60) continue;
    let PosX = LevelToSkewNum(OBJ.P, Loop[0].P);
    let PosY = PressuretoSkew(OBJ.P, Loop[0].P);
    let Ratio = GetSkewRatio(OBJ[EndVar]);

    let PosX2 = LevelToSkewNum(OBJ2.P, Loop[0].P);
    let PosY2 = PressuretoSkew(OBJ2.P, Loop[0].P);
    let Ratio2 = GetSkewRatio(OBJ2[EndVar]);

    ctx.moveTo((Ratio + PosX) * Canv.width, PosY * Canv.height);
    ctx.lineTo((Ratio2 + PosX2) * Canv.width, PosY2 * Canv.height);

    if (type == "Temp" && !overrideColor) {
      if (Loop[Math.max(1, i)].T >= -30 && Loop[Math.min(LoopVar, i)].T <= -10) {
        Layers.push(Loop[i]);
      } else if (!isDropsondeSounding(Sounding)) {
        ctx.strokeStyle = CheckMode("rgba(255,0,0,1)", "rgba(139,0,0,1)");
      }
    }
  }

  ctx.stroke();
  ctx.fill();

  if (Layers.length > 0 && !ghost && !overrideColor && !isDropsondeSounding(Sounding)) { // Don't draw hail growth zone for comparison / dropsonde lines
    let Start = GetLayerByTemp(Sound, -10);

    if (Start.T < -10){
      let CheckEnd = GetLayerByPres(Sound, "Last");

      if (CheckEnd.P == Start.P){
        return;
      }
    }
    
    let End = GetLayerByTemp(Sound, -30);

    if (End == false) {
      End = GetLayerByPres(Sound, "Last");
    }

    let SfcSlice = ConvertToInfo(Sound.Slice[1]);

    let PX = LevelToSkewNum(Start.P, SfcSlice.P);
    let PY = PressuretoSkew(Start.P, SfcSlice.P);
    let Rio = GetSkewRatio(-10);

    let PX2 = LevelToSkewNum(Layers[0].P, SfcSlice.P);
    let PY2 = PressuretoSkew(Layers[0].P, SfcSlice.P);
    let Rio2 = GetSkewRatio(Layers[0].T);

    ctx.strokeStyle = CheckMode("rgba(255,175,126,1)", "rgba(125,85,65,1)");
    ctx.lineWidth = 4;

    ctx.strokeStyle = CheckMode("rgba(255,175,126,1)", "rgba(125,85,65,1)");
    ctx.beginPath();

    ctx.moveTo((Rio + PX) * Canv.width, PY * Canv.height);
    ctx.lineTo((Rio + PX) * Canv.width, PY * Canv.height);

    for (let i = 0; i < Sound.Slice.length - 1; i++) {
      if (Math.max(Start.P, End.P) >= Sound.Slice[i][0] && Math.min(Start.P, End.P) <= Sound.Slice[i][0]) {
        let Obj = ConvertToInfo(Sound.Slice[i]);

        let PosX = LevelToSkewNum(Obj.P, SfcSlice.P);
        let PosY = PressuretoSkew(Obj.P, SfcSlice.P);
        let Ratio = GetSkewRatio(Obj.T);

        ctx.lineTo((Ratio + PosX) * Canv.width, PosY * Canv.height);
        ctx.moveTo((Ratio + PosX) * Canv.width, PosY * Canv.height);
      }
    }
    let PsX = LevelToSkewNum(Layers[Layers.length - 1].P, SfcSlice.P);
    let PsY = PressuretoSkew(Layers[Layers.length - 1].P, SfcSlice.P);
    let Rtio = GetSkewRatio(Layers[Layers.length - 1].T);

    let PsX2 = LevelToSkewNum(End.P, SfcSlice.P);
    let PsY2 = PressuretoSkew(End.P, SfcSlice.P);
    let Rtio2 = GetSkewRatio(Math.max(-30, End.T));

    ctx.strokeStyle = "rgba(255,175,126,1)";
    ctx.lineTo((Rtio2 + PsX2) * Canv.width, PsY2 * Canv.height);


    ctx.stroke();
    ctx.fill();
  }
}

/** Draws dry adiabat content.
 * @param {*} thta Parameter for dry_adiabat.
 * @param {*} style Parameter for dry_adiabat.
 * @returns {void} No value.
 */
function dry_adiabat(thta, style = null) {
  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");
  const dropsondeMode = !!root.querySelector(".sjs-viz.dropsonde-mode");

  ctx.beginPath();
  ctx.lineWidth = style?.lineWidth ?? 1;
  ctx.strokeStyle = style?.strokeStyle
    ?? (DarkMode == true && "rgba(255,255,255,0.2)" || "rgba(0,0,0,0.2)");
  
  if (dropsondeMode){
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  } else {
    ctx.lineCap = "butt";
    ctx.lineJoin = "butt";
  }  

  const adiabatBot = skv.pbot;
  const adiabatTop = Math.max(50, skv.ptop - 20);
  for (var pres = adiabatBot; pres >= adiabatTop; pres -= 10) {
    // temp = 2;
    var temp = ((thta + 273.15) / Math.pow(1000 / pres, ROCP)) - 273.15;
    let x = LevelToSkewNum(pres, adiabatBot);
    let y = PressuretoSkew(pres, adiabatBot);
    let r = GetSkewRatio(temp);
    if (pres == adiabatBot) {
      ctx.moveTo((r + x) * Canv.width, y * Canv.height);
    }

    ctx.lineTo((r + x) * Canv.width, y * Canv.height);
  }
  ctx.stroke();
}


/** Returns 3 cape color data.
 * @param {*} N Parameter for Get3CapeColor.
 * @returns {*} Result of the function.
 */
function Get3CapeColor(N) {
  if (N <= 50) {
    return "rgba(255,255,255,1)";
  } else if (N <= 100 && N > 50) {
    return "rgba(255,255,0,1)";
  } else if (N <= 200 && N > 100) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(255,0,255,1)";
  }
}

/** Returns 6 cape color data.
 * @param {*} N Parameter for Get6CapeColor.
 * @returns {*} Result of the function.
 */
function Get6CapeColor(N) {
  if (N <= 400) {
    return "rgba(255,255,255,1)";
  } else if (N <= 800 && N > 400) {
    return "rgba(255,255,0,1)";
  } else if (N <= 1200 && N > 800) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(255,0,255,1)";
  }
}

/** Returns cin color data.
 * @param {*} N Parameter for GetCinColor.
 * @returns {*} Result of the function.
 */
function GetCinColor(N) {
  if (N > -50) {
    return "rgba(0,255,0,1)";
  } else if (N > -100) {
    return "rgba(255,255,0,1)";
  } else if (N > -200) {
    return "rgba(255,0,0,1)";
  } else {
    return "rgba(125,175,0,1)";
  }
}

var __ShowECape = true;

/** Draws values key content.
 * @param {*} Text Parameter for ValuesKeyRep.
 * @param {*} Scaler Parameter for ValuesKeyRep.
 * @param {*} Add Parameter for ValuesKeyRep.
 * @param {*} Total Parameter for ValuesKeyRep.
 * @param {*} ST Parameter for ValuesKeyRep.
 * @param {*} HeaderSize Parameter for ValuesKeyRep.
 * @returns {*} Result of the function.
 */
function ValuesKeyRep(Text, Scaler, Add, Total, ST, HeaderSize) {
  const Canv = $("Values1");
  const ctx = Canv.getContext("2d");

  ctx.font = `bold ${HeaderSize}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(Text, Canv.width * (ST + Scaler / Total), Canv.height * 0.15);
  return Scaler + Add;
}

/** Draws values key content.
 * @returns {void} No value.
 */
function DrawValuesKey() {
  const Canv = $("Values1");
  const ctx = Canv.getContext("2d");

  Canv.width = 900;
  Canv.height = 175;

  let Scale = 1;
  let typeR = "Parcel";

  let Scaler = 0;
  let ST = 0.085;
  let Total = 33;

  let HeaderSize = Canv.width / 42.5;

  ctx.fillStyle = "rgba(255,255,255,1)";

  ctx.fillRect(Canv.width * 0.02, Canv.height * 0.175, Canv.width * 0.96, 2);

  Scaler = ValuesKeyRep(`Parcel`, Scaler, 3.85, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`ECAPE`, Scaler, 3.25, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`NCAPE`, Scaler, 2.95, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`CAPE`, Scaler, 3, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`3CAPE`, Scaler, 3, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`6CAPE`, Scaler, 3, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`CINH`, Scaler, 2.9, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`LCL`, Scaler, 3, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`LFC`, Scaler, 3, Total, ST, HeaderSize);
  Scaler = ValuesKeyRep(`EL`, Scaler, 3, Total, ST, HeaderSize);
}

/** Draws values content.
 * @param {*} Text Parameter for ValuesRep.
 * @param {*} Color Parameter for ValuesRep.
 * @param {*} Scale Parameter for ValuesRep.
 * @param {*} Scaler Parameter for ValuesRep.
 * @param {*} Add Parameter for ValuesRep.
 * @param {*} Total Parameter for ValuesRep.
 * @param {*} ST Parameter for ValuesRep.
 * @param {*} HeaderSize Parameter for ValuesRep.
 * @param {*} cs Parameter for ValuesRep.
 * @param {*} left Parameter for ValuesRep.
 * @returns {*} Result of the function.
 */
function ValuesRep(Text, Color, Scale, Scaler, Add, Total, ST, HeaderSize, cs = false, left = false) {
  const Canv = $("Values1");
  const ctx = Canv.getContext("2d");

  if (cs) {
    if (left) {
      ctx.font = `700 ${HeaderSize}px ${globalFont}`;
      ctx.textAlign = "left";
    } else {
      ctx.font = `550 ${HeaderSize}px ${globalFont}`;
      ctx.textAlign = "center";
    }
  } else {
    ctx.font = `${HeaderSize}px ${globalFont}`;
    ctx.textAlign = "center";
  }

  ctx.fillStyle = Color;
  ctx.fillText(Text, Canv.width * (ST + Scaler / Total), Canv.height * (0.1 + 0.2 * Scale));

  return Scaler + Add;
}

/** Draws values content.
 * @param {*} type Parameter for DrawValues.
 * @param {*} Values Parameter for DrawValues.
 * @param {*} Selected Parameter for DrawValues.
 * @returns {void} No value.
 */
function DrawValues(type, Values, Selected = false) {
  const Canv = $("Values1");
  const ctx = Canv.getContext("2d");

  let Scale = 1;
  let typeR = "Parcel";

  let Scaler = 0;
  let ST = 0.01;
  let Total = 33;

  if (type == "SB") {
    Scale = 1.2;
    typeR = "Surface-Based";
  } else if (type == "ML") {
    Scale = 2.2;
    typeR = "Mixed-Layer";
  } else if (type == "MU") {
    Scale = 3.2;
    typeR = "Most Unstable";
  } else if (type == "CU") {
    Scale = 4.2;
    if (CUPrcl.Path == false) {
      typeR = `Custom (900mb)`;
    } else {
      typeR = `Custom (${Math.round(CUPrcl.Start.P)}mb)`;
    }
  }

  if (Selected == true) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(Canv.width * (0.005 + Scaler / 22), Canv.height * (0.165 + 0.2 * (Scale - 1)), 0.99 * Canv.width, 0.2 * Canv.height);
  }

  let HeaderSize = Canv.width / 50;
  let WhiteColor = "rgba(255,255,255,1)";

  const heightUnit = useImperialUnits === 2 ? "ft" : "m";

  ctx.fillStyle = WhiteColor;
  //Parcel Type
  Scaler = ValuesRep(`${typeR}`, WhiteColor, Scale, Scaler, 6.5, Total, ST, HeaderSize, true, true);
  //Ecape
  Scaler = ValuesRep(`${(Values.ECape.Cape !== "--" ? Math.floor(Values.ECape.Cape) : "--")} `, GetCapeColor(Values.ECape.Cape), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //NCape
  Scaler = ValuesRep(`${(Values.NCape !== "--" ? Math.floor(100 * Values.NCape) / 100 : "--")} `, GetCapeColor(Values.NCape * 10000), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //Cape
  Scaler = ValuesRep(`${Math.floor(Values.Cape)}`, GetCapeColor(Values.Cape), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //3cape
  Scaler = ValuesRep(`${Math.floor(Values.Cape3)}`, Get3CapeColor(Values.Cape3), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //6Cape
  Scaler = ValuesRep(`${Math.floor(Values.Cape6)}`, Get6CapeColor(Values.Cape6), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //CINH
  Scaler = ValuesRep(`${Math.floor(Values.CINH)}`, GetCinColor(Values.CINH), Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //LCL
  const lclValue = Values.LCL === -9999 ? "--" : Math.floor(useImperialUnits === 2 ? MToFt(Values.LCL) : Values.LCL);
  Scaler = ValuesRep(`${lclValue}${heightUnit}`, WhiteColor, Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //LFC
  const lfcValue = Values.LFC === -9999 ? "--" : Math.floor(useImperialUnits === 2 ? MToFt(Values.LFC) : Values.LFC);
  Scaler = ValuesRep(`${lfcValue}${heightUnit}`, WhiteColor, Scale, Scaler, 3, Total, ST, HeaderSize, true);
  //EL
  const elValue = Values.EL === -9999 ? "--" : Math.floor(useImperialUnits === 2 ? MToFt(Values.EL) : Values.EL);
  Scaler = ValuesRep(`${elValue}${heightUnit}`, WhiteColor, Scale, Scaler, 3, Total, ST, HeaderSize, true);
}

var HodographCenter = [50, 50]

/** Draws inflow hodo content.
 * @param {*} Sounding Parameter for DrawInflowHodo.
 * @param {*} inflowInfo Parameter for DrawInflowHodo.
 * @param {*} BRM Parameter for DrawInflowHodo.
 * @returns {void} No value.
 */
function DrawInflowHodo(Sounding, inflowInfo, BRM) {
  // SRH fill is painted inside DrawHodograph so it stays aligned with
  // the wind trace, scale, and storm-relative offset. Kept as a no-op
  // because existing callers still invoke this after a hodograph redraw.
}

/** Draws inflow content.
 * @param {*} Sounding Parameter for DrawInflow.
 * @param {*} Info Parameter for DrawInflow.
 * @returns {void} No value.
 */
function DrawInflow(Sounding, Info) {
  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");

  if (Info == false) {
    return;
  }

  let BotLayer = GetLayerByPres(Sounding, Info.Bot);
  let TopLayer = GetLayerByPres(Sounding, Info.Top);

  ctx.fillStyle = "rgb(125, 200, 255)";

  let Y0 = PressuretoSkew(Info.Bot);
  let Y1 = PressuretoSkew(Info.Top);

  let SRH = GetSRH(Sounding, BotLayer.P, TopLayer.P, "Pres");
  let ST = GetLayerByPres(Sounding, "SFC").H;

  ctx.fillRect(0.24 * Canv.width, Y0 * Canv.height, 0.05 * Canv.width, 2 + 0.005 * Canv.height);

  ctx.font = `normal 550 ${Canv.width / 50}px ${globalFont}`;
  ctx.textAlign = "center";

  if (Info.isSfc) {
    ctx.fillText(`SFC`, Canv.width * (0.2), Y0 * Canv.height + (2 + 0.005 * Canv.height));
  } else {
    ctx.fillText(`${Math.round(BotLayer.H - ST)}m`, Canv.width * (0.2), Y0 * Canv.height + (2 + 0.005 * Canv.height));
  }


  ctx.fillText(`${Math.round(TopLayer.H - ST)}m`, Canv.width * (0.2), Y1 * Canv.height - (2 + 0.005 * Canv.height));

  ctx.textAlign = "left";
  ctx.fillText(`${Math.round(SRH.SRHP + SRH.SRHM)} m²/s²`, Canv.width * (0.24), (Y1 - 0.02) * Canv.height);
  ctx.fillRect(0.265 * Canv.width - 2, Y0 * Canv.height, 4, (Y1 - Y0) * Canv.height);

  ctx.fillRect(0.24 * Canv.width, Y1 * Canv.height - (2 + 0.005 * Canv.height), 0.05 * Canv.width, 2 + 0.005 * Canv.height);
}

/** Returns the color for a lapse rate based on its value.
 * @param {*} N Parameter for LapseRateColor.
 * @returns {*} Result of the function.
 */
function LapseRateColor(N) {
  if (N == "--") {
    return "rgba(125,125,125,1)";
  }

  if (N < 5.5) {
    return "rgba(125,125,125,1)";
  } else if (N >= 5.5 && N < 6) {
    return "rgba(125,125,200,1)";
  } else if (N >= 6 && N < 6.5) {
    return "rgba(75,255,75,1)";
  } else if (N >= 6.5 && N < 7) {
    return "rgba(200,200,50,1)";
  } else if (N >= 7 && N < 7.5) {
    return "rgba(200,100,0,1)";
  } else if (N >= 7.5 && N < 8) {
    return "rgba(255,55,55,1)";
  } else if (N >= 8 && N < 9) {
    return "rgba(255,0,125,1)";
  } else {
    return "rgba(255,255,255,1)";
  }
}

/** Converts lapse values.
 * @param {*} rate Parameter for convertLapse.
 * @returns {*} Result of the function.
 */
const convertLapse = (rate) => {
  if (rate === "--") return "--";
  return useImperialUnits === 2 ? Math.round(100 * CPerKmToCPerKft(rate)) / 100 : rate;
};


/** Draws storm motion content.
 * @param {*} Sounding Parameter for StormMotionBox.
 * @returns {void} No value.
 */
function StormMotionBox(Sounding){
  const Canv2 = $("Values2");
  const ctx2 = Canv2.getContext("2d");

  Canv2.width = 500;//Canv.style.width;
  Canv2.height = 275;

  ctx2.fillStyle = "rgb(0, 0, 0)";
  ctx2.fillRect(0, 0, 1000, 1000)

  const impSpd = useImperialUnits === 2;
  const srSpdMax = impSpd ? KtsToMph(80) : 80;
  const envSpdMax = impSpd ? KtsToMph(140) : 140;
  const spdUnitLbl = impSpd ? "mph" : "kt";


  /**
   * Scale storm-relative wind speed to the storm-motion chart's horizontal percentage.
   * @param {number} wndKts Wind speed (in kt).
   * @returns {number} Horizontal chart position (in percent).
   */
  function srWindXfract(wndKts) {
    const v = impSpd ? KtsToMph(wndKts) : wndKts;
    return 100 * (v / srSpdMax);
  }

  /**
   * Scale environmental wind speed to the environmental-wind chart's horizontal percentage.
   * @param {number} wndKts Wind speed (in kt).
   * @returns {number} Horizontal chart position (in percent).
   */
  function envWindXfract(wndKts) {
    const v = impSpd ? KtsToMph(wndKts) : wndKts;
    return 100 * (v / envSpdMax);
  }

  let BRM = GetBM(Sounding, GlobalEffInflow);
  let FntSiz = Canv2.width / 20;

  ctx2.fillStyle = "rgba(255,255,255,1)";

  ctx2.font = `600 ${FntSiz*1.25}px ${globalFont}`;
  ctx2.textAlign = "center";
  ctx2.fillText(`Storm Motions:`, Canv2.width * 0.5, Canv2.height * 0.1);
  ctx2.fillRect(Canv2.width * 0.05, Canv2.height * 0.13, Canv2.width * 0.9, 3);

  let MotionRows = [
    ["Bunkers Right", ConvertCartToPolarRealRnd(BRM.RM)], 
    ["Bunkers Left", ConvertCartToPolarRealRnd(BRM.LM)], 
    ["Mean Motion", ConvertCartToPolarRealRnd(BRM.MM)],
    ["Corfidi Upshear", ConvertCartToPolarRealRnd(BRM.US)], 
    ["Corfidi Downshear", ConvertCartToPolarRealRnd(BRM.DS)],
    ["Nixon Deviant Right", ConvertCartToPolarRealRnd(BRM.DTMR)], 
    ["Nixon Deviant Left", ConvertCartToPolarRealRnd(BRM.DTML)]
  ];

  MotionRows[3][1].WD = 180 - MotionRows[3][1].WD + 360;
  MotionRows[3][1].WD %= 360;
  let XP = 0;
  let XR = 333;

  let YP = 0.255;
  let YR = 66;
  MotionRows.forEach((N) => {
    ctx2.fillStyle = "rgb(208, 255, 253)";

    ctx2.font = `700 ${FntSiz * 1.1}px ${globalFont}`;
    ctx2.textAlign = "left";
    ctx2.fillText(`${N[0]}:`, 10, Canv2.height * YP);

    ctx2.fillStyle = "rgb(255, 211, 211)";

    ctx2.font = `500 ${FntSiz * 1.1}px ${globalFont}`;
    ctx2.textAlign = "right";
    const motWs = N[1].WS;
    const motWsDisp =
          isNaN(motWs)
            ? "--"
            : impSpd
              ? Math.round(KtsToMph(motWs))
              : Math.round(100 * motWs) / 100;
    ctx2.fillText(
      `${isNaN(N[1].WD) ? "--" : Math.round(10 * N[1].WD) / 10}° / ${motWsDisp}${motWsDisp === "--" ? "" : spdUnitLbl}`,
      490,
      Canv2.height * YP,
    );
    
    YP += 0.75 * 1/6.4;
  })
}

/** Returns lapse box data.
 * @param {*} Sounding Parameter for GetLapseBox.
 * @returns {void} No value.
 */
function GetLapseBox(Sounding) {
  const Canv = $("Values2");
  const ctx = Canv.getContext("2d");

  Canv.width = 500;//Canv.style.width;
  Canv.height = 275;

  if (DisplayStormMotions){
    StormMotionBox(Sounding)
    return;
  }

  let StartSlice = GetLayerByPres(Sounding, "SFC");
  const sh = StartSlice.H;

  let LLLR = LapseRateHght(Sounding, "SFC", 3000 + sh, LapseType, 100);
  let LSLR = LapseRateHght(Sounding, "SFC", ((DP.Start != undefined && DP.Start.H || 0) + DP.LCL+ sh) || 1000, LapseType, 100);
  let LFCLR = LapseRateHght(Sounding, "SFC", ((DP.Start != undefined && DP.Start.H || 0) + DP.LFC+ sh) || 1000, LapseType, 100);
  let MLLR = LapseRateHght(Sounding, 3000+ sh, 6000 + sh, LapseType, 100);
  let MMR = LapseRatePres(Sounding, 700, 500, LapseType, 100);
  let LMR = LapseRatePres(Sounding, 850, 500, LapseType, 100);
  let MaxLR = 0;

  for (let i = 2000; i < 5000; i+=250){
    MaxLR = Math.max(MaxLR, LapseRateHght(Sounding, i+ sh, i + 1000 + sh, LapseType, 100)) 
  }
  let CL = CustomLapseLayer.Lapse;

  let Scale = .75;

  const lapseUnit = useImperialUnits === 2 ? "C/kft" : "C/KM";
  const lapseType = LapseType ? "AvLR" : "LR";

  ctx.font = `bold ${Canv.width / 16}px ${globalFont}`;

  if (Presets['WindLapse'] == "Default" || Presets['WindLapse'] == "Dryline") {
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Sfc-3km ${lapseType}`, Scale, LLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 210, 210)", `3km-6km ${lapseType}`, Scale, MLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 165, 165)", `Sfc-LCL ${lapseType}`, Scale, LSLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 120, 120)", `850-500mb ${lapseType}`, Scale, LMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 65, 65)", `700-500mb ${lapseType}`, Scale, MMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Max 2-6km ${lapseType}`, Scale, MaxLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `${CustomLapseLayer.Title} ${lapseType}`, Scale, CL, lapseUnit, 1)
  } else if (Presets['WindLapse'] == "Severe" || Presets['WindLapse'] == "Elevated") {
    let LFCELLR = LapseRateHght(Sounding, ((DP.Start != undefined && DP.Start.H || 0) + DP.LFC+ sh) || 0, ((DP.Start != undefined && DP.Start.H || 0) + DP.EL+ sh) || 3000, LapseType, 100);
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Sfc-3km ${lapseType}`, Scale, LLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 210, 210)", `3km-6km ${lapseType}`, Scale, MLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 165, 165)", `LFC-EL ${lapseType}`, Scale, LFCELLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 120, 120)", `850-500mb ${lapseType}`, Scale, LMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 65, 65)", `700-500mb ${lapseType}`, Scale, MMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Max 2-6km ${lapseType}`, Scale, MaxLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `${CustomLapseLayer.Title} ${lapseType}`, Scale, CL, lapseUnit, 1)
  } else if (Presets['WindLapse'] == "Fire") {
    let SLLLR = LapseRateHght(Sounding, "SFC", 1000+ sh, LapseType, 100);
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Sfc-1km ${lapseType}`, Scale, SLLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 210, 210)", `Sfc-3km ${lapseType}`, Scale, LLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 165, 165)", `Sfc-LFC ${lapseType}`, Scale, LFCLR == LFCLR ? LFCLR : LSLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 120, 120)", `850-500mb ${lapseType}`, Scale, LMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 65, 65)", `700-500mb ${lapseType}`, Scale, MMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Max 2-6km ${lapseType}`, Scale, MaxLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `${CustomLapseLayer.Title} ${lapseType}`, Scale, CL, lapseUnit, 1)
  } else if (Presets['WindLapse'] == "Winter") {
    let DGZLR = LapseRatePres(Sounding, GetLayerByTemp(Sounding, -12).P, GetLayerByTemp(Sounding, -18).P, LapseType, 100);
    let FRZLR = LapseRateHght(Sounding, "SFC", Math.max(GetLayerByTemp(Sounding, 0).H, 250)+ sh, LapseType, 100);
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Sfc-3km ${lapseType}`, Scale, LLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 210, 210)", `3km-6km ${lapseType}`, Scale, MLLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 165, 165)", `DGZ ${lapseType}`, Scale, DGZLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 120, 120)", `SFC-0C ${lapseType}`, Scale, FRZLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 65, 65)", `700-500mb ${lapseType}`, Scale, MMR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `Max 2-6km ${lapseType}`, Scale, MaxLR, lapseUnit, 1)
    Scale = LapseBoxStep(ctx, Canv, "rgb(255, 255, 255)", `${CustomLapseLayer.Title} ${lapseType}`, Scale, CL, lapseUnit, 1)
  }
}

/** Lapse rate box step function.
 * @param {*} ctx Parameter for LapseBoxStep.
 * @param {*} Canv Parameter for LapseBoxStep.
 * @param {*} color Parameter for LapseBoxStep.
 * @param {*} Title Parameter for LapseBoxStep.
 * @param {*} Scale Parameter for LapseBoxStep.
 * @param {*} Value Parameter for LapseBoxStep.
 * @param {*} lapseUnit Parameter for LapseBoxStep.
 * @param {*} Step Parameter for LapseBoxStep.
 * @returns {*} Result of the function.
 */
function LapseBoxStep(ctx, Canv, color, Title, Scale, Value, lapseUnit, Step) {
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.font = `bold ${Canv.width / 17}px ${globalFont}`;
  ctx.fillText(Title, 0.05 * Canv.width, Canv.height * Scale / 7);
  ctx.fillStyle = LapseRateColor(Value);
  ctx.textAlign = "right";
  ctx.font = `bold ${Canv.width / 17}px ${globalFont}`;
  ctx.fillText(`${convertLapse(Value)} ${lapseUnit}`, 0.95 * Canv.width, Canv.height * Scale / 7);
  return Scale + Step;
}

/** Returns the color for a step based on its value.
 * @param {*} N Parameter for StepColor.
 * @returns {*} Result of the function.
 */
function StepColor(N) {
  if (N <= 1) {
    return "rgba(125,125,125,1)";
  } else if (N <= 3 && N > 1) {
    return "rgba(0, 139, 0,1)";
  } else if (N <= 8 && N > 3) {
    return "rgba(139, 71, 38 ,1)";
  } else if (N <= 15 && N > 8) {
    return "rgba(255, 200, 0 ,1)";
  } else if (N <= 25 && N > 15) {
    return "rgba(255,0,0,1)";
  } else if (N <= 45 && N > 25) {
    return "rgba(255, 0, 255 ,1)";
  } else if (N <= 60 && N > 45) {
    return "rgba(145, 44, 238 ,1)";
  } else if (N <= 85 && N > 60) {
    return "rgba(35, 110, 185,1)";
  } else {
    return "rgba(255,255,255,1)";
  }
}


/** Cleans the canvas.
 * @returns {void} No value.
 */
function Clean() {
  let tempN = DarkMode == true && "rgba(0,0,0,1)" || "rgba(255,255,255,1)";
  const clearId = (id) => {
    const el = $(id);
    if (!el) return;
    const c = el.getContext("2d");
    if (!c) return;
    c.fillStyle = tempN;
    c.fillRect(0, 0, 1000, 1000);
  };
  clearId("hodograph");
  clearId("skewT");
  clearId("Values1");
  clearId("Values2");
  clearId("Values3");
  clearId("Values4");
  clearId("Values5");
  clearId("verticalGraph");
}

let CSMot = {};

/** Returns the critical angle between storm motion and wind shear.
 * @param {*} srWind Parameter for criticalAngle.
 * @param {*} shear Parameter for criticalAngle.
 * @returns {*} Result of the function.
 */
function criticalAngle(srWind, shear) {
    const dot = srWind.x * shear.x + srWind.y * shear.y;
    const magA = Math.sqrt(srWind.x**2 + srWind.y**2);
    const magB = Math.sqrt(shear.x**2 + shear.y**2);
    const cosAngle = dot / (magA * magB);
    return Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;
}

/** Draws wind params content.
 * @param {*} Sounding Parameter for DrawWindParams.
 * @param {*} WindParams Parameter for DrawWindParams.
 * @returns {void} No value.
 */
function DrawWindParams(Sounding, WindParams) {
  coerceTornadoClimoToGraphIfNeeded(Sounding);
  const Canv = $("Values5");
  const ctx = Canv.getContext("2d");

  Canv.width = 800;
  Canv.height = 400;
  
  let Scale = 1;

  let Scaler = 0.5;
  let TS = 23.7;

  if (!DisplayEHI) TS -= 2.8;

  ctx.fillStyle = "rgba(255,255,255,1)";

  ctx.fillRect(0.025 * Canv.width, 0.125 * Canv.height, 0.95 * Canv.width, 2);

  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`Level`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  Scaler += 4.2;

  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`Shear`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  Scaler += 3.55;

  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`SRH`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  Scaler += 3.6;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`SRWind`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  if (DisplayEHI){
    Scaler += 2.8;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
    ctx.textAlign = "center";
    ctx.fillText(`EHI`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);
  }
  

  Scaler += 2.8;
  
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`SW%`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  Scaler += 2.5;
  
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText(`SWV`, Canv.width * (0.1 + Scaler / TS), Canv.height * 0.1);

  let Ps = [

  ];

  let Index = {
    "Sfc-500m": ["Sfc-500m", WindParams.BWD005, WindParams.SRH005, WindParams.MeanWind.M005, WindParams.EHI005, WindParams.SWV.SWV005, WindParams.SWV.SWPercent005, "rgba(255,255,255,1)"],
    "Sfc-1km": ["Sfc-1km", WindParams.BWD01, WindParams.SRH01, WindParams.MeanWind.M01, WindParams.EHI01, WindParams.SWV.SWV01, WindParams.SWV.SWPercent01, "rgba(225,225,255,1)"],
    "Eff Inflow": ["Eff Inflow", WindParams.BWDE, WindParams.ESRH == 0 ? {SRHM: NaN, SRHP: NaN} : WindParams.ESRH, WindParams.MeanWind.ME, WindParams.EHIE, WindParams.SWV.ESWV, WindParams.SWV.ESWVPercent, "rgba(0,255,255,1)"], 
    "Sfc-3km": ["Sfc-3km", WindParams.BWD03, WindParams.SRH03, WindParams.MeanWind.M03, WindParams.EHI03, WindParams.SWV.SWV03, WindParams.SWV.SWPercent03, "rgba(200,200,255,1)"],
    "1km-3km": ["1km-3km", WindParams.BWD13, WindParams.SRH13, WindParams.MeanWind.M13, WindParams.EHI13, WindParams.SWV.SWV13, WindParams.SWV.SWPercent13, "rgba(175,175,255,1)"],
    "3km-6km": ["3km-6km", WindParams.BWD36, WindParams.SRH36, WindParams.MeanWind.M36, WindParams.EHI36, WindParams.SWV.SWV36, WindParams.SWV.SWPercent36, "rgba(150,150,255,1)"],
    "Sfc-6km": ["Sfc-6km", WindParams.BWD06, WindParams.SRH06, WindParams.MeanWind.M06, WindParams.EHI06, WindParams.SWV.SWV06, WindParams.SWV.SWPercent06, "rgba(125,125,255,1)"],
    "Cstm": [CustomWindLayer.Title, CustomWindLayer.SHR, CustomWindLayer.SRH, CustomWindLayer.MW, CustomWindLayer.EHI, CustomWindLayer.SWV, CustomWindLayer.SWVPercent, "rgba(255,255,255,1)", true],
    "Sfc-MLLFC": ["Sfc-MLLFC", WindParams.BWD0MLLFC, WindParams.SRH0MLLFC, WindParams.MeanWind.M0MLLFC, WindParams.EHI0MLLFC, WindParams.SWV.SWV0MLLFC, WindParams.SWV.SWPercent0MLLFC, "rgba(175,175,255,1)"],
    "Sfc-SBLCL": ["Sfc-SBLCL", WindParams.BWD0SBLCL, WindParams.SRH0SBLCL, WindParams.MeanWind.M0SBLCL, WindParams.EHI0SBLCL, WindParams.SWV.SWV0SBLCL, WindParams.SWV.SWPercent0SBLCL, "rgba(150,150,255,1)"],
    "Eff Bot-1km": ["Eff Bot-1km", WindParams.BWDEb01, WindParams.SRHEb01, WindParams.MeanWind.MEb01, WindParams.EHIEb01, WindParams.SWV.SWVb01, WindParams.SWV.SWPercentb01, "rgba(255, 225, 225, 1)"],
    "Eff Bot-3km": ["Eff Bot-3km", WindParams.BWDEb03, WindParams.SRHEb03, WindParams.MeanWind.MEb03, WindParams.EHIEb03, WindParams.SWV.SWVb03, WindParams.SWV.SWPercentb03, "rgba(210, 195, 195, 1)"],
    "Eff Bot-6km": ["Eff Bot-6km", WindParams.BWDEb06, WindParams.SRHEb06, WindParams.MeanWind.MEb06, WindParams.EHIEb06, WindParams.SWV.SWVb06, WindParams.SWV.SWPercentb06, "rgba(175, 150, 150, 1)"],
    "HGZ": ["HGZ", WindParams.BWDHGZ, WindParams.SRHHGZ, WindParams.MeanWind.MHGZ, WindParams.EHIHGZ, WindParams.SWV.SWVHGZ, WindParams.SWV.SWPercentHGZ, "rgb(255, 197, 150)"],  
    "Sfc-9km": ["Sfc-9km", WindParams.BWD09, WindParams.SRH09, WindParams.MeanWind.M09, WindParams.EHI09, WindParams.SWV.SWV09, WindParams.SWV.SWPercent09, "rgba(200,200,255,1)"],
    "Sfc-12km": ["Sfc-12km", WindParams.BWD012, WindParams.SRH012, WindParams.MeanWind.M012, WindParams.EHI012, WindParams.SWV.SWV012, WindParams.SWV.SWPercent012, "rgba(175,175,255,1)"],
    "9-12km": ["9-12km", WindParams.BWD912, WindParams.SRH912, WindParams.MeanWind.M912, WindParams.EHI912, WindParams.SWV.SWV912, WindParams.SWV.SWPercent912, "rgba(125,125,255,1)"],
    "Sfc-700mb": ["Sfc-700mb", WindParams.BWD0mb700, WindParams.SRH0mb700, WindParams.MeanWind.M0mb700, WindParams.EHI0mb700, WindParams.SWV.SWV0mb700, WindParams.SWV.SWPercent0mb700, "rgba(150,150,255,1)"],
    "Sfc-500mb": ["Sfc-500mb", WindParams.BWD0mb500, WindParams.SRH0mb500, WindParams.MeanWind.M0mb500, WindParams.EHI0mb500, WindParams.SWV.SWV0mb500, WindParams.SWV.SWPercent0mb500, "rgba(125,125,255,1)"],
    "DGZ": ["DGZ", WindParams.BWDDGZ, WindParams.SRHDGZ, WindParams.MeanWind.MDGZ, WindParams.EHIDGZ, WindParams.SWV.SWVDGZ, WindParams.SWV.SWPercentDGZ, "rgb(255, 197, 150)"],
    "Sfc-DGZ": ["SFC-DGZ", WindParams.BWD0T18, WindParams.SRH0T18, WindParams.MeanWind.M0T18, WindParams.EHI0T18, WindParams.SWV.SWV0T18, WindParams.SWV.SWPercent0T18, "rgba(175, 200,255,1)"],
  }

  if (Presets['WindLapse'] == "Default") {
    Ps = [
      Index["Sfc-500m"],
      Index["Sfc-1km"],
      Index["Eff Inflow"],
      Index["Sfc-3km"],
      Index["1km-3km"],
      Index["3km-6km"],
      Index["Sfc-6km"],
      Index["Cstm"],
    ];
  } else if (Presets['WindLapse'] == "Dryline"){
    Ps = [
      Index["Sfc-500m"],
      Index["Sfc-1km"],
      Index["Eff Inflow"],
      Index["Sfc-3km"],
      Index["Sfc-MLLFC"],
      Index["Sfc-SBLCL"],
      Index["Sfc-6km"],
      Index["Cstm"],
    ];
  } else if (Presets['WindLapse'] == "Elevated"){
    Ps = [
      Index["Eff Inflow"],
      Index["Sfc-1km"],
      Index["Sfc-3km"],
      Index["Sfc-6km"],
      Index["Eff Bot-1km"],
      Index["Eff Bot-3km"],
      Index["Eff Bot-6km"],
      Index["Cstm"],
    ];
  } else if (Presets['WindLapse'] == "Severe") {
    Ps = [
      Index["Sfc-3km"],
      Index["Sfc-6km"],
      Index["Eff Inflow"],
      Index["HGZ"],
      Index["Sfc-9km"],
      Index["Sfc-12km"],
      Index["9-12km"],
      Index["Cstm"],
    ];
  } else if (Presets['WindLapse'] == "Fire") {
    Ps = [
      Index["Sfc-500m"],
      Index["Sfc-1km"],
      Index["Eff Inflow"],
      Index["Sfc-3km"],
      Index["1km-3km"],
      Index["Sfc-700mb"],
      Index["Sfc-500mb"],
      Index["Cstm"],
    ];
  } else if (Presets['WindLapse'] == "Winter") {
    Ps = [
      Index["Sfc-3km"],
      Index["Sfc-6km"],
      Index["Sfc-9km"],
      Index["DGZ"],
      Index["Sfc-DGZ"],
      Index["Sfc-500mb"],
      Index["Cstm"],
    ];
  }

  const FntSize = Canv.width / 42.5;
  const FntSize2 = Canv.width / 33;

  Ps.forEach((obj) => {
    Scaler = 0.5;
    ctx.fillStyle = obj[7];

    if (obj[6] == true) {
      ctx.font = `700 ${FntSize2}px ${globalFont}`;
    } else {
      ctx.font = `700 ${FntSize2}px ${globalFont}`;
    }

    ctx.textAlign = "left";
    ctx.fillText(`${obj[0]}:`, Canv.width * (0.01 + Scaler / TS), Canv.height * (0.11 + Scale / Ps.length * 0.8));

    Scaler += 3;

    const speedUnit = useImperialUnits === 2 ? "mph" : "kt";
    let BWDS = ConvertCartToPolarRealRnd(obj[1]);
    let BWDAng = BWDS.WD;
    let bwdSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(BWDS.WS)) : Math.round(BWDS.WS);
    bwdSpeed = isNaN(bwdSpeed) ? "--" : bwdSpeed
    BWDAng = isNaN(BWDAng) ? "--" : Math.round(BWDAng)
    ctx.font = `500 ${FntSize}px ${globalFont}`;
    ctx.textAlign = "left";
    ctx.fillText(`${BWDAng} / ${bwdSpeed} ${speedUnit}`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));

    Scaler += 3.7;


    if (obj[0] == "Eff Inflow") {
      ctx.font = `500 ${FntSize}px ${globalFont}`;
      ctx.textAlign = "left";
      ctx.fillText(`${isNaN(obj[2]) ? "--" : Math.round(obj[2])} m²/s²`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));
    } else {

      ctx.font = `500 ${FntSize}px ${globalFont}`;
      ctx.textAlign = "left";
      ctx.fillText(`${isNaN(obj[2].SRHM) ? "--" : Math.round(obj[2].SRHP + obj[2].SRHM)} m²/s²`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));
    }

    Scaler += 3.4;

    let SRWind = {
      x: obj[3].x - CSMot.x,
      y: obj[3].y + CSMot.y,
    }

    

    let srws = ConvertCartToPolarRealRnd(SRWind);
    let srwSpeed = useImperialUnits === 2 ? Math.round(KtsToMph(srws.WS)) : Math.round(srws.WS);
    let srwAng = Math.round(srws.WD)
    srwSpeed = isNaN(srwSpeed) ? "--" : srwSpeed
    srwAng = isNaN(srwAng) ? "--" : srwAng
    ctx.font = `500 ${FntSize}px ${globalFont}`;
    ctx.textAlign = "left";
    ctx.fillText(`${srwAng} / ${srwSpeed} ${speedUnit}`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));

    Scaler += 3.5;

    if (DisplayEHI){
      ctx.font = `500 ${FntSize}px ${globalFont}`;
      ctx.textAlign = "left";

      ctx.fillText(`${isNaN(obj[4]) ? "--" : obj[4]}`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));
      Scaler += 2.5;
    }
    ctx.font = `500 ${FntSize}px ${globalFont}`;
    ctx.textAlign = "left";

    ctx.fillText(`${isNaN(obj[6]) ? "--" : Math.round(obj[6])}%`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));
    Scaler += 2.5;

    ctx.font = `500 ${FntSize}px ${globalFont}`;
    ctx.textAlign = "left";

    ctx.fillText(`${isNaN(obj[5]) ? "--" : Math.round(obj[5] * 1000)/1000}`, Canv.width * (0.1 + Scaler / TS), Canv.height * (0.1 + Scale / Ps.length * 0.8));
    
    Scale += 0.925;
  })

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillRect(0.1 * Canv.width, 0.9 * Canv.height, 0.8 * Canv.width, 2);

  Scale += 0.2;

  ctx.fillStyle = "rgba(255,255,255,1)";

  ctx.font = `600 ${FntSize}px ${globalFont}`;
  ctx.textAlign = "right";
  ctx.fillText(`EBWD: `, Canv.width * 0.125, Canv.height * (0.1 + Scale / Ps.length * 0.787));

  const spdUnit = useImperialUnits === 2 ? "mph" : "kt";

  let ebwds = ConvertCartToPolarRealRnd(WindParams['EBWD']);
  let ebwdang = ebwds.WD;
  let ebwdspeed = useImperialUnits === 2 ? Math.round(KtsToMph(Mag(WindParams['EBWD']))) : Math.round(Mag(WindParams['EBWD']));
  ebwdspeed = isNaN(ebwdspeed) ? "--" : ebwdspeed
  ebwdang = isNaN(ebwdang) ? "--" : Math.round(ebwdang)

  ctx.font = `600 ${FntSize}px ${globalFont}`;
  ctx.textAlign = "left";
  ctx.fillText(`${ebwdang} / ${ebwdspeed} ${spdUnit}`, Canv.width * 0.15, Canv.height * (0.1 + Scale / Ps.length * 0.787));

  ctx.fillStyle = "rgba(255,255,255,1)";

  ctx.font = `600 ${FntSize}px ${globalFont}`;
  ctx.textAlign = "right";
  ctx.fillText(`LCL - EL Shear: `, Canv.width * 0.775, Canv.height * (0.1 + Scale / Ps.length * 0.787));

  let lclel = ConvertCartToPolarRealRnd(WindParams['LCLELSHR']);
  let lclelang = lclel.WD;
  let lclelspeed = useImperialUnits === 2 ? Math.round(KtsToMph( Mag(WindParams['LCLELSHR']))) : Math.round( Mag(WindParams['LCLELSHR']));
  lclelspeed = isNaN(lclelspeed) ? "--" : lclelspeed
  lclelang = isNaN(lclelang) ? "--" : Math.round(lclelang)

  ctx.font = `600 ${FntSize}px ${globalFont}`;
  ctx.textAlign = "left";
  ctx.fillText(`${lclelang} / ${lclelspeed} ${spdUnit}`, Canv.width * 0.8, Canv.height * (0.1 + Scale / Ps.length * 0.787));


  const V8 = $("Values8");
  const V7 = $("Values7");
  const V6 = $("Values6");
  const V5 = $("Values5");
  const V4 = $("Values4");
  const hodoselect = $("hodoselector");
  const hodoin = $("hodoinsetcheck");

  if (VWPActive){
    hodoin.classList.toggle('hodographInsetVWP', true);
    hodoin.classList.toggle('hodographInset', false);

    hodoselect.classList.toggle('hodographValuesVWP', true);
    hodoselect.classList.toggle('hodographValues', false);

    V8.classList.toggle('skewthidden', false);
    V7.classList.toggle('skewthidden', false);
    V6.classList.toggle('skewthidden', true);
    V4.classList.toggle('skewthidden', true);

    V5.classList.toggle('Values5VWP', true);
    V5.classList.toggle('Values5', false);
  } else {
    hodoin.classList.toggle('hodographInsetVWP', false);
    hodoin.classList.toggle('hodographInset', true);

    V5.classList.toggle('Values5VWP', false);
    V5.classList.toggle('Values5', true);

    V8.classList.toggle('skewthidden', true);
    V7.classList.toggle('skewthidden', true);

    const graphCanvas = $("Values4");
    const climoCanvas = $("Values6");
      
    if (SidePanelMode === "Graph") {
      if (graphCanvas) graphCanvas.classList.remove('skewthidden');
      if (climoCanvas) climoCanvas.classList.add('skewthidden');
    } else {
      if (graphCanvas) graphCanvas.classList.add('skewthidden');
      if (climoCanvas) climoCanvas.classList.remove('skewthidden');
    }

    hodoselect.classList.toggle('hodographValuesVWP', false);
    hodoselect.classList.toggle('hodographValues', true);
  }

  if (VWPActive){
    DrawVWPInsets(Sounding);
  }
};

/**
 * Converts radians to degrees.
 * @param {number} radians The angle in radians.
 * @returns {number} The angle in degrees.
 */
function radiansToDegrees(radians) {
  return radians * (180 / Math.PI);
}

/** Draws vwpinsets content.
 * @param {*} Sounding Parameter for DrawVWPInsets.
 * @returns {void} No value.
 */
function DrawVWPInsets(Sounding){
    const Canv2 = $("Values7");
    const ctx2 = Canv2.getContext("2d");

    Canv2.width = 700;
    Canv2.height = 200;
    ctx2.fillStyle = "rgb(0, 0, 0)";
    ctx2.fillRect(0, 0, 1000, 1000)

    const impSpd = useImperialUnits === 2;
    const srSpdMax = impSpd ? KtsToMph(80) : 80;
    const envSpdMax = impSpd ? KtsToMph(140) : 140;
    const spdUnitLbl = impSpd ? "mph" : "kt";

    /**
     * Scale storm-relative wind speed to the VWP inset's horizontal percentage.
     * @param {number} wndKts Wind speed (in kt).
     * @returns {number} Horizontal chart position (in percent).
     */
    function srWindXfract(wndKts) {
      const v = impSpd ? KtsToMph(wndKts) : wndKts;
      return 100 * (v / srSpdMax);
    }

    /**
     * Scale environmental wind speed to the VWP inset's horizontal percentage.
     * @param {number} wndKts Wind speed (in kt).
     * @returns {number} Horizontal chart position (in percent).
     */
    function envWindXfract(wndKts) {
      const v = impSpd ? KtsToMph(wndKts) : wndKts;
      return 100 * (v / envSpdMax);
    }

    let BRM = GetBM(Sounding.Sounding);
    let FntSiz = Canv2.width / 35;

    ctx2.fillStyle = "rgba(255,255,255,1)";

    ctx2.font = `600 ${FntSiz*1.5}px ${globalFont}`;
    ctx2.textAlign = "center";
    ctx2.fillText(`Storm Motions:`, Canv2.width * 0.5, Canv2.height * 0.135);
    ctx2.fillRect(Canv2.width * 0.05, Canv2.height * 0.1475, Canv2.width * 0.9, 3);
    ctx2.fillRect(Canv2.width * 0.4925, Canv2.height * 0.16, 2, Canv2.height * 0.74);
    let MotionRows = [
      [
        ["Bunkers Right", ConvertCartToPolarRealRnd(BRM.RM)], 
        ["Bunkers Left", ConvertCartToPolarRealRnd(BRM.LM)], 
        ["Mean Motion", ConvertCartToPolarRealRnd(BRM.MM)],
        ["Custom Motion", ConvertCartToPolarRealRnd(CUMot)], 
      ],
      [
        ["Corfidi Upshear", ConvertCartToPolarRealRnd(BRM.US)], 
        ["Corfidi Downshear", ConvertCartToPolarRealRnd(BRM.DS)],
        ["Nixon Deviant Right", ConvertCartToPolarRealRnd(BRM.DTMR)], 
        ["Nixon Deviant Left", ConvertCartToPolarRealRnd(BRM.DTML)]
      ]
    ];
    MotionRows[0][3][1].WD = 180 - MotionRows[0][3][1].WD + 360;
    MotionRows[0][3][1].WD %= 360;
    let XP = 0;
    let XR = 333;

    let YP = 0.5;
    let YR = 66;
    MotionRows.forEach((N) => {
      YP = 0.5;
      N.forEach((P) => {
        
        ctx2.fillStyle = "rgb(208, 255, 253)";

        ctx2.font = `700 ${FntSiz * 1.1}px ${globalFont}`;
        ctx2.textAlign = "left";
        ctx2.fillText(`${P[0]}:`, 20 + XP  * XR, Canv2.height * 0.15 + YP * YR);

        ctx2.fillStyle = "rgb(255, 211, 211)";

        ctx2.font = `500 ${FntSiz}px ${globalFont}`;
        ctx2.textAlign = "right";
        const motWs = P[1].WS;
        const motWsDisp =
          isNaN(motWs)
            ? "--"
            : impSpd
              ? Math.round(KtsToMph(motWs))
              : Math.round(100 * motWs) / 100;
        ctx2.fillText(
          `${isNaN(P[1].WD) ? "--" : Math.round(10 * P[1].WD) / 10}° / ${motWsDisp}${motWsDisp === "--" ? "" : spdUnitLbl}`,
          20 + (XP + 0.95) * XR,
          Canv2.height * 0.15 + YP * YR
        );
        YP += 0.65;
      })
      XP += 1;
    })

    const Canv3 = $("Values8");
    const ctx3 = Canv3.getContext("2d");

    Canv3.width = 900;
    Canv3.height = 700;

    let BoundsX = [0, 300];
    let BoundsY = [0, 700];

    ctx3.strokeStyle = "rgba(255,255,255,1)";
    ctx3.lineWidth = 3;
    ctx3.fillStyle = "rgba(0,0,0,1)";
    ctx3.fillRect(0, 0, 300, 700);
    ctx3.strokeRect(0, 0, 300, 700);

    ctx3.strokeRect(300, 0, 300, 700);
    ctx3.strokeRect(600, 0, 300, 700);
    ctx3.strokeRect(600, 0, 300, 350);

    let Sound = Sounding.Sounding;

    let TopWnd = Math.round(clamp(Math.max(...Sound.H), 4000, 16000)/1000);
    let TopWndSc = TopWnd*1000;

    //First Box, SR Wind
    ctx3.beginPath();
    ctx3.lineWidth = 5;
    ctx3.setLineDash([5, 5]);
    ctx3.strokeStyle = "rgba(255,0,0,1)";
    ctx3.fillStyle = "rgba(255,0,0,0.1)";
    ctx3.lineTo(0, 700);

    let pl = 0;

    for (let i = 0; i < Sound.W.length; i++) {
      let Slice = Sound.W[i];

      if (Slice.H > 16000) {
        pl = 0;
        break;
      }

      let Wind = ConvertPolartoCart(Slice);
      Wind.x -= CSMot.x;
      Wind.y += CSMot.y;
      let Wnd = Math.round(Mag(Wind));

      let Pos = GetBoxPos(BoundsX, BoundsY, srWindXfract(Wnd), 100 * (1 - Slice.H / TopWndSc));
      ctx3.lineTo(Pos.x, Pos.y);
      pl = Pos.y;
      //ctx3.moveTo(Pos.x,Pos.y);
    }

    ctx3.lineTo(0, pl);

    ctx3.stroke();
    ctx3.fill();


    ctx3.font = `bold ${25}px ${globalFont}`;
    ctx3.fillStyle = "rgba(255,255,255,1)";
    ctx3.textAlign = "center";
    let Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);
    ctx3.fillText(`SR Wind (${spdUnitLbl})`, Pos.x, Pos.y);
    ctx3.fillText(`v`, Pos.x, Pos.y + 30);
    ctx3.fillText(`Height (km)`, Pos.x, Pos.y + 60);

    for (let i = 2; i < TopWnd; i += 2) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / TopWnd)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / TopWnd)));
      ctx3.fillRect(Pos.x, Pos.y, 15, 4);
      ctx3.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      ctx3.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    for (let i = 10; i <= 70; i += 10) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 80)), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 80)), 100);

      ctx3.fillRect(Pos.x, Pos.y, 4, 5);
      ctx3.fillRect(Pos.x, Pos2.y - 20, 4, 5);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      const tickLbl = impSpd ? Math.round(KtsToMph(i)) : i;
      ctx3.fillText(`${tickLbl}`, Pos.x, Pos2.y - 10);
    }
    ctx3.setLineDash([]);

    //Next Draw The Vertical Bar for the Wind Direction/Wind Speed
    BoundsX = [300, 600];
    BoundsY = [0, 350];

    ctx3.strokeStyle = "rgba(255,255,255,1)";
    ctx3.lineWidth = 3;
    ctx3.fillStyle = "rgba(0,0,0,1)";
    ctx3.fillRect(300, 0, 300, 350);
    ctx3.strokeRect(300, 0, 300, 350);

    ctx3.beginPath();
    ctx3.lineWidth = 5;
    ctx3.setLineDash([]);
    ctx3.strokeStyle = "rgb(0, 255, 242)";
    ctx3.fillStyle = "rgba(0, 255, 213, 0.1)";
    ctx3.lineTo(300, 350);

    pl = 0;

    for (let i = 0; i < Sound.W.length; i++) {
      let Slice = Sound.W[i];

      if (Slice.H > TopWndSc) {
        pl = 0;
        break;
      }

      let Wind = ConvertPolartoCart(Slice);
      let Wnd = Math.round(Mag(Wind));

      let Pos = GetBoxPos(BoundsX, BoundsY, envWindXfract(Wnd), 100 * (1 - Slice.H / TopWndSc));
      ctx3.lineTo(Pos.x, Pos.y);
      pl = Pos.y;
      //ctx3.moveTo(Pos.x,Pos.y);
    }

    ctx3.lineTo(300, pl);

    ctx3.stroke();
    ctx3.fill();

    //ERROR BARS (RMS uncertainty crosses — keep fairly light so profile stays readable)
    const ErrHght = 10;
    const errCrossStroke = "rgba(255, 0, 0, 0.55)";
    pl = 0;

    for (let i = 0; i < Sound.W.length; i+=2) {
      let Slice = Sound.W[i];
      ctx3.lineWidth = 5;
      let Error = 0; //5%
      ctx3.beginPath();

      if (Slice.H > 16000) {
        pl = 0;
        break;
      }

      let Wind = ConvertPolartoCart(Slice);
      let Wnd = Math.round(Mag(Wind));
      Error = Sound.W[i].ERR_KTS;
      if (Error == null || !Number.isFinite(Error) || Error <= 0) continue;

      let Pos = GetBoxPos(BoundsX, BoundsY, envWindXfract(Wnd), 100 * (1 - Slice.H / TopWndSc));
      let PosErr = GetBoxPos(BoundsX, BoundsY, envWindXfract(Wnd + Error), 100 * (1 - Slice.H / TopWndSc));
      let PosM = { x: Math.abs(PosErr.x - Pos.x), y: Math.abs(PosErr.y - Pos.y) };
      ctx3.strokeStyle = errCrossStroke;
      ctx3.moveTo(clamp(Pos.x + PosM.x, 300, 600), Pos.y - ErrHght);
      ctx3.lineTo(clamp(Pos.x + PosM.x, 300, 600), Pos.y + ErrHght);

      ctx3.moveTo(clamp(Pos.x + PosM.x, 300, 600), Pos.y);
      ctx3.lineTo(clamp(Pos.x - PosM.x, 300, 600), Pos.y);

      ctx3.moveTo(clamp(Pos.x - PosM.x, 300, 600), Pos.y - ErrHght);
      ctx3.lineTo(clamp(Pos.x - PosM.x, 300, 600), Pos.y + ErrHght);
      ctx3.stroke();
      ctx3.fill();

      ctx3.beginPath();
      ctx3.fillStyle = "rgba(0, 255, 213, 1)";
      ctx3.lineWidth = 2;
      ctx3.strokeStyle = "rgb(0, 0, 0)";
      ctx3.arc(Pos.x, Pos.y, ErrHght/2, 0, 2 * Math.PI);
      ctx3.stroke();
      ctx3.fill();
      //ctx3.moveTo(Pos.x,Pos.y);
    }    


    ctx3.font = `bold ${25}px ${globalFont}`;
    ctx3.fillStyle = "rgba(255,255,255,1)";
    ctx3.textAlign = "center";
    Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);
    ctx3.fillText(`Wind Spd (${spdUnitLbl})`, Pos.x, Pos.y);

    for (let i = 2; i < TopWnd; i += 2) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / TopWnd)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / TopWnd)));
      ctx3.fillRect(Pos.x, Pos.y, 15, 4);
      ctx3.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      ctx3.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    for (let i = 20; i <= 140; i += 20) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 140)), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 140 )), 100);

      ctx3.fillRect(Pos.x, Pos.y, 4, 5);
      ctx3.fillRect(Pos.x, Pos2.y - 20, 4, 5);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      const envTick = impSpd ? Math.round(KtsToMph(i)) : i;
      ctx3.fillText(`${envTick}`, Pos.x, Pos2.y - 10);
    }

    //Next Wind Direction

    //Next Draw The Vertical Bar for the Wind Direction/Wind Speed
    BoundsX = [300, 600];
    BoundsY = [350, 700];

    ctx3.strokeStyle = "rgba(255,255,255,1)";
    ctx3.lineWidth = 3;
    ctx3.fillStyle = "rgba(0,0,0,1)";
    ctx3.fillRect(300, 350, 300, 350);
    ctx3.strokeRect(300, 350, 300, 350);

    ctx3.beginPath();
    ctx3.lineWidth = 3;
    ctx3.setLineDash([]);
    ctx3.strokeStyle = "rgb(0, 255, 242)";
    ctx3.fillStyle = "rgba(0, 255, 213, 0.1)";
    //ctx3.lineTo(0, 350);

    pl = 0;
    let stAng = -9999;

    for (let i = 0; i < Sound.W.length; i++) {
      let Slice = Sound.W[i];
      let SliceBefore = Sound.W[Math.max(0, i-1)];

      if (Slice.H > TopWndSc) {
        pl = 350;
        break;
      }

      let Wind = ConvertPolartoCart(Slice);
      let Ang = Math.round(GetAngleFromVector(Wind));
      let Ang2 = Math.round(GetAngleFromVector(ConvertPolartoCart(SliceBefore)))
      if (stAng == -9999){
        stAng = Ang;
      }

      let XScale = (50 + 100 * (((Ang - stAng + 180) % 360 + 360) % 360 - 180) / 360)
      let XScaleBefore = (50 + 100 * (((Ang2 - stAng+ 180) % 360 + 360) % 360 - 180) / 360)

      if (XScale >= 100 && XScaleBefore < 100){
        let PointWhenCross = (100 - XScale)/(XScaleBefore - XScale);
        let Hght = Lerp(SliceBefore.H, Slice.H, PointWhenCross);

        let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - Hght / TopWndSc));
        let Pos2L = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - Hght / TopWndSc));
        let PosTrue = GetBoxPos(BoundsX, BoundsY, XScale%100, 100 * (1 - Slice.H / TopWndSc));
        ctx3.lineTo(Pos2.x, Pos2.y);
        ctx3.lineTo(Pos2L.x, Pos2.y);
        ctx3.lineTo(PosTrue.x, PosTrue.y);
        pl = PosTrue.y;
      } else if (XScale >= 0 && XScaleBefore < 0){
        let PointWhenCross = (0 - XScale)/(XScaleBefore - XScale);
        let Hght = Lerp(SliceBefore.H, Slice.H, PointWhenCross);

        let Pos2 = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - Hght / TopWndSc));
        let Pos2L = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - Hght / TopWndSc));
        let PosTrue = GetBoxPos(BoundsX, BoundsY, XScale%100, 100 * (1 - Slice.H / TopWndSc));
        ctx3.lineTo(Pos2.x, Pos2.y);
        ctx3.lineTo(Pos2L.x, Pos2.y);
        ctx3.lineTo(PosTrue.x, PosTrue.y);
        pl = PosTrue.y;
      } else {
        let Pos = GetBoxPos(BoundsX, BoundsY, XScale%100, 100 * (1 - Slice.H / TopWndSc));
        ctx3.lineTo(Pos.x, Pos.y);
        pl = Pos.y;
      }

      
      
      //ctx3.moveTo(Pos.x,Pos.y);
    }

    ctx3.lineTo((BoundsX[1] - BoundsX[0])/2 + BoundsX[0], pl);
    ctx3.lineTo((BoundsX[1] - BoundsX[0])/2 + BoundsX[0], 700);

    ctx3.stroke();
    ctx3.fill();

    ctx3.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx3.fillRect((BoundsX[1] - BoundsX[0])/2 + BoundsX[0], 350, 3, 350);
    ctx3.fillStyle = "rgba(0, 255, 213, 0.1)";

    //ERROR BARS
    pl = 0;

    for (let i = 0; i < Sound.W.length; i+=2) {
      let Slice = Sound.W[i];
      ctx3.lineWidth = 5;
      let Error = 0; //5%
      ctx3.beginPath();

      if (Slice.H > TopWndSc) {
        pl = 0;
        break;
      }
      

      let Wind = ConvertPolartoCart(Slice);
      let Ang = Math.round(GetAngleFromVector(Wind));
      const errKtsDir = Sound.W[i].ERR_KTS;
      if (errKtsDir == null || !Number.isFinite(errKtsDir) || errKtsDir <= 0) continue;
      const wsMag = Mag(Wind);
      Error = clamp(
        radiansToDegrees(Math.atan(errKtsDir / (wsMag > 1e-6 ? wsMag : 1e-6))),
        -180,
        180
      );

      let Pos = GetBoxPos(BoundsX, BoundsY, (50 + 100 * (((Ang - stAng + 180) % 360 + 360) % 360 - 180) / 360), 100 * (1 - Slice.H / TopWndSc));
      let PosM = GetBoxPos(BoundsX, BoundsY, (50 + 100 * (((Ang - stAng + Error + 180) % 360 + 360) % 360 - 180) / 360), 100 * (1 - Slice.H / TopWndSc));
      PosM.x = Math.abs(PosM.x - Pos.x);
      PosM.y = Math.abs(PosM.y - Pos.y);


      ctx3.strokeStyle = errCrossStroke;
      if (Pos.x + PosM.x > BoundsX[1] && Pos.x < BoundsX[1]){
        ctx3.moveTo((Pos.x + PosM.x - BoundsX[0])%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos.y - ErrHght);
        ctx3.lineTo((Pos.x + PosM.x - BoundsX[0])%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos.y + ErrHght);
        ctx3.moveTo((Pos.x + PosM.x - BoundsX[0])%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos.y);
        ctx3.lineTo(BoundsX[0], Pos.y);

        ctx3.moveTo(BoundsX[1], Pos.y);
        ctx3.lineTo(Pos.x, Pos.y);
      } else {
        ctx3.moveTo(Pos.x + PosM.x, Pos.y - ErrHght);
        ctx3.lineTo(Pos.x + PosM.x, Pos.y + ErrHght);

        ctx3.moveTo(Pos.x + PosM.x, Pos.y);
        ctx3.lineTo(Pos.x, Pos.y);
      }

      ctx3.moveTo(Pos.x, Pos.y);

      if (Pos.x - PosM.x < BoundsX[0] && Pos.x > BoundsX[0]){
        ctx3.moveTo(Pos.x - PosM.x + (BoundsX[1] - BoundsX[0]), Pos.y - ErrHght);
        ctx3.lineTo(Pos.x - PosM.x + (BoundsX[1] - BoundsX[0]), Pos.y + ErrHght);
        ctx3.moveTo(Pos.x - PosM.x + (BoundsX[1] - BoundsX[0]), Pos.y);
        ctx3.lineTo(BoundsX[1], Pos.y);

        ctx3.moveTo(BoundsX[0], Pos.y);
        ctx3.lineTo(Pos.x, Pos.y);
        ctx3.stroke();
        ctx3.fill();
      } else {
        ctx3.lineTo(Pos.x - PosM.x, Pos.y);

        ctx3.moveTo(Pos.x - PosM.x, Pos.y - ErrHght);
        ctx3.lineTo(Pos.x - PosM.x, Pos.y + ErrHght);
        ctx3.stroke();
        ctx3.fill();
      }
      

      ctx3.beginPath();
      ctx3.fillStyle = "rgba(0, 255, 213, 1)";
      ctx3.lineWidth = 2;
      ctx3.strokeStyle = "rgb(0, 0, 0)";
      ctx3.arc(Pos.x, Pos.y, ErrHght/2, 0, 2 * Math.PI);
      ctx3.stroke();
      ctx3.fill();
      //ctx3.moveTo(Pos.x,Pos.y);
    }    


    ctx3.font = `bold ${25}px ${globalFont}`;
    ctx3.fillStyle = "rgba(255,255,255,1)";
    ctx3.textAlign = "center";
    Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);
    ctx3.fillText(`Wind Dir (Deg)`, Pos.x, Pos.y);

    for (let i = 2; i < TopWnd; i += 2) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / TopWnd)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / TopWnd)));
      ctx3.fillRect(Pos.x, Pos.y, 15, 4);
      ctx3.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      ctx3.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    for (let i = 90; i <= 360; i += 90) {
      let Pos = GetBoxPos(BoundsX, BoundsY, (50 + 100 * (((i - stAng + 180) % 360 + 360) % 360 - 180) / 360)%100, 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, (50 + 100 * (((i - stAng + 180) % 360 + 360) % 360 - 180) / 360)%100, 100);

      ctx3.fillRect(Pos.x%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos.y, 4, 5);
      ctx3.fillRect(Pos.x%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos2.y - 20, 4, 5);

      ctx3.font = `${250 * 0.075}px ${globalFont}`;
      ctx3.fillText(`${i%360}`, Pos.x%(BoundsX[1] - BoundsX[0]) + BoundsX[0], Pos2.y - 10);
    }

    //Next Draw The Vertical Bar for the Barbs
    BoundsX = [600, 900];
    BoundsY = [350, 700];

    ctx3.strokeStyle = "rgba(255,255,255,1)";
    ctx3.lineWidth = 3;
    ctx3.fillStyle = "rgba(0,0,0,1)";
    ctx3.fillRect(600, 350, 300, 350);
    ctx3.strokeRect(600, 350, 300, 350);
    let Psv = GetBoxPos(BoundsX, BoundsY, 35, 50);
    let xi = 0;
    for (const x of [0, 0.5, 1, 2, 3, 6, 9, 12]){
      let Hght = x*1000;
      let hd;
      if (Hght <= 1000) {
        hd = "rgba(225,0,225,1)";
      } else if (Hght <= 3000 && Hght > 1000) {
        hd = "rgba(225,0,0,1)";
      } else if (Hght <= 6000 && Hght > 3000) {
        hd = "rgba(0,225,0,1)";
      } else if (Hght <= 9000 && Hght > 6000) {
        hd = "rgba(225,225,0,1)";
      } else if (Hght <= 12000 && Hght > 9000) {
        hd = "rgba(0,225,225,1)";
      }
      ctx3.fillStyle = hd;
      ctx3.font = `500 ${250 * 0.1}px ${globalFont}`;
      let PSL = GetBoxPos(BoundsX, BoundsY, 96, 90 - 80 * (xi/7));
      ctx3.textAlign = "right";
      
      xi += 1;

      let Layer = GetLayerByHght(Sound, Hght);

      if (!Layer.isAbove){
        drawBarbVWP([
          Layer.WS,
          Layer.WD,
          Psv.x,
          (Psv.y + PSL.y * 3)/4
        ], hd, 0); // EDITED: Pass lat
        ctx3.fillText(`${x}km AGL`, PSL.x, PSL.y);
      }
      
    }

    const mapSize = 300;
    const padding = 0; // You can increase this if you want some spacing from the edge
    if (mapImage) {
      ctx3.fillStyle = "rgba(255, 255, 255,1)";
      ctx3.save();
      ctx3.drawImage(mapImage, 0, 0, mapImage.width || mapSize, mapImage.height || mapSize, 600, 0, 300, 350);
      ctx3.restore();
    }
    drawHodographLocationInset(ctx3, Canv3, Sounding, () => {
      if (VWPActive) DrawVWPInsets(VWPSounding);
    }, { x: 600, y: 0, width: 300, height: 350 });
}

/** Returns box pos data.
 * @param {*} BoundX Parameter for GetBoxPos.
 * @param {*} BoundY Parameter for GetBoxPos.
 * @param {*} X Parameter for GetBoxPos.
 * @param {*} Y Parameter for GetBoxPos.
 * @returns {*} Result of the function.
 */
function GetBoxPos(BoundX, BoundY, X, Y) {
  return { x: BoundX[0] + (BoundX[1] - BoundX[0]) * (X / 100), y: BoundY[0] + (BoundY[1] - BoundY[0]) * (Y / 100) };
}

/** Checks check mode.
 * @param {*} C1 Parameter for CheckMode.
 * @param {*} C2 Parameter for CheckMode.
 * @returns {*} Result of the function.
 */
function CheckMode(C1, C2) {
  return DarkMode == true && C1 || C2;
}


/** Radians to degrees
 * @param {*} radians Parameter for RtoDeg.
 * @returns {*} Result of the function.
 */
function RtoDeg(radians) {
  return radians * (180 / Math.PI);
}

/** Converts cart to polar values.
 * @param {*} N Parameter for ConvertCartToPolar.
 * @returns {*} Result of the function.
 */
function ConvertCartToPolar(N) {
  return {
    WD: 180 + RtoDeg(Math.atan(N.y / N.x)),
    WS: Math.sqrt(Math.pow(N.x, 2) + Math.pow(N.y, 2)),
  }
}

/** Converts cart to polar2 values.
 * @param {*} N Parameter for ConvertCartToPolar2.
 * @returns {*} Result of the function.
 */
function ConvertCartToPolar2(N) {
  return {
    WD: (270 + RtoDeg(Math.atan(N.y / N.x))) % 360,
    WS: Math.sqrt(Math.pow(N.x, 2) + Math.pow(N.y, 2)),
  }
}

var Climo = [];
const LatBounds = [25, 50];
const LonBounds = [-124, -64];

/** Checks whether a sounding is within tornado climatology bounds.
 * @param {*} Sounding Parameter for isSoundingInTornadoClimoBounds.
 * @returns {*} Result of the function.
 */
function isSoundingInTornadoClimoBounds(Sounding) {
  if (!Sounding || !Sounding.Location2 || Sounding.Location2.length < 2) return false;
  const lat = Sounding.Location2[0];
  const westLon = -Sounding.Location2[1];

  if (
    lat >= LatBounds[0] &&
    lat <= LatBounds[1] &&
    westLon >= LonBounds[0] &&
    westLon <= LonBounds[1]
  ) {
    const LatB = Math.round(Sounding.Location2[0] - 25);
    const LonB = Math.round(Sounding.Location2[1] - 64);
    const nms  = ClimoSwitch(numbs2, numbs)

    if (LatB >= nms.length){
      return false;
    }
    
    if (LonB >= nms[LatB].length){
      return false;
    }

    const truenms = nms[LatB][LonB];

    if (truenms >= 5){
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/** Whether the current sounding sits inside the CONUS tornado climatology grid. */
let tornadoClimoAvailable = true;

/** Normalizes tornado climatology data for graphing.
 * @param {*} Sounding Parameter for coerceTornadoClimoToGraphIfNeeded.
 * @returns {void} No value.
 */
function coerceTornadoClimoToGraphIfNeeded(Sounding) {
  const avail =
    Sounding && Sounding.Location2 && Sounding.Location2.length >= 2
      ? isSoundingInTornadoClimoBounds(Sounding)
      : false;
  if (avail !== tornadoClimoAvailable) {
    tornadoClimoAvailable = avail;
    emit("change");
  }
  if (typeof VWPActive !== "undefined" && VWPActive) return;
  if (SidePanelMode !== "Tornado") return;
  if (avail) return;
  SidePanelMode = "Graph";
  applySidePanelVisibility();
  emit("change");
}

/** Show the height graph (Values4) or the climatology / winter panel (Values6).
 * @returns {void} No value.
 */
function applySidePanelVisibility() {
  const graphCanvas = $("Values4");
  const climoCanvas = $("Values6");
  if (SidePanelMode === "Graph") {
      if (graphCanvas) graphCanvas.classList.remove('skewthidden');
      if (climoCanvas) climoCanvas.classList.add('skewthidden');
      DisplayGraphMode = true;
  } else {
      if (graphCanvas) graphCanvas.classList.add('skewthidden');
      if (climoCanvas) climoCanvas.classList.remove('skewthidden');
      DisplayGraphMode = false;
  }
}
var ClimaSet = false;

/** Derived from SHARPpy
 * 
 * @param {*} Sounding 

 * @returns {*} Result of the function.
 */
function Init_Phase(Sounding) {
  let phase = -1;
  let st = "N/A";

  let Avails = 0;
  Sounding.Sounding.Slice.forEach((P) => {
    if (P[7] < .0001) {
      Avails += 1;
    }
  });

  if (Avails < 5) {

  }

  let HighestLyr = 0;
  let Find = false;
  
  for (let x = 0; x < Sounding.Sounding.Slice.length-1; x++) {
    let Lyr = ConvertToInfo(Sounding.Sounding.Slice[x])
    let Lyr2 = ConvertToInfo(Sounding.Sounding.Slice[x+1])

    if (RelHum(Lyr.T, Lyr.D) > 80 && RelHum(Lyr2.T, Lyr2.D) > 80) {
      Find = true;
      HighestLyr = Lyr.P;
    }
  }

  if (!Find) {
    return ["N/A", -1, "--", "N/A"]
  } else {
    let Lyr = GetLayerByPres(Sounding.Sounding, HighestLyr - 25);
    let Tmpc = Lyr.T;

    if (Tmpc > 0) {
      phase = 0
      st = "Rain"
    } else if (Tmpc > -5) {
      phase = 1
      st = "Freezing Rain"
    } else if (Tmpc > -9) {
      phase = 2
      st = "ZR/S Mix"
    } else if (Tmpc <= -9) {
      phase = 3
      st = "Snow"
    } else {
      st = "N/A"
      phase = -1
    }

    return [Math.round(10 * (HighestLyr - 25))/10, phase, Math.round(100 * Tmpc)/100, st];
  }
}

/** Estimates precipitation type from the sounding.
 * @param {*} Sounding Parameter for BestGuessPrecip.
 * @returns {*} Result of the function.
 */
function BestGuessPrecip(Sounding) {
  let Sfc = GetLayerByPres(Sounding.Sounding, "SFC");

  if (!Sfc || Sfc.T === -9999) {
    return "Unknown";
  }

  // Build temperature profile from surface to 500mb
  let profile = [];
  for (let p = Sfc.P; p >= 500; p -= 25) {
    let layer = GetLayerByPres(Sounding.Sounding, p);
    if (layer && layer.T !== -9999) {
      profile.push({
        P: layer.P,
        H: layer.H,
        T: layer.T,
        depth: layer.H - Sfc.H
      });
    }
  }

  // console.log("Precip Profile:", profile);

  if (profile.length < 3) {
    return "Unknown";
  }

  // --- ANALYZE WARM/COLD LAYERS ---

  // 1. Identify all layers above freezing
  let warmLayers = profile.filter(l => l.T > 0);
  let hasWarmAir = warmLayers.length > 0;

  // 2. Find the maximum temperature in the warm layer
  let maxWarmTemp = -999;
  let warmLayerIntegral = 0; // "Strength" of the warm layer

  if (hasWarmAir) {
    maxWarmTemp = Math.max(...warmLayers.map(l => l.T));
    warmLayerIntegral = warmLayers.reduce((sum, l) => sum + l.T, 0);
  }

  // 3. Analyze the Cold Layer (for Freezing Rain/Sleet logic)
  let coldLayerDepth = 0;
  let coldLayerIntegral = 0;

  // Iterate from surface up to find depth of surface cold layer
  for (let layer of profile) {
    if (layer.T <= 0) {
      coldLayerDepth = layer.depth;
      coldLayerIntegral += Math.abs(layer.T);
    } else {
      break; // Stop once we hit warm air
    }
  }

  // --- DECISION LOGIC ---

  // SCENARIO 1: SURFACE IS ABOVE FREEZING
  if (Sfc.T > 0) {
    // If the Max Temp is very warm (> 4C), it's definitely Rain.
    if (maxWarmTemp > 4.0) {
      return "Rain";
    }

    // **THE FIX**: Marginal Surface Temp Logic
    // If the entire warm layer is very weak (Max T < 1.5C / 35F), 
    // snow will survive the fall to the surface.
    // In your data: MaxT is 0.24C. This will correctly return Snow.
    if (maxWarmTemp < 1.5) {
      return "Snow";
    }

    // If between 1.5C and 4.0C, it transitions to rain.
    return "Rain";
  }

  // SCENARIO 2: SURFACE IS FREEZING (Sfc.T <= 0)
  else {
    // If there is NO warm air aloft, it is Snow.
    if (!hasWarmAir) {
      return "Snow";
    }

    // SCENARIO 3: SURFACE FREEZING + WARM AIR ALOFT (ZR / IP)

    // Calculate the ratio of warm layer strength to cold layer strength
    let warmToColdRatio = warmLayerIntegral / Math.max(coldLayerIntegral, 1);

    // Calculate warm layer depth
    let firstWarm = warmLayers[warmLayers.length - 1]; // Top
    let lastWarm = warmLayers[0]; // Bottom
    let warmLayerDepth = 0;
    if (firstWarm && lastWarm) warmLayerDepth = lastWarm.H - firstWarm.H; // Approximation based on list order

    if (coldLayerDepth < 300) {
      // Very shallow cold layer (e.g. freezing rain on contact)
      return "Freezing Rain";
    } else if (warmLayerDepth > coldLayerDepth * 2) {
      // Warm layer dominates
      return "Freezing Rain";
    } else if (warmToColdRatio > 3) {
      // Warm layer much stronger than cold layer
      return "Freezing Rain";
    } else if (coldLayerDepth > 600 && maxWarmTemp > 3) {
      // Deep cold layer + Strong warm nose = Sleet
      return "Ice Pellets (Sleet)";
    } else if (coldLayerDepth > 400) {
      // Moderate cold layer depth usually refreezes raindrops
      return "Ice Pellets (Sleet)";
    } else {
      // Default borderline case
      return "Freezing Rain";
    }
  }
}

/** Side panel: "Graph" (height graph), "Tornado" (CONUS climatology) or "Winter".
 * @param {*} mode Parameter for ChangeSidePanelMode.
 * @returns {void} No value.
 */
function ChangeSidePanelMode(mode) {
  if (
    mode === "Tornado" &&
    typeof Snding !== "undefined" &&
    Snding &&
    Snding.Location2 &&
    Snding.Location2.length >= 2 &&
    !isSoundingInTornadoClimoBounds(Snding)
  ) {
    mode = "Graph";
  }
  SidePanelMode = mode;
  applySidePanelVisibility();
  emit("change");

  // Redraw
  if (Snding && Snding.Sounding) {
      LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
  }
}

/** Sets or applies hodo mode state.
 * @param {*} mode Parameter for SetHodoMode.
 * @returns {void} No value.
 */
function SetHodoMode(mode) {
  if (mode === "Relative") {
      HodoMode = true;
  } else {
      HodoMode = false;
  }
  
  if (Snding && Snding.Sounding) {
      LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
  }
}

let SidePanelMode = "Winter"; 
let currentEFScale = "EF2+"; // Default to significant

/** Sets or applies efscale state.
 * @param {*} scale Parameter for SetEFScale.
 * @returns {void} No value.
 */
function SetEFScale(scale) {
    currentEFScale = scale; // Expects "EF0+" or "EF2+"
    if (Snding && Snding.Sounding) {
        LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
    }
}

/** Switches significance of climatology
 * @param {*} ef2_val Parameter for ClimoSwitch.
 * @param {*} ef0_val Parameter for ClimoSwitch.
 * @returns {*} Result of the function.
 */
function ClimoSwitch(ef2_val, ef0_val) {
    return currentEFScale === "EF2+" ? ef2_val : ef0_val;
}

/** Draws winter stats content.
 * @param {*} ctx Parameter for DrawWinterStats.
 * @param {*} Canv Parameter for DrawWinterStats.
 * @param {*} Sounding Parameter for DrawWinterStats.
 * @param {*} Info Parameter for DrawWinterStats.
 * @returns {void} No value.
 */
function DrawWinterStats(ctx, Canv, Sounding, Info) {
    const W = Canv.width;
    const H = Canv.height;
    const cx = W * 0.5;

    const fs = (frac) => `${Math.round(Math.min(H, W) * frac)}px`;

    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, W, H);

    let DGOmega = mean_layer_temp(Sounding, -12, -18, "Omega");
    let DGPWAT  = mean_layer_temp(Sounding, -12, -18, "PWAT");
    let DGRH    = mean_layer_temp(Sounding, -12, -18, "RH");
    let DGMX    = mean_layer_temp(Sounding, -12, -18, "MixRat");
    let LayerTopH  = Math.max(GetLayerByTemp(Sounding.Sounding, -12).H, GetLayerByTemp(Sounding.Sounding, -18).H);
    let LayerDepth = Math.abs(GetLayerByTemp(Sounding.Sounding, -12).H - GetLayerByTemp(Sounding.Sounding, -18).H);

    let OPRH       = DGOmega * DGPWAT * DGRH;
    let Initphase  = Init_Phase(Sounding);
    let PrecipType = BestGuessPrecip(Sounding);

    // --- Header ---
    ctx.font = `bold ${fs(0.055)} ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    ctx.fillText(`Dendritic Growth Zone (DGZ) Stats`, cx, H * 0.07);
    ctx.fillRect(W * 0.03, H * 0.095, W * 0.94, 1);

    // --- OPRH ---
    ctx.font = `bold ${fs(0.09)} ${globalFont}`;
    ctx.fillStyle = OPRH < 0 ? "rgba(100,200,255,1)" : "rgba(255,100,100,1)";
    ctx.fillText(`OPRH = ${OPRH.toFixed(4)}`, cx, H * 0.20);

    // --- Stats list ---
    const lx    = W * 0.05;
    const lineH = H * 0.085;
    let   yPos  = H * 0.28;

    ctx.textAlign = "left";

    // Depth row
    ctx.font = `bold ${fs(0.057)} ${globalFont}`;
    ctx.fillStyle = "rgba(230,230,230,1)";
    ctx.fillText(`Depth: ${LayerDepth.toFixed(0)}m`, lx, yPos);
    ctx.font = `${fs(0.048)} ${globalFont}`;
    ctx.fillStyle = "rgba(160,160,160,1)";
    ctx.fillText(`(${Math.round(LayerTopH - LayerDepth)}m – ${Math.round(LayerTopH)}m)`, W * 0.48, yPos);
    yPos += lineH;

    ctx.font = `${fs(0.056)} ${globalFont}`;
    ctx.fillStyle = "rgba(220,220,220,1)";
    ctx.fillText(`Mean Layer RH: ${DGRH.toFixed(0)}%`, lx, yPos);           yPos += lineH;
    ctx.fillText(`Mean Layer PWAT: ${DGPWAT.toFixed(3)} in`, lx, yPos);     yPos += lineH;
    ctx.fillText(`Mean Layer MixRat: ${DGMX.toFixed(2)} g/kg`, lx, yPos);  yPos += lineH;
    ctx.fillText(`Mean Layer Omega: ${(1000*DGOmega).toFixed(2)} ub/s`, lx, yPos); yPos += lineH;

    // --- Separator ---
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(W * 0.03, yPos - H * 0.04, W * 0.94, 1);
    yPos += H * 0.045;

    // --- Initial Phase ---
    ctx.font = `bold ${fs(0.062)} ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    ctx.fillText(`Initial Phase: ${Initphase[3]}`, cx, yPos);
    yPos += H * 0.06;

    ctx.font = `${fs(0.048)} ${globalFont}`;
    ctx.fillStyle = "rgba(180,180,180,1)";
    ctx.fillText(`From ${Initphase[0]}mb (${Initphase[2]}°C)`, cx, yPos);
    yPos += H * 0.075;

    // --- Best Guess Precip ---
    ctx.font = `bold ${fs(0.058)} ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fillText(`Best Guess Precip Type:`, cx, yPos);
    yPos += H * 0.090;

    ctx.font = `bold ${fs(0.095)} ${globalFont}`;
    if      (PrecipType.includes("Rain") && !PrecipType.includes("Freezing")) ctx.fillStyle = "rgba(50,255,50,1)";
    else if (PrecipType.includes("Snow"))           ctx.fillStyle = "rgba(100,200,255,1)";
    else if (PrecipType.includes("Freezing Rain"))  ctx.fillStyle = "rgba(255,50,255,1)";
    else if (PrecipType.includes("Ice Pellets") || PrecipType.includes("Sleet")) ctx.fillStyle = "rgba(200,100,255,1)";
    else                                            ctx.fillStyle = "rgba(255,255,100,1)";
    ctx.fillText(`${PrecipType}`, cx, yPos);
}

/** Draws tornado climo content.
 * @param {*} ctx Parameter for DrawTornadoClimo.
 * @param {*} Canv Parameter for DrawTornadoClimo.
 * @param {*} Sounding Parameter for DrawTornadoClimo.
 * @param {*} Info Parameter for DrawTornadoClimo.
 * @param {*} Wnd Parameter for DrawTornadoClimo.
 * @returns {void} No value.
 */
function DrawTornadoClimo(ctx, Canv, Sounding, Info, Wnd) {
    const W = Canv.width;
    const H = Canv.height;

    const fs = (frac) => `${Math.round(Math.min(H, W) * frac)}px`; 

    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, W, H);

    let Parcels = { SB: Info.SBParcel };
    let stpf = GetParams({ Wnd, Parcels }, "STPF");

    if (Sounding.Location2 && Sounding.Location2[0] >= LatBounds[0] && Sounding.Location2[0] <= LatBounds[1] &&
        -Sounding.Location2[1] >= LonBounds[0] && -Sounding.Location2[1] <= LonBounds[1]) {

        const LatB = Math.round(Sounding.Location2[0] - 25);
        const LonB = Math.round(Sounding.Location2[1] - 64);
        const nms  = ClimoSwitch(numbs2, numbs)[LatB][LonB];

        const cx = W * 0.5;

        const fs = (frac) => `${Math.round(H * frac)}px`;

        // Header
        ctx.font = `bold ${fs(0.052)} ${globalFont}`;
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.textAlign = "center";
        ctx.fillText(`Tornado Climatology ${currentEFScale} (2003-2024)`, cx, H * 0.055);
        ctx.fillRect(W * 0.03, H * 0.075, W * 0.94, 1);

        if (nms >= 5) {
            ctx.font = `${fs(0.040)} ${globalFont}`;
            ctx.fillText(`${nms} Cases`, cx, H * 0.12);

            const topY  = H * 0.13;
            const Chunk = (H * 0.87) / 4;

            // Bar spans nearly full width with small margins
            const barX = W * 0.04;
            const barW = W * 0.92;

            // DrawClimo only calls this once loadTornadoClimo() has resolved.
            const { stpfc, stpfc2, mlcapec, mlcapec2, effsrhc, effsrhc2, effshrc, effshrc2 } = tornadoClimo;
            const Datasets = [
                [`STP Fixed: ${stpf.toFixed(2)}`,                                     [0,15],   Array.from({length:16},(_,i)=>i),      ClimoSwitch(stpfc2,stpfc),    stpf],
                [`MLCape: ${Info.MLParcel.Cape.toFixed(0)} J/kg`,                      [0,6000], Array.from({length:7}, (_,i)=>i*1000), ClimoSwitch(mlcapec2,mlcapec), Info.MLParcel.Cape],
                [`Eff. SRH: ${Wnd.ESRH==false?0:Wnd.ESRH.toFixed(0)} m²/s²`,         [0,1000], Array.from({length:11},(_,i)=>i*100),  ClimoSwitch(effsrhc2,effsrhc), Wnd.ESRH==false?0:Wnd.ESRH],
                [`Eff. Shear: ${Wnd.BWDE==false?0:Mag(Wnd.BWDE).toFixed(0)} kts`,     [0,70],   Array.from({length:8}, (_,i)=>i*10),   ClimoSwitch(effshrc2,effshrc), Wnd.BWDE==false?0:Mag(Wnd.BWDE)],
            ];

            Datasets.forEach((P, Idx) => {
                const baseY  = topY + Chunk * Idx;
                const labelY = baseY + Chunk * 0.25;  // label near top of chunk
                const barY   = baseY + Chunk * 0.55;  // bar in middle
                const tickY  = barY + Chunk * 0.22;   // tick numbers just below bar

                const pct = (v) => (Math.max(P[1][0], Math.min(P[1][1], v)) - P[1][0]) / (P[1][1] - P[1][0]);

                // --- Label (centered) ---
                ctx.font = `bold ${fs(0.046)} ${globalFont}`;
                ctx.fillStyle = "rgba(255,255,255,1)";
                ctx.textAlign = "center";
                ctx.fillText(P[0], cx, labelY);

                // --- Percentile (top-right of chunk) ---
                let Gotten = false;
                ctx.font = `bold ${fs(0.060)} ${globalFont}`;
                ctx.fillStyle = "rgba(47,255,0,1)";
                ctx.textAlign = "right";
                for (let x = 0; x < P[3][LatB][LonB].length; x++) {
                    if (P[4] <= P[3][LatB][LonB][x]) {
                        ctx.fillText(x === 0 ? `<1st` : `${x*5}-${x*5+5}th`, W * 0.98, labelY);
                        Gotten = true;
                        break;
                    }
                }
                if (!Gotten) ctx.fillText(`>99th`, W * 0.98, labelY);

                // --- Bar background (thin line) ---
                ctx.fillStyle = "rgba(255,255,255,0.25)";
                ctx.fillRect(barX, barY, barW, 1);

                const P0   = P[3][LatB][LonB][0];
                const P10  = P[3][LatB][LonB][2];
                const P30  = P[3][LatB][LonB][6];
                const P50  = P[3][LatB][LonB][10];
                const P70  = P[3][LatB][LonB][14];
                const P90  = P[3][LatB][LonB][18];
                const P100 = P[3][LatB][LonB][20];

                // --- Axis tick labels ---
                ctx.fillStyle = "rgba(255,255,255,0.7)";
                ctx.font = `${fs(0.028)} ${globalFont}`;
                ctx.textAlign = "center";
                P[2].forEach(v => {
                    const x = barX + barW * pct(v);
                    ctx.fillText(v, x, tickY);
                    ctx.fillStyle = "rgba(255,255,255,0.3)";
                    ctx.fillRect(x, barY - 2, 1, 5);
                    ctx.fillStyle = "rgba(255,255,255,0.7)";
                });

                // --- Min/Max dots ---
                ctx.fillStyle = "rgba(255,0,0,1)";
                ctx.fillRect(barX + barW * pct(P0),   barY - 1, 2, 4);
                ctx.fillRect(barX + barW * pct(P100), barY - 1, 2, 4);

                // --- IQR box (30th–70th) — thin ---
                const boxStart = barX + barW * pct(P30);
                ctx.fillStyle = "rgba(255,0,0,0.75)";
                ctx.fillRect(boxStart, barY - 7, barW * (pct(P70) - pct(P30)), 7);

                // --- Median line ---
                ctx.fillStyle = "rgba(255,255,255,1)";
                ctx.fillRect(barX + barW * pct(P50), barY - 8, 2, 8);

                // --- Whiskers (10th–90th) ---
                const w1 = barX + barW * pct(P10);
                const w2 = barX + barW * pct(P90);
                ctx.fillRect(w1, barY, w2 - w1, 1);
                ctx.fillRect(w1, barY - 3, 2, 7);
                ctx.fillRect(w2, barY - 3, 2, 7);

                // --- Current value (yellow) ---
                ctx.fillStyle = "rgba(255,234,0,1)";
                ctx.fillRect(barX + barW * pct(P[4]), barY - 8, 3, 10);
            });

        } else {
            ctx.font = `${fs(0.052)} ${globalFont}`;
            ctx.fillText(`Insufficient Cases! (${nms} < 5)`, cx, H * 0.5);
        }
    }
    // Out-of-bounds: UI should coerce to Graph w/ Height (see coerceTornadoClimoToGraphIfNeeded); canvas stays black.
}

let lastClimoDraw = null;
let tornadoClimoRedrawQueued = false;

/** Draws climo content.
 * @param {*} Sounding Parameter for DrawClimo.
 * @param {*} Info Parameter for DrawClimo.
 * @param {*} Wnd Parameter for DrawClimo.
 * @returns {void} No value.
 */
function DrawClimo(Sounding, Info, Wnd) {
  lastClimoDraw = [Sounding, Info, Wnd];
  const Canv = $("Values6");
  const ctx = Canv.getContext("2d");

  // Account for device pixel ratio for sharp rendering
  const dpr = window.devicePixelRatio * 2 || 2;
  const cssWidth  = Canv.offsetWidth;
  const cssHeight = Canv.offsetHeight;

  Canv.width  = cssWidth  * dpr;
  Canv.height = cssHeight * dpr;

  // Scale all drawing operations up to match
  ctx.scale(dpr, dpr);

  // Now W/H passed to draw functions should be CSS size (not pixel size)
  // so coordinates stay intuitive
  const FakeCanv = { width: cssWidth, height: cssHeight };

  if (SidePanelMode === "Winter") {
    DrawWinterStats(ctx, FakeCanv, Sounding, Info);
  } else if (SidePanelMode === "Tornado") {
    if (tornadoClimo) {
      DrawTornadoClimo(ctx, FakeCanv, Sounding, Info, Wnd);
      return;
    }
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.font = `${Math.round(Math.min(cssWidth, cssHeight) * 0.05)}px ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.textAlign = "center";
    ctx.fillText("Loading tornado climatology…", cssWidth / 2, cssHeight / 2);
    if (!tornadoClimoRedrawQueued) {
      tornadoClimoRedrawQueued = true;
      loadTornadoClimo()
        .then(() => {
          // Redraw the sounding on screen now (it may have changed while loading).
          if (SidePanelMode === "Tornado" && lastClimoDraw && $("Values6")) {
            DrawClimo(...lastClimoDraw);
          }
        })
        .catch((err) => console.error("Tornado climatology failed to load:", err))
        .finally(() => { tornadoClimoRedrawQueued = false; });
    }
  } else {
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }
}

/** Calculates the angle between two vectors.
 * @param {*} a Parameter for angleBetween.
 * @param {*} b Parameter for angleBetween.
 * @returns {*} Result of the function.
 */
function angleBetween(a, b) {
    return ((b - a + 180) % 360 + 360) % 360 - 180;
}

/** Draws boxes content.
 * @param {*} Sounding Parameter for DrawBoxes.
 * @param {*} Info Parameter for DrawBoxes.
 * @param {*} wind Parameter for DrawBoxes.
 * @returns {void} No value.
 */
function DrawBoxes(Sounding, Info, wind) {
  if (VWPActive){
    return
  }
  DrawClimo(Sounding, Info, wind);
  const Canv = $("Values4");
  const ctx = Canv.getContext("2d");
  let SSlice = GetLayerByHght(Sounding.Sounding, "SFC");

  Canv.width = 800;//Canv.style.width;
  Canv.height = 800;

  let PosX = 0;
  let PosY = 0;

  let BoundsX = [0, 400];
  let BoundsY = [0, 400];

  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 3;
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 0, 400, 400);
  ctx.strokeRect(0, 0, 400, 400);

  ctx.strokeRect(0, 400, 400, 400);
  ctx.strokeRect(400, 400, 400, 400);

  let Sound = Sounding.Sounding;

  //First Box, SR Wind
  ctx.beginPath();
  ctx.lineWidth = 5;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "rgba(255,0,0,1)";
  ctx.fillStyle = "rgba(255,0,0,0.1)";
  ctx.lineTo(0, 400);

  let pl = 0;

  for (let i = 0; i < Sound.W.length; i++) {
    let Slice = Sound.W[i];

    if (Slice.H > 16000) {
      pl = 0;
      break;
    }

    let Wind = ConvertPolartoCart(Slice);
    Wind.x -= CSMot.x;
    Wind.y += CSMot.y;
    let Wnd = Math.round(Mag(Wind));

    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * (Wnd / 80), 100 * (1 - Slice.H / 16000));
    ctx.lineTo(Pos.x, Pos.y);
    pl = Pos.y;
    //ctx.moveTo(Pos.x,Pos.y);
  }

  ctx.lineTo(0, pl);

  ctx.stroke();
  ctx.fill();


  ctx.font = `bold ${400 * 30/400}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "center";
  let Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);
  ctx.fillText(`SR Wind (kt)`, Pos.x, Pos.y);
  ctx.fillText(`v`, Pos.x, Pos.y + 30);
  ctx.fillText(`Height (km)`, Pos.x, Pos.y + 60);

  for (let i = 2; i < 16; i += 2) {
    let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / 16)));
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / 16)));
    ctx.fillRect(Pos.x, Pos.y, 15, 4);
    ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

    ctx.font = `${400 * 0.075}px ${globalFont}`;
    ctx.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
  }

  for (let i = 10; i <= 70; i += 10) {
    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 80)), 0);
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 80)), 100);

    ctx.fillRect(Pos.x, Pos.y, 4, 15);
    ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);
  }

  //Next Box, Mean Mix ratio
  BoundsX = [400, 800];
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(400, 0, 400, 400);
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  ctx.strokeRect(400, 0, 400, 400);

  let EFFRH = "--";
  if (Info.EffInflow == false) {
    EFFRH = "--";
  } else {
    EFFRH = mean_relh(Sound, Info.EffInflow.Bot, Info.EffInflow.Top);
  }


  ctx.font = `bold ${400 * 0.08}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "center";
  Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);

  ctx.fillText(`Mix Ratio (g/kg)`, Pos.x, Pos.y);
  ctx.font = `${400 * 0.08}px ${globalFont}`;
  ctx.fillText(`Eff RH: ${Math.round(EFFRH)}%`, Pos.x, Pos.y + 35);

  for (let i = 0.5; i < 3; i += 0.5) {
    let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / 3)));
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / 3)));
    ctx.fillRect(Pos.x, Pos.y, 15, 4);
    ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

    ctx.font = `${400 * 0.075}px ${globalFont}`;
    ctx.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
  }

  for (let i = 5; i < 25; i += 5) {
    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 25)), 0);
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 25)), 100);

    ctx.fillRect(Pos.x, Pos.y, 4, 15);
    ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

    //ctx.textAlign = "left";
    ctx.font = `${400 * 0.075}px ${globalFont}`;
    ctx.fillText(`${i}`, Pos.x, Pos2.y - 25);
  }

  ctx.beginPath();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(0,255,0,0.7)";
  ctx.fillStyle = "rgba(0,255,0,0.1)";
  

  for (let i = 0; i < Sound.DW.length; i++) {
    let Slice = Sound.DW[i];
    if (!Slice || !SSlice) continue;

    if (Slice.H - SSlice.H > 3000) {
      const prevDw = i > 0 ? Sound.DW[i - 1] : null;
      if ((prevDw && prevDw.H - SSlice.H < 3000) || i === 0) {
        Slice = GetLayerByHght(Sound, 3000 + SSlice.H);
        if (!Slice) break;
      } else {
        break;
      }
    }

    let MMR = mixratio(Slice.P, Slice.D);
    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * (MMR / 25), 100 * (1 - (Slice.H- SSlice.H) / 3000));

    if (i == 0) {
      ctx.lineTo(400, Pos.y);
    }
    ctx.lineTo(Pos.x, Pos.y);
    //ctx.moveTo(Pos.x,Pos.y);
  }
  ctx.lineTo(400, 0);
  ctx.fill();
  ctx.stroke();

  //Theta now
  BoundsX = [0, 400];
  BoundsY = [400, 800];

  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 400, 400, 400);
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 400, 400, 400);
  ctx.font = `${400 * 0.08}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "center";


  for (let i = 500; i < 1000; i += 100) {
    let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * ((i - 400) / 600));
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * ((i - 400) / 600));
    ctx.fillRect(Pos.x, Pos.y, 15, 4);
    ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

    ctx.font = `${400 * 0.075}px ${globalFont}`;
    ctx.fillText(`${i}`, Pos.x + 50, Pos.y + 5);
  }

  let MinTta = 999;
  let MaxTta = 0;
  let Tta = [];
  let TtaPres = [];


  for (let i = 0; i < Sound.DW.length; i++) {
    let obj = ConvertToInfo(Sound.Slice[i]);

    if (obj.P < 400) {
      break;
    }

    let TTa = CtoK(thetae(obj.P, obj.T, obj.D)) || -9999;

    if (TTa != TTa || TTa == -9999) {
      continue;
    }

    Tta.push(TTa);
    TtaPres.push(obj.P);

    MinTta = Math.min(MinTta, TTa - 10);
    MaxTta = Math.max(MaxTta, TTa + 10);
  }


  ctx.beginPath();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255,0,0,0.7)";
  ctx.fillStyle = "rgba(255, 0, 0, 0.1)";
  let PosL = 50;


  for (let i = 0; i < Tta.length; i++) {
    let P = TtaPres[i];
    let T = Tta[i];
    let Lerped = (T - MinTta) / (MaxTta - MinTta);
    let Lerpd = ((P - 400) / 600);

    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * Lerped, 100 * Lerpd);

    if (i == 0) {
      ctx.lineTo(0, Pos.y);
    }

    ctx.lineTo(Pos.x, Pos.y);
    PosL = Pos.y;

    if (i + 1 == Tta.length) {
      PosL = 400;
    }
    //ctx.moveTo(Pos.x,Pos.y);
  }
  ctx.lineTo(0, PosL);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 1)";

  for (let i = 320; i < 400; i += 10) {
    let Lerped = (i - MinTta) / (MaxTta - MinTta);
    let Pos = GetBoxPos(BoundsX, BoundsY, 100 * Lerped, 0);
    let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * Lerped, 100);

    ctx.fillRect(Pos.x, Pos.y, 4, 15);
    ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

    //ctx.textAlign = "left";
    ctx.font = `${400 * 0.08}px ${globalFont}`;
    ctx.fillText(`${i}`, Pos.x, Pos2.y - 25);
  }

  ctx.font = `bold ${400 * 0.08}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textAlign = "center";
  Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);

  ctx.fillText(`Theta E v Pres`, Pos.x, Pos.y);

  //Last Box
  BoundsX = [400, 800];

  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(400, 400, 400, 400);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.strokeRect(400, 400, 400, 400);

  ctx.font = `${400 * 0.1}px ${globalFont}`;
  ctx.fillStyle = "rgba(255,0,0,0.1)";
  ctx.textAlign = "center";

  let Nn = [
    [400, 800]
  ];

  if (Presets['Vertical'] == "Default" || Presets['Vertical'] == "Severe") {
    ctx.beginPath();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,0,0,0.7)";
    BoundsX = [400, 600];
    //ctx.moveTo(400,800);
    let LPos = 0;
    let Switch = false;
    for (let i = 0; i < 3000; i += 100) {
      const layerVorticity = GetSWV(
        Sound,
        i, i + 100,
        "Hght",
        { x: CSMot.x, y: -CSMot.y },
      );
      const Lerped = clamp((layerVorticity.SWPercent - 50) / 50, 0, 1);
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * Lerped, clamp(100 * (1 - i / 3000), 0, 100));

      if (i == 0) {
        ctx.lineTo(Pos.x, BoundsY[1]);
      }

      ctx.lineTo(Pos.x, Pos.y);
      LPos = Pos;
    }

    ctx.lineTo(LPos.x, LPos.y);
    ctx.lineTo(400, LPos.y);
    ctx.lineTo(400, 800);
    ctx.stroke();
    ctx.fill();

    BoundsX = [600, 800];

    ctx.beginPath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0, 255, 255, 0.5)";
    //ctx.moveTo(400,800);
    LPos = 0;
    Switch = false;
    for (let i = 0; i < 3000; i += 100) {
      const layerVorticity = GetSWV(
        Sound,
        i, i + 100,
        "Hght",
        { x: CSMot.x, y: -CSMot.y },
      );
      const Lerped = clamp((layerVorticity.SWV/layerVorticity.LevelHght) * 1/0.05, 0, 1);
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * Lerped, clamp(100 * (1 - i / 3000), 0, 100));

      if (i == 0) {
        ctx.lineTo(Pos.x, BoundsY[1]);
      }

      ctx.lineTo(Pos.x, Pos.y);
      LPos = Pos;
    }

    ctx.lineTo(LPos.x, LPos.y);
    ctx.lineTo(600, LPos.y);
    ctx.lineTo(600, 800);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.strokeRect(400, 400, 200, 400);

    ctx.fillStyle = "rgba(255, 255, 255 ,1)";

    BoundsX = [400, 800];

    for (let i = 0.5; i < 3; i += 0.5) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / 3)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / 3)));
      ctx.fillRect(Pos.x, Pos.y, 15, 4);
      ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx.font = `${400 * 0.075}px ${globalFont}`;
      ctx.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    BoundsX = [400, 600];
    for (let i = 60; i < 100; i += 15) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i-50) / 50), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i-50) / 50), 100);

      ctx.fillRect(Pos.x, Pos.y, 4, 15);
      ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

      //ctx.textAlign = "left";
      ctx.font = `${400 * 0.06}px ${globalFont}`;
      ctx.fillText(`${Math.round(i)}%`, Pos.x, Pos2.y - 25);
    }

    BoundsX = [600, 800];
    for (let i = 1; i < 6; i += 2) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * (i / 6), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * (i / 6), 100);

      ctx.fillRect(Pos.x, Pos.y, 4, 15);
      ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

      //ctx.textAlign = "left";
      ctx.font = `${400 * 0.06}px ${globalFont}`;
      ctx.fillText(`${(i/100)}`, Pos.x, Pos2.y - 25);
    }

    ctx.font = `bold ${400 * 0.08}px ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    Pos = GetBoxPos([400, 600], BoundsY, 50, 20);
    ctx.fillText(`SW%`, Pos.x, Pos.y);
    Pos = GetBoxPos([600, 800], BoundsY, 50, 20);
    ctx.fillText(`ωₛ`, Pos.x, Pos.y);
  } else if (Presets['Vertical'] == "Fire") {
    ctx.beginPath();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,0,0,0.7)";
    //ctx.moveTo(400,800);

    for (let i = 0; i < Sound.DW.length; i++) {
      let obj = ConvertToInfo(Sound.Slice[i]);

      if (obj.H > 3000) {
        const prevSlice = i > 0 ? ConvertToInfo(Sound.Slice[i - 1]) : null;
        if ((prevSlice && prevSlice.H < 3000) || i === 0) {
          obj = GetLayerByHght(Sound, 3000);
          if (!obj) break;
        } else {
          break;
        }
      }

      let TTa = VaporPressure(obj.T) - VaporPressure(obj.D);

      if (TTa != TTa || TTa == -9999) {
        continue;
      }

      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * TTa / 50, clamp(100 * (1 - obj.H / 3000), 0, 100));

      if (i == 0) {
        ctx.lineTo(400, Pos.y);
      }

      ctx.lineTo(Pos.x, Pos.y);
      //ctx.moveTo(Pos.x,Pos.y);
    }

    ctx.lineTo(400, 400);
    ctx.lineTo(400, 800);
    ctx.stroke();
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.strokeRect(400, 400, 400, 400);

    ctx.fillStyle = "rgba(255, 255, 255 ,1)";

    for (let i = 0.5; i < 3; i += 0.5) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / 3)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / 3)));
      ctx.fillRect(Pos.x, Pos.y, 15, 4);
      ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx.font = `${400 * 0.075}px ${globalFont}`;
      ctx.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    for (let i = 0; i < 50; i += 10) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 50)), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i / 50)), 100);

      ctx.fillRect(Pos.x, Pos.y, 4, 15);
      ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

      //ctx.textAlign = "left";
      ctx.font = `${400 * 0.075}px ${globalFont}`;
      ctx.fillText(`${Math.round(i)}`, Pos.x, Pos2.y - 25);
    }

    ctx.font = `bold ${400 * 0.1}px ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);

    ctx.fillText(`VPD`, Pos.x, Pos.y);
  } else if (Presets['Vertical'] == "Winter") {
    ctx.fillStyle = "rgba(0, 128, 255, 0.5)";
    ctx.fillRect(400, 400, 400 * 10 / 30, 400)
    ctx.fillStyle = "rgba(231, 95, 255, 0.5)";
    ctx.fillRect(400 + 400 * 10 / 30, 400, 400 * 5 / 30, 400)
    ctx.fillStyle = "rgba(152, 13, 124, 0.5)";
    ctx.fillRect(400 + 400 * 15 / 30, 400, 400 * 5 / 30, 400)
    ctx.fillStyle = "rgba(68, 255, 0, 0.5)";
    ctx.fillRect(400 + 400 * 20 / 30, 400, 400 * 10 / 30, 400)

    ctx.fillStyle = "rgba(255,0,0,0.1)";

    ctx.beginPath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255, 100, 100, 0.7)";
    //ctx.moveTo(400,800);

    for (let i = 0; i < Sound.DW.length; i++) {
      let obj = ConvertToInfo(Sound.Slice[i]);

      if (obj.H > 3000) {
        const prevSlice = i > 0 ? ConvertToInfo(Sound.Slice[i - 1]) : null;
        if ((prevSlice && prevSlice.H < 3000) || i === 0) {
          obj = GetLayerByHght(Sound, 3000);
          if (!obj) break;
        } else {
          break;
        }
      }
      if ((obj.T != obj.T || obj.T == -9999) && (obj.WB != obj.WB || obj.WB == -9999)) {
        continue;
      }

      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * (obj.T + 15) / 30, clamp(100 * (1 - obj.H / 3000), 0, 100));

      if (i == 0) {
        ctx.lineTo(400, Pos.y);
      }
      ctx.lineTo(Pos.x, Pos.y);
    }

    ctx.lineTo(400, 400);
    ctx.lineTo(400, 800);
    ctx.stroke();
    ctx.fill();

    //now WB
    ctx.beginPath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(147, 255, 237, 0.7)";
    //ctx.moveTo(400,800);

    for (let i = 0; i < Sound.DW.length; i++) {
      let obj = ConvertToInfo(Sound.Slice[i]);

      if (obj.H > 3000) {
        const prevSlice = i > 0 ? ConvertToInfo(Sound.Slice[i - 1]) : null;
        if ((prevSlice && prevSlice.H < 3000) || i === 0) {
          obj = GetLayerByHght(Sound, 3000);
          if (!obj) break;
        } else {
          break;
        }
      }

      if ((obj.T != obj.T || obj.T == -9999) && (obj.WB != obj.WB || obj.WB == -9999)) {
        continue;
      }

      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * (obj.WB + 15) / 30, clamp(100 * (1 - obj.H / 3000),0,100));

      if (i == 0) {
        ctx.lineTo(400, Pos.y);
      }
      ctx.lineTo(Pos.x, Pos.y);
    }

    ctx.lineTo(400, 400);
    ctx.lineTo(400, 800);
    ctx.stroke();
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.strokeRect(400, 400, 400, 400);

    ctx.fillStyle = "rgba(255, 255, 255 ,1)";

    for (let i = 0.5; i < 3; i += 0.5) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 0, 100 * (1 - (i / 3)));
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100, 100 * (1 - (i / 3)));
      ctx.fillRect(Pos.x, Pos.y, 15, 4);
      ctx.fillRect(Pos2.x - 20, Pos.y, 15, 4);

      ctx.font = `${400 * 0.075}px ${globalFont}`;
      ctx.fillText(`${i}`, Pos.x + 30, Pos.y + 5);
    }

    for (let i = 15; i < -15; i += 5) {
      let Pos = GetBoxPos(BoundsX, BoundsY, 100 * ((i + 15) / 30), 0);
      let Pos2 = GetBoxPos(BoundsX, BoundsY, 100 * ((i + 15) / 30), 100);

      ctx.fillRect(Pos.x, Pos.y, 4, 15);
      ctx.fillRect(Pos.x, Pos2.y - 20, 4, 15);

      //ctx.textAlign = "left";
      ctx.font = `${400 * 0.075}px ${globalFont}`;
      ctx.fillText(`${Math.round(i)}`, Pos.x, Pos2.y - 25);
    }

    ctx.font = `bold ${400 * 0.1}px ${globalFont}`;
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.textAlign = "center";
    Pos = GetBoxPos(BoundsX, BoundsY, 50, 20);

    ctx.fillText(`PType Estimation`, Pos.x, Pos.y);
  }


  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 400, 400);
  ctx.strokeRect(0, 400, 400, 400);
  ctx.strokeRect(400, 0, 400, 400);
  ctx.strokeRect(400, 400, 400, 400);
}

// Add these exported setter functions alongside your existing exports
/** Sets or applies sounding design state state.
 * @param {*} design Parameter for setSoundingDesignState.
 * @returns {void} No value.
 */
const setSoundingDesignState = (design) => {
    if (typeof design.hodographNumbers === 'boolean') {
        DisplayHodographNumbers = design.hodographNumbers;
    }

    if (typeof design.hodographColorTable === 'number') {
        HodographColorTable = ((design.hodographColorTable % 4) + 4) % 4;
    }

    if (typeof design.hodographScaleMode === 'number') {
        HodographScaleMode = ((design.hodographScaleMode % 3) + 3) % 3;
    }

    if (typeof design.hodographTrimWindProfile === 'boolean') {
        HodographTrimWindProfile = design.hodographTrimWindProfile;
    }

    if (typeof design.readOutOn === 'boolean') {
        setReadOutOnState(design.readOutOn);
    }

    if (typeof design.skewTSkew === 'number' && SKEW_STEPS.includes(design.skewTSkew)) {
        UserSkewNumber = design.skewTSkew;
        SkewNumber = design.skewTSkew;
    }
};

/** Sets or applies sounding units state.
 * @param {*} unitSystem Parameter for setSoundingUnits.
 * @returns {void} No value.
 */
function setSoundingUnits(unitSystem) {
  switch (unitSystem) {
    case 'default':
      useImperialUnits = 0;
      break;
    case 'metric':
      useImperialUnits = 1;
      break;
    case 'imperial':
      useImperialUnits = 2;
      break;
    default:
      useImperialUnits = 0;
  }
}

/** Returns the color for a temperature based on its value.
 * @param {*} tempC Parameter for tempStyle.
 * @returns {*} Result of the function.
 */
function tempStyle(tempC) {
    if (tempC == null) return { bg: 'rgba(48, 58, 68, 0.7)', color: '#dce7ee' };
    if (tempC >= 30) return { bg: 'rgba(186, 62, 42, 0.82)', color: '#fff4f0' };
    if (tempC >= 26) return { bg: 'rgba(196, 108, 48, 0.8)', color: '#fff6ee' };
    if (tempC >= 20) return { bg: 'rgba(170, 128, 58, 0.72)', color: '#fffaf0' };
    if (tempC >= 10) return { bg: 'rgba(58, 122, 88, 0.7)', color: '#f0fff5' };
    if (tempC >= 0) return { bg: 'rgba(48, 108, 148, 0.75)', color: '#eef8ff' };
    if (tempC >= -10) return { bg: 'rgba(58, 92, 168, 0.8)', color: '#eef2ff' };
    return { bg: 'rgba(78, 70, 155, 0.85)', color: '#f2f0ff' };
}

/** Returns the color for a relative humidity based on its value.
 * @param {*} rh Parameter for rhStyle.
 * @returns {*} Result of the function.
 */
function rhStyle(rh) {
    if (rh == null) return { bg: 'rgba(48, 58, 68, 0.7)', color: '#dce7ee' };
    if (rh >= 90) return { bg: 'rgba(58, 48, 138, 0.85)', color: '#f0eaff' };
    if (rh >= 80) return { bg: 'rgba(42, 92, 155, 0.8)', color: '#eef6ff' };
    if (rh >= 65) return { bg: 'rgba(38, 125, 135, 0.75)', color: '#eefcff' };
    if (rh >= 50) return { bg: 'rgba(52, 118, 82, 0.7)', color: '#f0fff4' };
    if (rh >= 35) return { bg: 'rgba(135, 125, 55, 0.7)', color: '#fffcf0' };
    return { bg: 'rgba(145, 92, 50, 0.75)', color: '#fff6ee' };
}

/** Adds a rounded rectangle to the current canvas path.
 * @param {*} ctx Parameter for roundRectPath.
 * @param {*} x Parameter for roundRectPath.
 * @param {*} y Parameter for roundRectPath.
 * @param {*} w Parameter for roundRectPath.
 * @param {*} h Parameter for roundRectPath.
 * @param {*} r Parameter for roundRectPath.
 * @returns {void} No value.
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Fills a rounded rectangle on the canvas.
 * @param {*} ctx Parameter for fillRoundRect.
 * @param {*} x Parameter for fillRoundRect.
 * @param {*} y Parameter for fillRoundRect.
 * @param {*} w Parameter for fillRoundRect.
 * @param {*} h Parameter for fillRoundRect.
 * @param {*} r Parameter for fillRoundRect.
 * @param {*} fill Parameter for fillRoundRect.
 * @returns {void} No value.
 */
function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Strokes a rounded rectangle on the canvas.
 * @param {*} ctx Parameter for strokeRoundRect.
 * @param {*} x Parameter for strokeRoundRect.
 * @param {*} y Parameter for strokeRoundRect.
 * @param {*} w Parameter for strokeRoundRect.
 * @param {*} h Parameter for strokeRoundRect.
 * @param {*} r Parameter for strokeRoundRect.
 * @param {*} stroke Parameter for strokeRoundRect.
 * @param {*} lineWidth Parameter for strokeRoundRect.
 * @returns {void} No value.
 */
function strokeRoundRect(ctx, x, y, w, h, r, stroke, lineWidth = 1) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Chooses text with contrast against a category background.
 * @param {*} kt Parameter for categoryTextColor.
 * @returns {*} Result of the function.
 */
function categoryTextColor(kt) {
  const n = Number(kt);
  if (n >= 64 && n < 96) return '#1a1a1a';
  return '#f4fffc';
}

/** Generates the looks for the drop sonde.
 * @param {*} props Parameter for GenerateDropSondeLooks.
 * @param {*} reductions Parameter for GenerateDropSondeLooks.
 * @param {*} times Parameter for GenerateDropSondeLooks.
 * @param {*} intensityNumberFunction Parameter for GenerateDropSondeLooks.
 * @returns {void} No value.
 */
function GenerateDropSondeLooks(props, reductions, times, intensityNumberFunction){
  const Canv = $("Values11");
  const ctx = Canv.getContext("2d");
  const bg = DarkMode ? "#0a0c0e" : "#f7f8fa";
  const fg = DarkMode ? "#e8eef2" : "#1a2228";
  const muted = DarkMode ? "#8ea3b3" : "#5a6b78";
  const grid = DarkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  const headerBg = DarkMode ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)";
  const cellBg = DarkMode ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.03)";

  const W = 750;
  const padX = 14;
  // Branding lives under the skew-T title — start the table near the top
  const tableTop = 8;
  const rowWidths = [145, 130, 210, 120, 115];
  const tableW = rowWidths.reduce((a, b) => a + b, 0);
  const colH = 56;
  const rowTitles = ["Pressure", "Height", "Wind", "Temp", "RH"];
  const rows = [{ __header: true }, ...(props.windRows || [])];
  const maxRows = Math.min(rows.length, 9); // header + 8 levels
  const cornerR = 5;
  const contentRight = padX + tableW;

  // Compact summary so the level table can claim more vertical space
  const tableBottom = tableTop + maxRows * colH;
  const summaryH = 14 + 56 + 8 + 56 + 12 + 28 + 28 + 12;
  const H = tableBottom + summaryH;

  Canv.width = W;
  Canv.height = H;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
    const n = rows[rowIdx];
    const isHeader = !!n.__header;
    const y = tableTop + rowIdx * colH;
    let x = padX;

    for (let i = 0; i < rowTitles.length; i++) {
      const vTitle = isHeader ? "Plain" : rowTitles[i];
      const vWidth = rowWidths[i];
      let value = "—";
      let bgColor = isHeader ? headerBg : cellBg;
      let textColor = isHeader ? muted : fg;
      let showCat = false;
      let cat = null;

      switch (vTitle) {
        case "Pressure":
          value = n.heightM === 0 ? `${n.pressureMb} mb (SFC)` : `${n.pressureMb} mb`;
          break;
        case "Height":
          value = `${n.heightM} m`;
          break;
        case "Wind":
          value = `${n.speedKt} kt / ${n.dirDeg}°`;
          bgColor = dropsondeHurricaneBarbColor(n.speedKt);
          textColor = categoryTextColor(n.speedKt);
          showCat = true;
          cat = intensityNumberFunction(n.speedKt);
          break;
        case "Temp":
          value = n.tempC != null ? `${n.tempC}°C` : "—";
          bgColor = tempStyle(n.tempC).bg;
          textColor = tempStyle(n.tempC).color;
          break;
        case "RH":
          value = n.rh != null ? `${n.rh}%` : "—";
          bgColor = rhStyle(n.rh).bg;
          textColor = rhStyle(n.rh).color;
          break;
        case "Plain":
          value = rowTitles[i];
          break;
        default:
          value = "—";
      }

      const cellPad = 2;
      const cx = x + cellPad;
      const cy = y + cellPad;
      const cw = vWidth - cellPad * 2;
      const ch = colH - cellPad * 2;

      fillRoundRect(ctx, cx, cy, cw, ch, cornerR, bgColor);
      strokeRoundRect(ctx, cx, cy, cw, ch, cornerR, grid, 1);

      ctx.font = `${isHeader ? 600 : 700} ${W / 38}px ${globalFont}`;
      ctx.textBaseline = "middle";
      ctx.fillStyle = textColor;

      if (showCat && cat) {
        ctx.textAlign = "left";
        ctx.fillText(value, cx + 10, cy + ch / 2);

        const pillW = Math.max(48, cw * 0.28);
        const pillH = ch * 0.52;
        const pillX = cx + cw - pillW - 8;
        const pillY = cy + (ch - pillH) / 2;
        fillRoundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2, cat.color);
        strokeRoundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2, "rgba(0,0,0,0.4)", 1.25);
        ctx.font = `800 ${W / 44}px ${globalFont}`;
        ctx.textAlign = "center";
        ctx.fillStyle = categoryTextColor(n.speedKt);
        ctx.fillText(cat.shortLabel, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(value, cx + cw / 2, cy + ch / 2);
      }

      x += vWidth;
    }
  }

  const tableBottomY = tableTop + maxRows * colH;
  const summaryTop = tableBottomY + 14;
  const mean150 = props.mean150;
  const mean500 = props.mean500;

  /** Draws mean block content.
   * @param {*} label Parameter for drawMeanBlock.
   * @param {*} mean Parameter for drawMeanBlock.
   * @param {*} reduction Parameter for drawMeanBlock.
   * @param {*} y0 Parameter for drawMeanBlock.
   * @returns {*} Result of the function.
   */
  const drawMeanBlock = (label, mean, reduction, y0) => {
    const pillW = 170;
    const pillH = 28;

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = muted;
    ctx.font = `600 ${W / 40}px ${globalFont}`;
    ctx.fillText(label, padX, y0 + 10);

    if (!mean) {
      ctx.fillStyle = fg;
      ctx.font = `700 ${W / 32}px ${globalFont}`;
      ctx.fillText("—", padX, y0 + 38);
      return y0 + 52;
    }

    const speed = Math.round(10 * mean.speedKt) / 10;
    const reduced = Math.round(10 * mean.speedKt * reduction) / 10;
    const cat = intensityNumberFunction(reduced);

    // Pill aligned with the label row on the right
    const pillX = contentRight - pillW;
    fillRoundRect(ctx, pillX, y0 + 1, pillW, pillH, pillH / 2, cat.color);
    ctx.font = `800 ${W / 42}px ${globalFont}`;
    ctx.textAlign = "center";
    ctx.fillStyle = categoryTextColor(reduced);
    ctx.fillText(cat.label, pillX + pillW / 2, y0 + 1 + pillH / 2 + 0.5);

    // Wind + surface reduction on one compact line
    ctx.textAlign = "left";
    ctx.fillStyle = fg;
    ctx.font = `700 ${W / 32}px ${globalFont}`;
    const windText = `${speed} kt / ${Math.round(mean.dirDeg)}° ${mean.dirLabel}`;
    ctx.fillText(windText, padX, y0 + 42);

    const windW = ctx.measureText(windText).width;
    ctx.fillStyle = muted;
    ctx.font = `600 ${W / 40}px ${globalFont}`;
    ctx.fillText("·  surface", padX + windW + 10, y0 + 42);

    const surfLabelW = ctx.measureText("·  surface").width;
    ctx.fillStyle = fg;
    ctx.font = `700 ${W / 32}px ${globalFont}`;
    ctx.fillText(`${reduced} kt`, padX + windW + 10 + surfLabelW + 8, y0 + 42);

    return y0 + 56;
  };

  let cursorY = summaryTop;
  cursorY = drawMeanBlock("0–150 m mean wind", mean150, reductions.red150m, cursorY);
  cursorY += 8;
  cursorY = drawMeanBlock("0–500 m mean wind", mean500, reductions.red500m, cursorY);
  cursorY += 12;

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = muted;
  ctx.font = `600 ${W / 40}px ${globalFont}`;
  ctx.fillText("Drop", padX, cursorY + 10);
  ctx.fillStyle = fg;
  ctx.font = `700 ${W / 34}px ${globalFont}`;
  ctx.fillText(times.drop || "—", padX + 78, cursorY + 10);

  cursorY += 28;
  ctx.fillStyle = muted;
  ctx.font = `600 ${W / 40}px ${globalFont}`;
  ctx.fillText("Splash", padX, cursorY + 10);
  ctx.fillStyle = fg;
  ctx.font = `700 ${W / 34}px ${globalFont}`;
  ctx.fillText(times.splash || "—", padX + 78, cursorY + 10);
}

/** Loads with parcel data.
 * @param {*} Sounding Parameter for LoadWithParcel.
 * @param {*} DisplayParcel Parameter for LoadWithParcel.
 * @param {*} Info Parameter for LoadWithParcel.
 * @param {*} ghst Parameter for LoadWithParcel.
 * @param {*} comparisonSoundings Parameter for LoadWithParcel.
 * @returns {void} No value.
 */
function LoadWithParcel(Sounding, DisplayParcel, Info, ghst = false, comparisonSoundings = []) {
  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");
  const dropsondeMode = isDropsondeSounding(Sounding);
  const dropBg = DarkMode ? "#0a0c0e" : "#f7f8fa";
  const dropMuted = DarkMode ? "#8ea3b3" : "#5a6b78";
  let P = dropsondeMode
    ? dropBg
    : (DarkMode == true && "rgba(0,0,0,1)" || "rgba(255,255,255,1)");
  let PR = DarkMode == false && "rgba(0,0,0,1)" || "rgba(255,255,255,1)"

  ctx.fillStyle = P;
  ctx.fillRect(0, 0, 1000, 1000);

  let Sound = Sounding.Sounding;

  let StartSlice = GetLayerByPres(Sound, "SFC");
  let EndSlice = GetLayerByPres(Sound, "Last");

  const adiabatStyle = dropsondeMode
    ? { lineWidth: 1, strokeStyle: DarkMode ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.06)" }
    : null;
  for (var th = -30; th < 230; th += 20) {
    dry_adiabat(th, adiabatStyle)
  };

  ctx.font = `600 ${Canv.width / (dropsondeMode ? 55 : 65)}px ${globalFont}`;
  (skv.plevels || PRESSURE_LABEL_CANDIDATES).forEach((object) => {
    if (!(object > 0) || object >= skv.pbot || object < skv.ptop) return;
    let Line = pres_to_pix(object);

    ctx.fillStyle = dropsondeMode ? dropMuted : PR;
    ctx.textAlign = "left";
    ctx.fillText(`${object} mb`, 0.005 * Canv.width, (-2 + Line));
    ctx.fillStyle = dropsondeMode
      ? (DarkMode ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)")
      : (DarkMode == true && `rgba(255,255,255,0.55)` || `rgba(0,0,0,0.55)`);
    ctx.fillRect(0, (-2 + Line), Canv.width, dropsondeMode ? 1.25 : 1);
  })
  const minorBot = Math.floor(skv.pbot / 100) * 100;
  const minorTop = Math.ceil(skv.ptop / 100) * 100;
  for (let i = minorBot; minorTop <= i; i -= 100) {
    if (i >= skv.pbot || i < skv.ptop) continue;
    let Line = pres_to_pix(i);

    ctx.fillStyle = dropsondeMode
      ? (DarkMode ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.05)")
      : (DarkMode == true && `rgba(255,255,255,0.1)` || `rgba(0,0,0,0.1)`);
    ctx.fillRect(0, (-2 + Line), Canv.width, 1);
  }

  for (let i = -110; i <= 80; i += 10) {
    let PX = LevelToSkewNum(skv.pbot, skv.pbot);
    let PY = PressuretoSkew(skv.pbot, skv.pbot);
    let R = GetSkewRatio(i);

    let PX2 = LevelToSkewNum(skv.ptop, skv.pbot);
    let PY2 = PressuretoSkew(skv.ptop, skv.pbot);
    let R2 = GetSkewRatio(i);

    if (i == -20 || i == 0) {
      ctx.lineWidth = dropsondeMode ? 2 : 3;
      ctx.strokeStyle = dropsondeMode
        ? (DarkMode ? "rgba(125,160,220,0.28)" : "rgba(0,0,125,0.28)")
        : (DarkMode == true && "rgba(125,125,255,0.35)" || "rgba(0,0,125,0.35)");
    } else {
      ctx.lineWidth = dropsondeMode ? 1.25 : 2;
      ctx.strokeStyle = dropsondeMode
        ? (DarkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)")
        : (DarkMode == true && "rgba(255,255,255,0.25)" || "rgba(0,0,0,0.25)");
    }

    ctx.beginPath();
    ctx.setLineDash(dropsondeMode ? [5, 5] : [8, 3]);

    ctx.lineCap = "butt";
    if (dropsondeMode) ctx.lineCap = "round";
    //ctx.lineCap = "round";
    ctx.moveTo((R + PX) * Canv.width, PY * Canv.height);
    ctx.lineTo((R2 + PX2) * Canv.width, PY2 * Canv.height);

    ctx.stroke();
  }

  if (!dropsondeMode && (!comparisonSoundings || comparisonSoundings.length === 0)) {
    if (DisplayParcel.ECape.Path != false) {
      //EcapePrcl
      ctx.beginPath();
      ctx.setLineDash([7, 7]);
      ctx.lineWidth = 3;

      ctx.strokeStyle = `rgba(177, 214, 255, 0.66)`;

      for (let i = 0; i < DisplayParcel.ECape.Path.length - 1; i++) {
        let N = DisplayParcel.ECape.Path[i];

        let PX = LevelToSkewNum(DisplayParcel.Start.P - i, DisplayParcel.Start.P);
        let PY = PressuretoSkew(DisplayParcel.Start.P - i, DisplayParcel.Start.P);
        let R = GetSkewRatio(N);

        let N2 = DisplayParcel.ECape.Path[i + 1];
        let PX2 = LevelToSkewNum(DisplayParcel.Start.P - (i + 1), DisplayParcel.Start.P);
        let PY2 = PressuretoSkew(DisplayParcel.Start.P - (i + 1), DisplayParcel.Start.P);
        let R2 = GetSkewRatio(N2);

        if (i == 0) {
          ctx.moveTo((R + PX) * Canv.width, PY * Canv.height);
        }

        ctx.lineTo((R2 + PX2) * Canv.width, PY2 * Canv.height);
      }
      ctx.stroke();
    }


    ctx.beginPath();
    ctx.setLineDash([14, 7]);
    ctx.lineWidth = 3;

    ctx.strokeStyle = PR;

    for (let i = 0; i < DisplayParcel.Path.length - 1; i++) {
      let N = DisplayParcel.Path[i];
      let PX = LevelToSkewNum(DisplayParcel.Start.P - i, DisplayParcel.Start.P);
      let PY = PressuretoSkew(DisplayParcel.Start.P - i, DisplayParcel.Start.P);
      let R = GetSkewRatio(N);

      let N2 = DisplayParcel.Path[i + 1];
      let PX2 = LevelToSkewNum(DisplayParcel.Start.P - (i + 1), DisplayParcel.Start.P);
      let PY2 = PressuretoSkew(DisplayParcel.Start.P - (i + 1), DisplayParcel.Start.P);
      let R2 = GetSkewRatio(N2);

      if (i == 0) {
        ctx.moveTo((R + PX) * Canv.width, PY * Canv.height);
      }
      ctx.lineTo((R2 + PX2) * Canv.width, PY2 * Canv.height);
    }

    ctx.stroke();
  }

  if (!dropsondeMode) {
    ctx.fillStyle = CheckMode("rgba(255,0,0,0.5)", "rgba(125,0,0,0.5)");

    ctx.fillRect(0, pres_to_pix(DisplayParcel.Start != undefined && DisplayParcel.Start.P || 0), Canv.width, 2);

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = CheckMode("rgba(200,0,125,1)", "rgba(100,0,75,1)");

    DrawValuesKey();
    DrawValues("SB", Info.SBParcel, Info.SBParcel == DisplayParcel);
    DrawValues("ML", Info.MLParcel, Info.MLParcel == DisplayParcel);
    DrawValues("MU", Info.MUParcel, Info.MUParcel == DisplayParcel);
    DrawValues("CU", CUPrcl, CUPrcl == DisplayParcel);

    let DCapeProf = Info.DCapeProf;

    for (let i = 0; i < DCapeProf.PresTrace.length; i++) {
      let N = DCapeProf.TempTrace[i];
      let PX = LevelToSkewNum(DCapeProf.StartPres.P + i, DCapeProf.StartPres.P);
      let PY = PressuretoSkew(DCapeProf.StartPres.P + i, DCapeProf.StartPres.P);
      let R = GetSkewRatio(N);

      let N2 = DCapeProf.TempTrace[i + 1];
      let PX2 = LevelToSkewNum(DCapeProf.StartPres.P + (i + 1), DCapeProf.StartPres.P);
      let PY2 = PressuretoSkew(DCapeProf.StartPres.P + (i + 1), DCapeProf.StartPres.P);
      let R2 = GetSkewRatio(N2);
      if (i == 0) {
        ctx.moveTo((R + PX) * Canv.width, PY * Canv.height);
      }
      ctx.lineTo((R2 + PX2) * Canv.width, PY2 * Canv.height);
    }

    ctx.stroke();
  }

  ctx.setLineDash([]);

  ctx.save();
  ctx.restore();
  if (!dropsondeMode) {
    ctx.font = `bold ${Canv.width / 75}px ${globalFont}`;
    for (var w of [2, 5, 10, 15, 20, 25]) {
      MixRatioLine(w);
    }
  } else {
    // Softer mixing-ratio traces for dropsonde charts
    ctx.font = `600 ${Canv.width / 70}px ${globalFont}`;
    for (var w of [10, 15, 20]) {
      const CanvMix = Canv;
      const ctxMix = ctx;
      var pbot = Math.min(1045, skv.pbot);
      var ptop = Math.max(skv.ptop, Math.min(600, pbot - 50));
      if (pbot <= ptop) { pbot = skv.pbot; ptop = skv.ptop; }
      var temp = temp_at_mixrat(w, pbot);
      var x0 = CanvMix.width * (GetSkewRatio(temp) + LevelToSkewNum(pbot));
      var y0 = pres_to_pix(pbot);
      temp = temp_at_mixrat(w, ptop);
      var x1 = CanvMix.width * (GetSkewRatio(temp) + LevelToSkewNum(ptop));
      var y1 = pres_to_pix(ptop);
      ctxMix.save();
      ctxMix.beginPath();
      ctxMix.setLineDash([3, 6]);
      ctxMix.strokeStyle = DarkMode ? "rgba(61, 206, 168, 0.22)" : "rgba(20, 120, 90, 0.25)";
      ctxMix.lineWidth = 1.5;
      ctxMix.lineCap = "round";
      ctxMix.moveTo(x0, y0);
      ctxMix.lineTo(x1, y1);
      ctxMix.stroke();
      ctxMix.fillStyle = DarkMode ? "rgba(61, 206, 168, 0.55)" : "rgba(20, 120, 90, 0.55)";
      ctxMix.textAlign = "center";
      ctxMix.fillText(`${w}`, x1, y1);
      ctxMix.restore();
    }
  }

  if (!dropsondeMode) {
    ctx.fillStyle = PR;
    ctx.fillText(`Omega`, 0.05 * Canv.width, 15);
  }

  ctx.font = `${dropsondeMode ? 600 : 700} ${Canv.width / (dropsondeMode ? 48 : 52)}px ${globalFont}`;
  [0, 1, 3, 6, 9, 12, 15].forEach((object) => {
    if (EndSlice.H / 1000 < object) {
      return;
    }
    let GetPresLayer = GetLayerByHght(Sound, object * 1000);

    if (GetPresLayer != null) {
      let Loc = pres_to_pix(GetPresLayer.P, Sound.DW[0].P);

      ctx.fillStyle = dropsondeMode ? "rgba(255, 107, 90, 0.9)" : "rgba(255,10,10,1)";
      const labelX = dropsondeMode ? 0.135 * Canv.width : 0.13 * Canv.width;
      ctx.textAlign = dropsondeMode ? "left" : "center";

      if (object == 0) {
        ctx.fillText(`SFC`, labelX, Loc);
        ctx.fillRect(0.09 * Canv.width, (Loc - 1) - 5, 0.02 * Canv.width, dropsondeMode ? 2.5 : 2);
      } else {
        ctx.fillText(`${object} km`, labelX, Loc);
        ctx.fillRect(0.09 * Canv.width, (Loc - 1) - 5, 0.02 * Canv.width, dropsondeMode ? 2.5 : 2);
      }

    }

  });

  

  if (comparisonSoundings && comparisonSoundings.length > 0) {
    comparisonSoundings.forEach(comp => {
      if (!comp.metadata.isVisible) return;
      const color = comp.metadata.comparisonColor || "rgba(0, 191, 255, 0.9)";
      if (comp.sounding) {
        DrawLine(comp.sounding, "Temp", false, color);
        DrawLine(comp.sounding, "Dew", false, color);
      }
    });
  }

  if (ghst) {
    DrawLine(Sounding, "Dew", ghost);
    DrawLine(Sounding, "Temp", ghost);
  }

  DrawLine(Sounding, "Dew");
  
  if (!dropsondeMode && (!comparisonSoundings || comparisonSoundings.length === 0)) {
    DrawLine(Sounding, "WetBulb");
    DrawLine(Sounding, "VTemp");
  }

  DrawLine(Sounding, "Temp");

  if (!dropsondeMode) {
    let sp = pres_to_pix(StartSlice.P);
    let ep = pres_to_pix(EndSlice.P);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(0.065 * Canv.width, sp, 2, (ep - sp));

    if (Sound.OMEGA.length > 0) {
      for (let i = 0; i < Sound.OMEGA.length; i++) {
        let Pres = Sound.P[i];
        let Omg = Sound.OMEGA[i];
        let Center = 0.065;

        if (Omg > 0) {
          ctx.fillStyle = "rgba(255,0,0,0.8)";
        } else {
          ctx.fillStyle = "rgba(125,125,255,0.8)";
        }
        let pp = pres_to_pix(Pres);
        ctx.fillRect(Center * Canv.width + 1, pp, Omg * Canv.width, 5);
      }
    }

    const omgDgzTop = GetLayerByTemp(Sound, -18);
    const omgDgzBottom = GetLayerByTemp(Sound, -12);
    if (omgDgzTop && omgDgzBottom) {
      const y_top = pres_to_pix(omgDgzTop.P);
      const y_bottom = pres_to_pix(omgDgzBottom.P);
      ctx.fillStyle = "rgba(255, 175, 126, 1)";
      ctx.fillRect(0, y_top - 1, 0.1 * Canv.width, 2);
      ctx.fillRect(0, y_bottom - 1, 0.1 * Canv.width, 2);
    }

    DrawInflow(Sounding.Sounding, Info.EffInflow);
  }

  ctx.font = `bold ${Canv.width / 40}px ${globalFont}`;

  if (!dropsondeMode && (!comparisonSoundings || comparisonSoundings.length === 0)) {
    ctx.fillStyle = `rgba(0,200,200,1)`;
    let ddx = (GetSkewRatio(StartSlice.WB) + LevelToSkewNum(StartSlice.P)) * Canv.width;
    let ddy = pres_to_pix(StartSlice.P) + 0.025 * Canv.height;
    const wbLabel = Math.round(useImperialUnits === 1 ? StartSlice.WB : CToF(StartSlice.WB));
    ctx.fillText(`${wbLabel}`, ddx, ddy);
  }

  ctx.fillStyle = `rgba(255,0,0,1)`;
  ctx.textAlign = "left";
  let ddx = (GetSkewRatio(StartSlice.T) + LevelToSkewNum(StartSlice.P)) * Canv.width;
  let ddy = pres_to_pix(StartSlice.P) + 0.025 * Canv.height;
  const tLabel = Math.round(useImperialUnits === 1 ? StartSlice.T : CToF(StartSlice.T));
  ctx.fillText(`${tLabel}`, ddx, ddy);

  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(0,255,0,1)`;
  ddx = (GetSkewRatio(StartSlice.D) + LevelToSkewNum(StartSlice.P)) * Canv.width;
  ddy = pres_to_pix(StartSlice.P) + 0.025 * Canv.height;
  const dLabel = Math.round(useImperialUnits === 1 ? StartSlice.D : CToF(StartSlice.D));
  ctx.fillText(`${dLabel}`, ddx, ddy);

  if (dropsondeMode) {
    const mslpMb = resolveDropsondeMslpMb(Sounding, StartSlice);
    if (mslpMb != null) {
      const xT = (GetSkewRatio(StartSlice.T) + LevelToSkewNum(StartSlice.P)) * Canv.width;
      const xD = (GetSkewRatio(StartSlice.D) + LevelToSkewNum(StartSlice.P)) * Canv.width;
      const xMid = (xT + xD) / 2;
      const yMslp = pres_to_pix(StartSlice.P) + 0.055 * Canv.height;
      ctx.fillStyle = DarkMode == true ? "rgba(232, 238, 242, 0.95)" : "rgba(0,0,0,0.9)";
      ctx.textAlign = "center";
      ctx.font = `600 ${Canv.width / 48}px ${globalFont}`;
      ctx.fillText(`${mslpMb} mb`, xMid, yMslp);
    }
    // Skip LCL/LFC/EL/HGZ/FZL clutter — side panel covers dropsonde-relevant stats.
    return;
  }

  //LFC, LCL, EL
  let LCL = false; let LFC = false; let EL = false; let MPL = false;

  try {
    if (DisplayParcel.LCL == -9999) {
      LCL = false;
    } else {
      LCL = GetLayerByHght(Sound, DisplayParcel.LCL + DisplayParcel.Start.H, true);
    }
    if (DisplayParcel.LFC == -9999) {
      LFC = false;
    } else {
      LFC = GetLayerByHght(Sound, DisplayParcel.LFC + DisplayParcel.Start.H, true);
    }
    if (DisplayParcel.EL == -9999) {
      EL = false;
    } else {
      EL = GetLayerByHght(Sound, DisplayParcel.EL + DisplayParcel.Start.H, true);
    }
    if (DisplayParcel.MPL == -9999) {
      MPL = false;
    } else {
      MPL = GetLayerByHght(Sound, DisplayParcel.MPL + DisplayParcel.Start.H, true);
    }
  } catch (E) {

  }

  let FZL = GetLayerByTemp(Sound, 0);
  let WBZ0 = GetLayerByTemp(Sound, 0, true);

  let T10 = GetLayerByTemp(Sound, -10);
  let T12 = GetLayerByTemp(Sound, -12);
  let T18 = GetLayerByTemp(Sound, -18);
  let T20 = GetLayerByTemp(Sound, -20);
  let T30 = GetLayerByTemp(Sound, -30);

  const t10Label = useImperialUnits === 2 ? Math.round(CToF(-10)) : -10;
  const t20Label = useImperialUnits === 2 ? Math.round(CToF(-20)) : -20;
  const t30Label = useImperialUnits === 2 ? Math.round(CToF(-30)) : -30;
  const fzlHeightVal = FZL && FZL.H ? FZL.H : (FZL = false, undefined);
  const fzlHeight = fzlHeightVal === undefined ? "--" : Math.round(useImperialUnits === 2 ? MToFt(fzlHeightVal) : fzlHeightVal);
  
  const wb0Val = WBZ0 && WBZ0.H ? WBZ0.H : (WBZ0 = false, undefined);
  const wb0 = wb0Val === undefined ? "--" : Math.round(useImperialUnits === 2 ? MToFt(wb0Val) : wb0Val);
  
  const heightUnit = useImperialUnits === 2 ? "ft" : "m";

  ctx.textAlign = "center";

  ctx.font = `bold ${Canv.width / 60}px ${globalFont}`;

  if (DisplayOnMapCape){
    if (Presets['Vertical'] == 'Winter'){
      ctx.fillStyle = `rgba(200,200,200,1)`;
      ddy = pres_to_pix(T12.P);
      ctx.fillText(`<- ${Math.round(DisplayParcel.PreDGZCape)}`, 0.75 * Canv.width, ddy + 0.005 * Canv.height);
      ddy = (pres_to_pix(T18.P) + pres_to_pix(T12.P)) / 2;
      ctx.font = `bold ${Canv.width / 50}px ${globalFont}`;
      ctx.fillText(`<- ${Math.round(DisplayParcel.DGZCape)} DGZCape`, 0.725 * Canv.width, ddy);
      ctx.font = `bold ${Canv.width / 60}px ${globalFont}`;

      ddy = pres_to_pix(T18.P);
      ctx.fillText(`<- ${Math.round(DisplayParcel.DGZCape + DisplayParcel.PreDGZCape)}`, 0.75 * Canv.width, ddy - 0.005 * Canv.height);
    } else {
      ctx.fillStyle = `rgba(200,200,200,1)`;
      ddy = pres_to_pix(T10.P);
      ctx.fillText(`<- ${Math.round(DisplayParcel.PreHGZCape)}`, 0.75 * Canv.width, ddy - 0.005 * Canv.height);
      ddy = (pres_to_pix(T30.P) + pres_to_pix(T10.P)) / 2;
      ctx.font = `bold ${Canv.width / 50}px ${globalFont}`;
      ctx.fillText(`<- ${Math.round(DisplayParcel.HGZCape)} HGZCape`, 0.725 * Canv.width, ddy - 0.005 * Canv.height);
      ctx.font = `bold ${Canv.width / 60}px ${globalFont}`;

      ddy = pres_to_pix(T30.P);
      ctx.fillText(`<- ${Math.round(DisplayParcel.HGZCape + DisplayParcel.PreHGZCape)}`, 0.75 * Canv.width, ddy - 0.005 * Canv.height);
    }
  }
  
  const InitPosTemps = 0.83;
  ctx.font = `bold ${Canv.width / 45}px ${globalFont}`;
  ctx.fillStyle = `rgba(200,0,200,1)`;
  ddy = pres_to_pix(T10.P);
  ctx.fillRect((0.01 + InitPosTemps) * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
  ctx.fillText(`${t10Label}`, (0.03 + InitPosTemps) * Canv.width, ddy - 0.005 * Canv.height);

  ddy = pres_to_pix(T20.P);
  ctx.fillRect((0.01 + InitPosTemps) * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
  ctx.fillText(`${t20Label}`, (0.03 + InitPosTemps) * Canv.width, ddy - 0.005 * Canv.height);

  ddy = pres_to_pix(T30.P);
  ctx.fillRect((0.01 + InitPosTemps) * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
  ctx.fillText(`${t30Label}`, (0.03 + InitPosTemps) * Canv.width, ddy - 0.005 * Canv.height);

  ctx.font = `bold ${Canv.width / 50}px ${globalFont}`;
  if (FZL && FZL.H < EndSlice.H) {
    ctx.fillStyle = `rgba(0,100,200,1)`;
    ddy = pres_to_pix(FZL.P);
    ctx.fillRect(InitPosTemps * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
    ctx.fillText(`FZL ${fzlHeight}${heightUnit}`, (0.03 + InitPosTemps) * Canv.width, ddy - 0.005 * Canv.height);
  }

  if (WBZ0 && WBZ0.H < EndSlice.H) {
    ctx.fillStyle = `rgb(0, 200, 180)`;
    ddy = pres_to_pix(WBZ0.P);
    if (ddy - pres_to_pix(FZL.P) < 0.05 * Canv.height){
      ctx.fillRect(InitPosTemps * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
      ctx.fillText(`WBZ0 ${wb0}${heightUnit}`, (0.03 + InitPosTemps) * Canv.width, ddy + Canv.height/60 + 0.005 * Canv.height);
    } else {
      ctx.fillRect(InitPosTemps * Canv.width, ddy, 0.05 * Canv.width, 1 + 0.002 * Canv.height);
      ctx.fillText(`WBZ0 ${wb0}${heightUnit}`, (0.03 + InitPosTemps) * Canv.width, ddy - 0.005 * Canv.height);
    }
    
  }

  // --- ADDED: Calculate and Draw DGZ RH on Skew-T ---
  const dgzTop = GetLayerByTemp(Sound, -18);
  const dgzBottom = GetLayerByTemp(Sound, -12);

  if (dgzTop && dgzBottom) {
    // Calculate the average RH in the layer
    const avgRH = mean_rh_in_layer(Sound, dgzBottom.P, dgzTop.P);

    if (!isNaN(avgRH)) {
      // Find the vertical midpoint of the DGZ
      const y_top = pres_to_pix(dgzTop.P);
      const y_bottom = pres_to_pix(dgzBottom.P);
      const mid_y = (y_top + y_bottom) / 2;

      // Set text properties for the new label
      ctx.font = `bold ${Canv.width / 50}px ${globalFont}`;
      ctx.fillStyle = 'rgba(255, 165, 0, 1)'; // Bright Orange
      ctx.textAlign = "left";

      // Draw the text on the left side of the Skew-T, near the Omega display
      // ctx.fillText(`DGZ RH: ${Math.round(avgRH)}%`, 0.86 * Canv.width, mid_y);
    }
  }
  // --- END of DGZ RH code ---
  ctx.textAlign = "center";
  if (LCL != false) {
    ctx.fillStyle = `rgba(0,200,0,1)`;
    ddy = pres_to_pix(LCL.P);
    ctx.fillRect(0.92 * Canv.width, ddy, 0.06 * Canv.width, 1 + 0.002 * Canv.height);
    ctx.fillText(`LCL`, 0.95 * Canv.width, ddy + 0.02 * Canv.height);
  }
  if (LFC != false) {
    ctx.fillStyle = `rgba(200,200,0,1)`;
    ddy = pres_to_pix(LFC.P);
    ctx.fillRect(0.93 * Canv.width, ddy, 0.04 * Canv.width, 1 + 0.002 * Canv.height);
    ctx.fillText(`LFC`, 0.95 * Canv.width, ddy - 0.005 * Canv.height);
  }

  if (EL != false) {
    ctx.fillStyle = `rgba(200,0,200,1)`;
    ddy = pres_to_pix(EL.P);
    ctx.fillRect(0.93 * Canv.width, ddy, 0.04 * Canv.width, 1 + 0.002 * Canv.height);
    ctx.fillText(`EL`, 0.95 * Canv.width, ddy - 0.005 * Canv.height);
  }
  if (MPL != false) {
    ctx.fillStyle = `rgba(255,0,255,1)`;
    ddy = pres_to_pix(MPL.P);
    ctx.fillRect(0.93 * Canv.width, ddy, 0.04 * Canv.width, 1 + 0.002 * Canv.height);
    ctx.fillText(`MPL`, 0.95 * Canv.width, ddy - 0.005 * Canv.height);
  }

  GetLapseBox(Sounding.Sounding);
}


/** Converts polarto cart no90 values.
 * @param {*} Slice Parameter for ConvertPolartoCart_No90.
 * @returns {*} Result of the function.
 */
function ConvertPolartoCart_No90(Slice) {
  // // console.log(Slice);
  return {
    x: Slice.WS * Math.cos(degtoRad((Slice.WD) % 360)),
    y: Slice.WS * Math.sin(degtoRad((Slice.WD) % 360))
  }
}

/** Loads with wind data.
 * @param {*} Sounding Parameter for LoadWithWind.
 * @param {*} Info Parameter for LoadWithWind.
 * @param {*} ghost Parameter for LoadWithWind.
 * @param {*} comparisonSoundings Parameter for LoadWithWind.
 * @returns {void} No value.
 */
function LoadWithWind(Sounding, Info, ghost = false, comparisonSoundings = []) {
  UpdateCSMotStorm(CSMot);
  let Sound = Sounding.Sounding;

  // Dropsondes: wind barbs only — skip hodograph / shear / SRH panels.
  if (isDropsondeSounding(Sounding)) {
    DrawBarbs(Sounding, comparisonSoundings);
    return;
  }

  DrawHodograph(Sounding, ghost, comparisonSoundings);

  computeWindParams(Sounding, Info, DP, CSMot, WindParams);
  DrawWindParams(Sounding, WindParams);
  DrawBoxes(Sounding, Info, WindParams);

  let TPerms = {
    DCapeProf: Info.DCapeProf,
  };

  DrawInsetParams(Sounding, WindParams, TPerms, Info.SBParcel, Info.MLParcel, Info.MUParcel, false, Presets, $("Values3"));

  //let SRH03 = GetSRH(Sound, 0, 3000, "Hght");
  //// console.log(SRH);

  DrawInflowHodo(Sound, Info.EffInflow);
  DrawBarbs(Sounding, comparisonSoundings);
}

let VWPActive = false;

/** Sets or applies vwp active state.
 * @param {*} value Parameter for setVwpActive.
 * @returns {void} No value.
 */
function setVwpActive(value) {
  VWPActive = value === true;
}

let Info = {};
let Snding = {};
let currentComparisonSoundings = [];
let DP = {};
let CUPrcl = [];
let Motions = {};
let CUMot = {};
let rStart = {};
let WindParams = {
  ['MeanWind']: {},
  ['SW']: {},
};
let CustomWindLayer = {};
let CustomLapseLayer = {};
let relStart = false;
let FrontActive = false;

let dStart = { x: 0, y: 0 };
let dEnd = { x: 0, y: 0 };

/** Handles mouse movement over the hodograph.
 * @param {*} e Parameter for HodographMouseMoved.
 * @returns {void} No value.
 */
function HodographMouseMoved(e) {
  if (ChangeMod && activeChange2) {
    const Canv = $("hodographOverHang3");
    const ctx = Canv.getContext("2d");
    ctx.clearRect(0, 0, 1000, 1000);

    const Cnv = $("skewTOverHang2");
    const cx = Cnv.getContext("2d");
    cx.clearRect(0, 0, 1000, 1000);

    let PosC = getMousePos(Canv, e);
    dEnd2 = PosC;

    dStart = { x: 0, y: 0 };
    dEnd = { x: 0, y: 0 };


    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(dStart2.x, dStart2.y, dEnd2.x - dStart2.x, dEnd2.y - dStart2.y);
  } else if (ChangeMod && !activeChange2) {
    const Canv = $("hodographOverHang3");
    const ctx = Canv.getContext("2d");

    ctx.clearRect(0, 0, 1000, 1000);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(dStart2.x, dStart2.y, dEnd2.x - dStart2.x, dEnd2.y - dStart2.y);
  }
}

let SkewMouseP = false;
let def = {};
var md = false;


/** Handles mouse movement over the skew-T.
 * @param {*} e Parameter for SkewTMouseMoved.
 * @returns {void} No value.
 */
function SkewTMouseMoved(e) {
  CursorReadout(e);

  if (altScrollActive && !ChangeMod && md) {
    const cnv = $("skewTOverHang");

    if (SkewMouseP == false) {
      SkewMouseP = getMousePos(cnv, e);
      def = SkewTPosition;
    }

    var CPos = getMousePos(cnv, e);

    SkewTPosition = {
      x: def.x + (CPos.x - SkewMouseP.x) * (1 / SkewTScale),
      y: def.y + (CPos.y - SkewMouseP.y) * (1 / SkewTScale),
    }

    SkewTPosition.x = clamp(SkewTPosition.x, -(cnv.width - cnv.width / SkewTScale), 0);
    SkewTPosition.y = clamp(SkewTPosition.y, -(cnv.height - cnv.height / SkewTScale), 0);

    DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
    CursorReadout(false, true, true);
  }

  if (ChangeMod && activeChange) {
    const Canv = $("skewTOverHang2");
    const ctx = Canv.getContext("2d");
    ctx.clearRect(0, 0, 1000, 1000);

    const Cnv = $("hodographOverHang3");
    const cx = Cnv.getContext("2d");
    cx.clearRect(0, 0, 1000, 1000);

    let PosC = getMousePos(Canv, e);

    dEnd = PosC;

    dStart2 = { x: 0, y: 0 };
    dEnd2 = { x: 0, y: 0 };

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(dStart.x, dStart.y, dEnd.x - dStart.x, dEnd.y - dStart.y);
  } else if (ChangeMod && !activeChange) {
    const Canv = $("skewTOverHang2");
    const ctx = Canv.getContext("2d");

    ctx.clearRect(0, 0, 1000, 1000);

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(dStart.x, dStart.y, dEnd.x - dStart.x, dEnd.y - dStart.y);
  }
}

/** Toggles the cursor visibility.
 * @returns {void} No value.
 */
function Flip() {
  if (ReadOutOn) {
    CursorActive = !CursorActive;
  }
}

let SelectedLayer = false;

let activeChange = false;
let activeChange2 = false;
let Slices = [];

let dStart2 = { x: 0, y: 0 };
let dEnd2 = { x: 0, y: 0 }

let ScrollCD = true;
let SkewTScale = 1;
let SkewTPosition = { x: 0, y: 0 };
let ScrollSkewCD = true;
let altScrollActive = false;
let DisplayHodographNumbers = false;
let HodographColorTable = 0;

let HodographScaleMode = 0;

/** Hodograph scale: 0 = none, 1 = storm relative, 2 = dynamic. Cycles when mode is omitted.
 * @param {*} mode Parameter for ChangeStateDynamicHodo.
 * @returns {*} Result of the function.
 */
function ChangeStateDynamicHodo(mode) {
    HodographScaleMode = typeof mode === 'number' ? ((mode % 3) + 3) % 3 : (HodographScaleMode + 1) % 3;
    redrawHodographPanels();
    return HodographScaleMode;
}

/** Hodograph color table: 0 = Default, 1 = SounderPY, 2 = Rainbow, 3 = Greyscale. Cycles when omitted.
 * @param {*} index Parameter for ChangeStateHodographColorTable.
 * @returns {*} Result of the function.
 */
function ChangeStateHodographColorTable(index) {
  HodographColorTable = typeof index === 'number' ? ((index % 4) + 4) % 4 : (HodographColorTable + 1) % 4;
  redrawHodographPanels();
  return HodographColorTable;
}

/** Height labels along the hodograph trace. Toggles when `on` is omitted.
 * @param {*} on Parameter for ChangeStateHodographNumbers.
 * @returns {*} Result of the function.
 */
function ChangeStateHodographNumbers(on) {
  DisplayHodographNumbers = typeof on === 'boolean' ? on : !DisplayHodographNumbers;
  redrawHodographPanels();
  return DisplayHodographNumbers;
}

/** Thin dense observed wind profiles to SPC-like spacing on the hodograph.
 * @param {*} on Parameter for setHodographTrimWindProfile.
 * @returns {*} Result of the function.
 */
function setHodographTrimWindProfile(on) {
  HodographTrimWindProfile = on !== false;
  redrawHodographPanels();
  return HodographTrimWindProfile;
}

/** Redraws the hodograph panels.
 * @returns {void} No value.
 */
function redrawHodographPanels() {
  if (!Snding || !Snding.Sounding) return;
  DrawHodograph(Snding, ghost, currentComparisonSoundings);
  if (Info && Info.EffInflow !== undefined) DrawInflowHodo(Snding.Sounding, Info.EffInflow);
}

/** Handles wheel events for the skew-T.
 * @param {*} e Parameter for SkewTWheel.
 * @returns {void} No value.
 */
function SkewTWheel(e) {
  e.preventDefault();
  const Canv = $("skewT");
  const rect = Canv.getBoundingClientRect();

  const Canv2 = $("skewTOverHang2");
  if (!ScrollSkewCD) {
    return;
  }
  ScrollSkewCD = false;
  setTimeout(() => { ScrollSkewCD = true }, 100);

  let PosC = getMousePos(Canv2, e);

  if (PosC.x >= Canv2.width || PosC.x <= 0 || PosC.y >= Canv2.height || PosC.y <= 0) {
    return;
  }

  let ScrollFactor = {
    x: PosC.x / Canv2.width - 0.5,
    y: PosC.y / Canv2.height - 0.5,
  }

  var x = -(e.offsetX / rect.width) * Canv.width;
  var y = -(e.offsetY / rect.height) * Canv.height;


  if (e.wheelDelta > 0 && SkewTScale < 3) {
    const newScale = SkewTScale;
    SkewTScale = clamp(SkewTScale + 0.2, 1, 3);

    SkewTPosition.x = x - (x - SkewTPosition.x) * (newScale / SkewTScale);
    SkewTPosition.y = y - (y - SkewTPosition.y) * (newScale / SkewTScale);

    SkewTPosition.x = clamp(SkewTPosition.x, -(Canv2.width - Canv2.width / SkewTScale), 0);
    SkewTPosition.y = clamp(SkewTPosition.y, -(Canv2.height - Canv2.height / SkewTScale), 0);
  } else if (e.wheelDelta <= 0 && SkewTScale > 1) {
    const newScale = SkewTScale;
    SkewTScale = clamp(SkewTScale - 0.2, 1, 3);

    SkewTPosition.x = x - (x - SkewTPosition.x) * (newScale / SkewTScale);
    SkewTPosition.y = y - (y - SkewTPosition.y) * (newScale / SkewTScale);

    SkewTPosition.x = clamp(SkewTPosition.x, -(Canv2.width - Canv2.width / SkewTScale), 0);
    SkewTPosition.y = clamp(SkewTPosition.y, -(Canv2.height - Canv2.height / SkewTScale), 0);
  }

  if (Snding.Sounding) {
    DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
    CursorReadout(false, true, true);
  }
}

/** Handles wheel events for the hodograph.
 * @param {*} e Parameter for HodographWheel.
 * @returns {void} No value.
 */
function HodographWheel(e) {
  e.preventDefault();
  const Canv = $("hodograph");
  if (!ScrollCD) {
    return;
  }
  ScrollCD = false;

  let PosC = getMousePos(Canv, e);

  if (PosC.x >= Canv.width || PosC.x <= 0 || PosC.y >= Canv.height || PosC.y <= 0) {
    return;
  }

  if (e.wheelDelta > 0) {
    HodographScaleMulti = clamp(HodographScaleMulti + 0.2, 1, 8);
  } else {
    HodographScaleMulti = clamp(HodographScaleMulti - 0.2, 1, 8);
  }

  if (Snding.Sounding && Info.EffInflow != undefined) {
    DrawHodograph(Snding, false, currentComparisonSoundings);
    DrawFront(false, true);
    DrawInflowHodo(Snding.Sounding, Info.EffInflow);
    CursorReadout(false, true, true);
  }

  setTimeout(() => { ScrollCD = true }, 100);
};

let ctrldown = false;
/** Handles on window key up events.
 * @param {*} e Parameter for onWindowKeyUp.
 * @returns {void} No value.
 */
const onWindowKeyUp = (e) => {
  if (e.key == "Control") {
    ctrldown = false;
  }
  if (e.key == "Alt") {
    SkewMouseP = false;
    altScrollActive = false;
  }
};

/** Initializes the remote data stores.
 * @returns {void} No value.
 */
function RemoteDataStores(){
  Slices = [];
  ChangeMod = false;
  dStart2 = {x:0, y:0};
  dEnd2 = {x:0, y:0};
}

/** Handles on window key down events.
 * @param {*} e Parameter for onWindowKeyDown.
 * @returns {void} No value.
 */
const onWindowKeyDown = (e) => {
  if (altScrollActive == false) {
    altScrollActive = e.key == "Alt";
  };

  if (Slices.length > 0 && ChangeMod) {
    let Dir = 0;
    let Diry = 0;
    let I = 0;
    let FS = Slices[0];
    let M = false;
    let N = false;
    let L = false;

    if (ctrldown == false) {
      ctrldown = e.key == "Control";
    }

    if (e.key == "ArrowLeft") {
      Dir = -1;
      e.preventDefault();
      
    } else if (e.key == "ArrowRight") {
      Dir = 1;
      e.preventDefault();
      
    } else if (e.key == "ArrowUp" && !FS.Temp) {
      Diry = -1;
      e.preventDefault();
      
    } else if (e.key == "ArrowDown" && !FS.Temp) {
      Diry = 1;
      e.preventDefault();
      
    } else if (e.key == "i" && !FS.Temp) {
      I = 1;
      e.preventDefault();
    } else if (e.key == "o" && !FS.Temp) {
      I = -1;
      e.preventDefault();
    } else if (e.key == "l" && FS.Temp) {
      L = true;
      e.preventDefault();
      
    } else if (e.key == "m" && FS.Temp) {
      M = true;
      e.preventDefault();
      
    } else if (e.key == "n" && FS.Temp) {
      N = true;
      e.preventDefault();
    } else {
      return;
    }

    let Last = Slices[Slices.length - 1];
    let First = Slices[0];

    for (let i = 0; i < Slices.length; i++) {
      let nSlice = Slices[i];

      if (nSlice.Temp != undefined) {
        if (M == false && N == false && L == false) {
          if (nSlice.Temp == true) {
            nSlice.T += Dir;
            nSlice.T = Math.max(nSlice.T, nSlice.D);
          }
          if (nSlice.Dew == true) {
            nSlice.D += Dir;
            nSlice.D = Math.min(nSlice.T, nSlice.D);
          }
        } else if (M == true) {
          nSlice.T = Lerp(First.T, Last.T, (nSlice.H - First.H) / (Last.H - First.H));
          nSlice.D = Lerp(First.D, Last.T - 0.5, clamp((1.2 * (nSlice.H - First.H) / (Last.H - First.H)) ** 0.5, 0, 1));
        } else if (L == true) {
          nSlice.T = Lerp(First.T, Last.T, (nSlice.H - First.H) / (Last.H - First.H));
          nSlice.D = Lerp(First.D, Last.D, (nSlice.H - First.H) / (Last.H - First.H));
        } else if (N == true) {
          nSlice.T = Last.T + 9.81 * (Last.H - nSlice.H) / 1000;
          nSlice.D = Last.D + 2 * (Last.H - nSlice.H) / 1000;
        }

        nSlice.VT = VirtTemp(nSlice, GetLayerByPres(Snding.Sounding, "SFC").P, false, true);
        nSlice.WB = wetbulb(nSlice.P, nSlice.T, nSlice.D)

        Snding.Sounding.TW[nSlice.Pos].T = nSlice.T;
        Snding.Sounding.TW[nSlice.Pos].VT = nSlice.VT;
        Snding.Sounding.TW[nSlice.Pos].WB = nSlice.WB;
        Snding.Sounding.T[nSlice.Pos] = nSlice.T;

        Snding.Sounding.TW[nSlice.Pos].VT = nSlice.VT;
        Snding.Sounding.TW[nSlice.Pos].WB = nSlice.WB;

        Snding.Sounding.D[nSlice.Pos] = nSlice.D;
        Snding.Sounding.DW[nSlice.Pos].D = nSlice.D;

        Snding.Sounding.Slice[nSlice.Pos] = ConvertToRaw(nSlice);
      } else {
        if (nSlice.Wind == true) {
          nSlice.WS += I;
          nSlice.WS = clamp(nSlice.WS, 0.1, 5000);

          let P = ConvertPolartoCart(nSlice);
          P.x += Dir;
          P.y += Diry;

          let D = ConvertCartToPolarReal(P);
          nSlice.WD = D.WD;
          nSlice.WS = D.WS;
        }


        Snding.Sounding.W[nSlice.Pos].WD = nSlice.WD;
        Snding.Sounding.W[nSlice.Pos].WS = nSlice.WS;

        Snding.Sounding.Slice[nSlice.Pos] = ConvertToRaw(nSlice);
      };
    }
    if (!Snding.Title.includes("(Modified)")) {
      Snding.Title += " (Modified)";
    }

    ShowObjects();
    SetTitle(Snding);
    DrawHodograph(Snding);
    DrawSkewT(Snding, false, currentComparisonSoundings);
  }
};

/** Finishes mouse input on skew-t
 * @param {*} e Parameter for FinishMouseSkew.
 * @param {*} PosC Parameter for FinishMouseSkew.
 * @returns {void} No value.
 */
function FinishMouseSkew(e, PosC) {
  const Canv = $("skewTOverHang2");
  const c2v = $("skewT");
  const ctx = Canv.getContext("2d");

  let PresL = Math.min(pix_to_pres(dStart.y), pix_to_pres(PosC.y));
  let PresU = Math.max(pix_to_pres(dStart.y), pix_to_pres(PosC.y));

  if (PresL != PresU && PresU > PresL) {
    let sfclyr = GetLayerByHght(Snding.Sounding, "SFC")
    Slices = [];

    let Highest = {
      x: Math.max(dStart.x, dEnd.x) / Canv.width,
      y: Math.max(dStart.y, dEnd.y) / Canv.height,
    }

    let Lowest = {
      x: Math.min(dStart.x, dEnd.x) / Canv.width,
      y: Math.min(dStart.y, dEnd.y) / Canv.height,
    }

    let Boundsx = {
      l: -SkewTPosition.x,
      u: -SkewTPosition.x + Canv.width / SkewTScale,
    };

    let Boundsy = {
      l: -SkewTPosition.y,
      u: -SkewTPosition.y + Canv.height / SkewTScale,
    };

    Lowest.x = Boundsx.l + (Boundsx.u - Boundsx.l) * Lowest.x;
    Lowest.y = Boundsy.l + (Boundsy.u - Boundsy.l) * Lowest.y;
    Highest.x = Boundsx.l + (Boundsx.u - Boundsx.l) * Highest.x;
    Highest.y = Boundsy.l + (Boundsy.u - Boundsy.l) * Highest.y;

    PresL = Math.min(pix_to_pres(Highest.y), pix_to_pres(Lowest.y));
    PresU = Math.max(pix_to_pres(Highest.y), pix_to_pres(Lowest.y));

    for (let i = 0; i < Snding.Sounding.Slice.length; i++) {
      let N = ConvertToInfo(Snding.Sounding.Slice[i]);

      if (N.P <= PresU && N.P >= PresL) {
        N.Pos = i;

        let PXT = LevelToSkewNum(N.P);
        let RT = GetSkewRatio(N.T);
        let RD = GetSkewRatio(N.D);

        let PosT = {
          x: (RT + PXT) * Canv.width * SkewTScale,
        }

        let PosD = {
          x: (RD + PXT) * Canv.width * SkewTScale,
        }

        if ((PosT.x <= Highest.x && PosT.x >= Lowest.x)) {
          N.Temp = true;
        } else {
          N.Temp = false;
        }

        if ((PosD.x <= Highest.x && PosD.x >= Lowest.x)) {
          N.Dew = true;
        } else {
          N.Dew = false;
        }

        Slices.push(N);
      }
    }
    DrawSkewT(Snding, false, currentComparisonSoundings);
  } else {
    Slices = [];
  }


  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(dStart.x, dStart.y, dEnd.x - dStart.x, dEnd.y - dStart.y);
}

/** Finishes mouse input on the hodograph.
 * @param {*} e Parameter for FinishMouseHodo.
 * @param {*} PosC Parameter for FinishMouseHodo.
 * @returns {void} No value.
 */
function FinishMouseHodo(e, PosC) {
  const Canv = $("hodographOverHang3");
  const c2v = $("hodograph");
  const ctx = Canv.getContext("2d");

  if (dStart2.x != dEnd2.x && dStart2.y != dEnd2.y) {
    let sfclyr = GetLayerByHght(Snding.Sounding, "SFC")
    Slices = [];

    let Highest = {
      x: Math.max(dStart2.x, dEnd2.x),
      y: Math.max(dStart2.y, dEnd2.y),
    }

    let Lowest = {
      x: Math.min(dStart2.x, dEnd2.x),
      y: Math.min(dStart2.y, dEnd2.y),
    }

    const Center = GetPositionScale(HodographCenter[0], HodographCenter[1], c2v);
    // Change 27 to OutsideFitBase
    const Scale = OutsideFitBase * HodographScaleMulti;

    for (let i = 0; i < Snding.Sounding.Slice.length; i++) {
      let N = ConvertToInfo(Snding.Sounding.Slice[i]);

      let Pos = ConvertPolartoCart(N);

      if (!HodoMode) {
        Pos.x -= CSMot.x;
        Pos.y += CSMot.y;
      }

      if (N.H <= 12000) {
        N.Pos = i;

        let PosM = {
          x: Center.x / 2 + Pos.x * (Scale / 10),
          y: Center.y / 2 + Pos.y * (Scale / 10)
        }

        PosM.x *= 2;
        PosM.y *= 2;

        if ((PosM.x <= Highest.x && PosM.x >= Lowest.x) && (PosM.y <= Highest.y && PosM.y >= Lowest.y)) {
          N.Wind = true;
        } else {
          N.Wind = false;
        }


        Slices.push(N);
      }
    }

  } else {
    Slices = [];
  }

  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(dStart2.x, dStart2.y, dEnd2.x - dStart2.x, dEnd2.y - dStart2.y);
}


/** Handles on window mouse up events.
 * @param {*} e Parameter for onWindowMouseUp.
 * @returns {void} No value.
 */
const onWindowMouseUp = (e) => {
  md = false;
  if (altScrollActive) {
    SkewMouseP = false;
  }

  if (ChangeMod) {
    const Canv = $("skewTOverHang2");
    const Canv2 = $("hodographOverHang3");

    if (!Canv || !Canv2) return;

    const ctx = Canv.getContext("2d");
    ctx.clearRect(0, 0, 1000, 1000);

    const ctx2 = Canv2.getContext("2d");
    ctx2.clearRect(0, 0, 1000, 1000);

    if (activeChange) {
      let PosC = getMousePos(Canv, e);
      dEnd = PosC;

      if (PosC.x >= Canv.width / SkewTScale && PosC.x <= 0 && PosC.y >= Canv.height / SkewTScale && PosC.y <= 0) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(dStart.x, dStart.y, dEnd.x - dStart.x, dEnd.y - dStart.y);

        dEnd2 = { x: 0, y: 0 };
        dStart2 = { x: 0, y: 0 };
      } else {
        FinishMouseSkew(e, PosC);
      }
    }

    if (activeChange2) {
      let PosC2 = getMousePos(Canv2, e);
      dEnd2 = PosC2;

      if (PosC2.x >= Canv2.width / HodographScaleMulti && PosC2.x <= 0 && PosC2.y >= Canv2.height / HodographScaleMulti && PosC2.y <= 0) {
        ctx2.fillStyle = "rgba(255,255,255,0.25)";
        ctx2.fillRect(dStart2.x, dStart2.y, dEnd2.x - dStart2.x, dEnd2.y - dStart2.y);

        dEnd = { x: 0, y: 0 };
        dStart = { x: 0, y: 0 };
      } else {
        FinishMouseHodo(e, PosC2);
      }
    }

    activeChange = false;
    activeChange2 = false;

  }
};

/** Handles mouse down events on the skew-T.
 * @param {*} e Parameter for SkewTMouseDown.
 * @returns {void} No value.
 */
function SkewTMouseDown(e) {
  md = true;
  if (ChangeMod && !activeChange) {
    const Canv = $("skewT");
    const ctx = Canv.getContext("2d");
    // console.log("a");
    activeChange = true;
    activeChange2 = false;
    dEnd = { x: 0, y: 0 };
    dStart = { x: 0, y: 0 };

    let PosC = getMousePos(Canv, e);

    SkewMouseP = PosC;

    dStart = PosC;
  }
}

/** Handles mouse down events on the hodograph.
 * @param {*} e Parameter for HodographMouseDown.
 * @returns {void} No value.
 */
function HodographMouseDown(e) {
  if (ChangeMod && !activeChange) {
    const Canv = $("hodographOverHang3");
    const ctx = Canv.getContext("2d");

    activeChange = false;
    activeChange2 = true;
    dEnd2 = { x: 0, y: 0 };
    dStart2 = { x: 0, y: 0 };

    let PosC = getMousePos(Canv, e);

    dStart2 = PosC;
  }
}

/** Handles front-related events.
 * @param {*} e Parameter for Front.
 * @returns {void} No value.
 */
function Front(e) {
  if (FrontActive) {
    DrawFront(e);
  }
}

/** Changes front state.
 * @returns {void} No value.
 */
function ChangeFront() {
  setFrontActiveState(!FrontActive);

  if (!FrontActive) {
    const hang = $("hodographOverHang2");
    hang?.getContext("2d")?.clearRect(0, 0, 1000, 1000);
  }
}

/** Sets or applies front active state state.
 * @param {*} value Parameter for setFrontActiveState.
 * @returns {void} No value.
 */
function setFrontActiveState(value) {
  FrontActive = value;
}

/** Sets or applies change mod state state.
 * @param {*} value Parameter for setChangeModState.
 * @returns {void} No value.
 */
function setChangeModState(value) {
  ChangeMod = value;
}

/** Returns mouse pos data.
 * @param {*} canvas Parameter for getMousePos.
 * @param {*} evt Parameter for getMousePos.
 * @returns {*} Result of the function.
 */
function getMousePos(canvas, evt) {
  var rect = canvas.getBoundingClientRect(),
    scaleX = canvas.width / rect.width,
    scaleY = canvas.height / rect.height;

  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY
  }
}

let CursorActive = true;
let ReadOutOn = true;

/** Converts cart to polar regular values.
 * @param {*} V1 Parameter for ConvertCartToPolar_Regular.
 * @returns {*} Result of the function.
 */
function ConvertCartToPolar_Regular(V1){
  const dy = V1.y - 0;
  const dx = V1.x - 0;
  const radians = Math.atan2(dy, dx); // Angle in radians
  const degrees = radians * 180 / Math.PI; // Convert to degrees
  return { WD: degrees%360, WS: Mag(V1) };
}

/** Converts cart to polar real values.
 * @param {*} V1 Parameter for ConvertCartToPolarReal.
 * @returns {*} Result of the function.
 */
function ConvertCartToPolarReal(V1) {
  const dy = V1.y - 0;
  const dx = V1.x - 0;
  const radians = Math.atan2(dy, dx); // Angle in radians
  const degrees = radians * 180 / Math.PI; // Convert to degrees
  return { WD: (degrees + 270) % 360, WS: Mag(V1) };
}

/** Converts cart to polar real rnd values.
 * @param {*} V1 Parameter for ConvertCartToPolarRealRnd.
 * @returns {*} Result of the function.
 */
function ConvertCartToPolarRealRnd(V1) {
  const dy = V1.y - 0;
  const dx = V1.x - 0;
  const radians = Math.atan2(dy, dx); // Angle in radians
  const degrees = radians * 180 / Math.PI; // Convert to degrees
  return { WD: Math.round((degrees + 270) % 360), WS: Math.round(Mag(V1)) };
}

let LastMousePosF;

/** Draws front content.
 * @param {*} e Parameter for DrawFront.
 * @param {*} just Parameter for DrawFront.
 * @returns {void} No value.
 */
function DrawFront(e, just = false) {
  if (!FrontActive) {
    return;
  }

  const Canv = $("hodographOverHang2");
  const ctx = Canv.getContext("2d");

  Canv.width = 800;
  Canv.height = 800;

  ctx.scale(2, 2);

  let PosC = getMousePos(Canv, e);

  if ((PosC.x <= Canv.width && PosC.x > 0 && PosC.y <= Canv.height && PosC.y > 0 || just == true) && !VWPActive) {
    let Center = GetPositionScale(HodographCenter[0], HodographCenter[1], Canv);

    if (!HodoMode){
      Center = GetPositionScale(50, 50, Canv);
    }

    let Scale = OutsideFitBase * HodographScaleMulti;

    let TX = -Center.x / (Scale / 10) + (PosC.x) / (Scale / 10);
    let TY = -Center.y / (Scale / 10) + (PosC.y ) / (Scale / 10);

    if (!HodoMode) {
      TX = -Center.x / (Scale / 10) + (PosC.y - CSMot.x ) / (Scale / 10);
      TY = -Center.y / (Scale / 10) + (PosC.y + CSMot.y ) / (Scale / 10);
    }


    let Loc = just == true && LastMousePosF || ConvertCartToPolarReal({
      x: TX/2,
      y: TY/2
    });

    LastMousePosF = Loc;

    let TPos = ConvertPolartoCart(Loc);

    let AngleToCenter = ConvertCartToPolarReal({
      x: TX,
      y: TY,
    });

    ctx.fillStyle = "rgba(255,125,75,0.5)";
    ctx.save();
    ctx.translate(Center.x / 2 + TPos.x * (Scale / 10), Center.y / 2 + TPos.y * (Scale / 10));
    ctx.rotate(degtoRad(Loc.WD));
    ctx.fillRect(-500, 0, 1000, 3);

    ctx.restore();
    ctx.fillStyle = "rgba(255,125,75,1)";
    ctx.fillText(`${Math.round(Loc.WD)}°`, Center.x / 2 + TPos.x * (Scale / 10), Center.y / 2 + TPos.y * (Scale / 10) - 20);
    ctx.fillText(`@ ${Math.round(Loc.WS)}Kts`, Center.x / 2 + TPos.x * (Scale / 10), Center.y / 2 + TPos.y * (Scale / 10) - 10);
  }

  ctx.restore();
}

var LastMousePos;
var LastPres;

/** Handles cursor readout functionality.
 * @param {*} e Parameter for CursorReadout.
 * @param {*} just Parameter for CursorReadout.
 * @param {*} n Parameter for CursorReadout.
 * @returns {void} No value.
 */
function CursorReadout(e, just = false, n = false) {
  const Canv = $("skewTOverHang");
  const cr = $("skewT");
  if (!Canv || !cr) return;
  const ctx = Canv.getContext("2d");

  const Canv2 = $("hodographOverHang");
  const ctx2 = Canv2?.getContext("2d");
  ctx.width = 800;//Canv.style.width;
  ctx.height = 800;

  if (ReadOutOn == true && CursorActive == true || just == true) {

    if (just == true && ReadOutOn == false) {
      return;
    }

    // Blank / pre-BUFKIT skew-T has no sounding yet — skip readout.
    if (!Snding?.Sounding?.P?.length || !Snding?.End) {
      return;
    }

    let PosC = just == true && LastMousePos || getMousePos(cr, e);
    let Bounds = {
      l: -SkewTPosition.y,
      u: -SkewTPosition.y + Canv.height / SkewTScale,
    };

    LastMousePos = PosC;

    if (PosC.x <= Canv.width && PosC.x > 0 && PosC.y <= Canv.height && PosC.y > 0 && !VWPActive) {
      if (!ctx2) return;
      Canv2.width = 800;
      Canv2.height = 800;

      ctx2.scale(2, 2);
      ctx.clearRect(0, 0, Canv.width, Canv.height);
      ctx2.clearRect(0, 0, Canv2.width, Canv2.height);

      let yy = just == true && LastMousePos.y / cr.height || getMousePos(cr, e).y / cr.height;

      yy = Bounds.l + (Bounds.u - Bounds.l) * yy;

      let Pres = n == true && LastPres || pix_to_pres(yy);
      LastPres = Pres;
      let Prs = Math.max(Snding.End.P, Pres) > Snding.Sounding.P[0] ? Snding.Sounding.P[0] : Math.max(Snding.End.P, Pres);
      let Lyr = GetLayerByPres(Snding.Sounding, Prs);

      if (Lyr == undefined) {
        Lyr = { VT: "--", T: "--", D: "--", WB: "--", H: undefined, WD: undefined, WS: undefined }
      }

      PosC.y = n == true && Lerp(0, Canv.height, (pres_to_pix(LastPres) - Bounds.l) / (Bounds.u - Bounds.l)) || PosC.y;
      ctx.fillStyle = "rgba(255,255,255,1)";

      ctx.fillRect(0, PosC.y, Canv.width, 2);
      ctx.textAlign = "right";
      ctx.font = `bold ${Canv.width / 30}px ${globalFont}`;

      const heightLabel = Lyr.H === undefined ? "--" : Math.round(useImperialUnits === 2 ? MToFt(Lyr.H) : Lyr.H);
      const heightUnit = useImperialUnits === 2 ? "ft" : "m";

      let TE = (Lyr.T === "--" || Lyr.D === "--") ? "--" : Math.round(thetae(Lyr.P, Lyr.T, Lyr.D) + 273.15);

      ctx.fillText(`${Math.round(Pres)}mb`, PosC.x + 25, PosC.y - 5);
      ctx.fillText(`${heightLabel}${heightUnit}`, PosC.x + 25, PosC.y - 35);
      ctx.fillText(`${TE}K`, PosC.x + 25, PosC.y - 65);
      let PrcT = "--";
      if (DP){
        try {
          PrcT = DP.Path[clamp(Math.round(DP.Start.P - Lyr.P), 0, Math.round(DP.Path.length))]
        } catch (e) {
          PrcT = "--";
        }
      }

      ctx.textAlign = "right";
      const shouldShowFahrenheit = useImperialUnits === 2;
      const tempUnit = shouldShowFahrenheit ? "F" : "C";
      let VT = Lyr.VT === "--" || Lyr.VT === undefined ? "--" : Math.round(10 * (useImperialUnits === 2 ? CToF(Lyr.VT) : Lyr.VT)) / 10;
      let T = Lyr.T === "--" || Lyr.T === undefined ? "--" : Math.round(10 * (useImperialUnits === 2 ? CToF(Lyr.T) : Lyr.T)) / 10;
      let ParT = PrcT === "--" ? "--" : Math.round(10 * (useImperialUnits === 2 ? CToF(PrcT) : PrcT)) / 10;
      let D = Lyr.D === "--" || Lyr.D === undefined ? "--" : Math.round(10 * (useImperialUnits === 2 ? CToF(Lyr.D) : Lyr.D)) / 10;
      let WB = Lyr.WB === "--" || Lyr.WB === undefined ? "--" : Math.round(10 * (useImperialUnits === 2 ? CToF(Lyr.WB) : Lyr.WB)) / 10;
      // --- ADDED: Calculate Relative Humidity ---
      let RH = (Lyr.T === "--" || Lyr.D === "--") ? "--" : Math.round(RelHum(Lyr.T, Lyr.D));
      let Omg = (Lyr.OM === "--" || isNaN(Lyr.OM)) ? "--" : Math.round(Lyr.OM * 10000)/100;
      Omg = Omg == null ? "--" : Omg;
      let LR = Math.round(100 * LapseRatePres(Snding.Sounding, Prs, Prs - 1, false, 100)) / 100;
      LR = LR == null ? "--" : LR;

      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = 2;

      let LocOfText = [
        ['Temp:', -200, -65, `${T}°${tempUnit}`, -100],
        ['Dew:', -200, -45, `${D}°${tempUnit}`, -100],
        ['Wet Bulb:', -200, -25, `${WB}°${tempUnit}`, -100],
        ['RH:', -200, -5, `${RH}%`, -100],
        ['Virt Temp:', -400, -5, `${VT}°${tempUnit}`, -300],
        ['Parcel Temp:', -400, -25, `${ParT}°${tempUnit}`, -300],
        ['Omega:', -400, -45, `${Omg} ub/s`, -300],
        ['Lapse Rate:', -400, -65, `${LR}°C/Km`, -300],
      ]

      LocOfText.forEach((ps) => {
        ctx.textAlign = "right";
        ctx.font = `600 ${Canv.width / 45}px ${globalFont}`;
        ctx.strokeText(ps[0], PosC.x + ps[1], PosC.y + ps[2]);
        ctx.fillText(ps[0], PosC.x + ps[1], PosC.y + ps[2]);

        ctx.textAlign = "right";
        ctx.font = `${Canv.width / 45}px ${globalFont}`;
        ctx.strokeText(ps[3], PosC.x + ps[4], PosC.y + ps[2]);
        ctx.fillText(ps[3], PosC.x + ps[4], PosC.y + ps[2]);
      });

      let Center = GetPositionScale(HodographCenter[0], HodographCenter[1], Canv);

      if (!HodoMode) {
        Center = GetPositionScale(50, 50, Canv);
      }

      // Change 27 to OutsideFitBase to match the auto-scaling logic
      let Scale = OutsideFitBase * HodographScaleMulti;
      let Loc = ConvertPolartoCart(Lyr);

      if (!HodoMode) {
        Loc.x -= CSMot.x;
        Loc.y += CSMot.y;
      }

      const speedLabel = Lyr.WS === undefined ? "--" : Math.round(useImperialUnits === 2 ? KtsToMph(Lyr.WS) : Lyr.WS);
      const speedUnit = useImperialUnits === 2 ? "mph" : "kts";
      const hodoHeightLabel = Lyr.H === undefined ? "--" : Math.round(useImperialUnits === 2 ? MToFt(Lyr.H) : Lyr.H);

      ctx2.strokeStyle = "rgba(255,255,255,0.6)";
      ctx2.fillStyle = "rgba(255,255,255,1)";
      ctx2.font = `bold ${Canv.width / 80}px ${globalFont}`;
      ctx2.lineWidth = 8;
      ctx2.beginPath();
      ctx2.arc(Center.x / 2 - 1.5 + Loc.x * (Scale / 10), Center.y / 2 - 1.5 + Loc.y * (Scale / 10), 3, 0, 2 * Math.PI);
      ctx2.stroke();

      LocOfText = [
        [`${Math.round(Lyr.WD)}°`, -10, -10, 'right'],
        [`${speedLabel}${speedUnit}`, -10, 0, 'right'],
        [`${hodoHeightLabel}${heightUnit} AGL`, 10, -10, 'left'],
        [`${Math.round(Pres)}mb`, 10, 0, 'left'],
      ]

      ctx2.font = `bold ${Canv.width / 75}px ${globalFont}`;
      ctx2.strokeStyle = "rgba(0,0,0,1)";
      ctx2.lineWidth = 2;
      LocOfText.forEach((ps) => {
        ctx2.textAlign = ps[3];
        ctx2.strokeText(ps[0], Center.x / 2 + Loc.x * (Scale / 10) + ps[1], Center.y / 2 + Loc.y * (Scale / 10) + ps[2]);
        ctx2.fillText(ps[0], Center.x / 2 + Loc.x * (Scale / 10) + ps[1], Center.y / 2 + Loc.y * (Scale / 10) + ps[2]);
      })
      ctx2.strokeStyle = "rgba(255,255,255,0.6)";
    }
  } else if (!ReadOutOn) {
    ctx.clearRect(0, 0, Canv.width, Canv.height);
    ctx2.clearRect(0, 0, Canv2.width, Canv2.height);
  }
}

/** Changes read out state.
 * @returns {*} Result of the function.
 */
function ChangeReadOut() {
  CursorActive = true;
  setReadOutOnState(!ReadOutOn);

  if (ReadOutOn == true) {
    setChangeModState(false);
  } else {
    CursorReadout(false);
  }

  return ReadOutOn;
}

/** Sets or applies read out on state state.
 * @param {*} value Parameter for setReadOutOnState.
 * @returns {void} No value.
 */
function setReadOutOnState(value) {
    ReadOutOn = value;
}

let ghost = false;


// Helper function to create a smooth gradient color based on LapseRate
/** Returns lrgradient color data.
 * @param {*} lr Parameter for getLRGradientColor.
 * @returns {*} Result of the function.
 */
function getLRGradientColor(lr) {
  // Define color stops: [percent, [r, g, b]]
  const colorStops = [
    [0, [255, 255, 255]],   // White at 0C/km
    [49.9, [75, 75, 75]],  // Grey at 4.99C/km
    [50, [75, 75, 200]],  // Cobalt at 5C/km
    [59.9, [30, 30, 150]],    // Navy at 5.99C/km
    [60, [255, 255, 0]],    // Yellow at 6C/km
    [69.9, [130, 130, 0]],    // Dark Yellow at 6.99C/km
    [70, [255, 125, 0]],    // Orange at 7C/km
    [79.9, [125, 50, 0]],    // Dark Orange at 7.99C/km
    [80, [255, 0, 0]],    // Red at 8C/km
    [89.9, [125, 0, 0]],    // Dark Red at 8.99C/km
    [90, [200, 0, 200]],    // Pink at 9C/km
    [100, [255, 255, 255]] // White at 10C/km
  ];

  const tlr = lr * 10;

  // Find the two stops the current LR value is between
  let lowerStop = colorStops[0];
  let upperStop = colorStops[colorStops.length - 1];
  for (let i = 0; i < colorStops.length - 1; i++) {
    if (tlr >= colorStops[i][0] && tlr <= colorStops[i + 1][0]) {
      lowerStop = colorStops[i];
      upperStop = colorStops[i + 1];
      break;
    }
  }

  // Calculate the position (factor) between the two stops
  const range = upperStop[0] - lowerStop[0];
  const factor = range === 0 ? 0 : (tlr - lowerStop[0]) / range;

  // Linearly interpolate the R, G, and B values
  const r = Math.round(lowerStop[1][0] + factor * (upperStop[1][0] - lowerStop[1][0]));
  const g = Math.round(lowerStop[1][1] + factor * (upperStop[1][1] - lowerStop[1][1]));
  const b = Math.round(lowerStop[1][2] + factor * (upperStop[1][2] - lowerStop[1][2]));

  return `rgba(${r}, ${g}, ${b}, 0.8)`;
}

//
/** Returns temp adv gradient color data.
 * @param {*} tadv Parameter for getTempAdvGradientColor.
 * @returns {*} Result of the function.
 */
function getTempAdvGradientColor(tadv) {
  // Define color stops: [percent, [r, g, b]]
  const colorStops = [
    [-40, [255, 255, 255]],
    [-20, [0, 255, 255]],
    [-15, [0, 125, 125]],
    [-10, [0, 0, 125]],
    [-5, [0, 0, 255]],
    [-1, [125, 125, 255]],
    [0, [125, 125, 125]],   
    [1, [200, 100, 100]],  
    [5, [255, 0, 0]],  
    [10, [125, 0, 0]],  
    [15, [125, 0, 125]],  
    [20, [255, 0, 255]],  
    [40, [255, 255, 255]], 
  ];

  // Find the two stops the current RH value is between
  let lowerStop = colorStops[0];
  let upperStop = colorStops[colorStops.length - 1];
  for (let i = 0; i < colorStops.length - 1; i++) {
    if (tadv >= colorStops[i][0] && tadv <= colorStops[i + 1][0]) {
      lowerStop = colorStops[i];
      upperStop = colorStops[i + 1];
      break;
    }
  }

  // Calculate the position (factor) between the two stops
  const range = upperStop[0] - lowerStop[0];
  const factor = range === 0 ? 0 : (tadv - lowerStop[0]) / range;

  // Linearly interpolate the R, G, and B values
  const r = Math.round(lowerStop[1][0] + factor * (upperStop[1][0] - lowerStop[1][0]));
  const g = Math.round(lowerStop[1][1] + factor * (upperStop[1][1] - lowerStop[1][1]));
  const b = Math.round(lowerStop[1][2] + factor * (upperStop[1][2] - lowerStop[1][2]));

  return `rgba(${r}, ${g}, ${b}, 0.8)`;
}

// Helper function to create a smooth gradient color based on Relative Humidity
/** Returns rhgradient color data.
 * @param {*} rh Parameter for getRHGradientColor.
 * @returns {*} Result of the function.
 */
function getRHGradientColor(rh) {
  // Define color stops: [percent, [r, g, b]]
  const colorStops = [
    [0, [139, 69, 19]],   // Brown at 0%
    [25, [255, 165, 0]],  // Orange at 25%
    [50, [255, 255, 0]],  // Yellow at 50%
    [75, [0, 200, 0]],    // Green at 75%
    [100, [30, 144, 255]] // Blue at 100%
  ];

  // Find the two stops the current RH value is between
  let lowerStop = colorStops[0];
  let upperStop = colorStops[colorStops.length - 1];
  for (let i = 0; i < colorStops.length - 1; i++) {
    if (rh >= colorStops[i][0] && rh <= colorStops[i + 1][0]) {
      lowerStop = colorStops[i];
      upperStop = colorStops[i + 1];
      break;
    }
  }

  // Calculate the position (factor) between the two stops
  const range = upperStop[0] - lowerStop[0];
  const factor = range === 0 ? 0 : (rh - lowerStop[0]) / range;

  // Linearly interpolate the R, G, and B values
  const r = Math.round(lowerStop[1][0] + factor * (upperStop[1][0] - lowerStop[1][0]));
  const g = Math.round(lowerStop[1][1] + factor * (upperStop[1][1] - lowerStop[1][1]));
  const b = Math.round(lowerStop[1][2] + factor * (upperStop[1][2] - lowerStop[1][2]));

  return `rgba(${r}, ${g}, ${b}, 0.8)`;
}

/** Returns wsgradient color data.
 * @param {*} ws Parameter for getWSGradientColor.
 * @returns {*} Result of the function.
 */
function getWSGradientColor(ws) {
  // Define color stops: [speed_kts, [r, g, b]]
  const colorStops = [
    [0, [100, 100, 255]],
    [10, [0, 125, 255]],
    [20, [0, 255, 0]],
    [30, [255, 255, 0]],
    [40, [255, 125, 0]],
    [50, [255, 0, 0]],
    [60, [255, 0, 125]],
    [70, [255, 0, 255]],
    [80, [125, 0, 255]],
    [90, [0, 0, 255]],
    [100, [125, 125, 125]],
    [125, [255, 255, 255]],
    [150, [150, 200, 255]],
  ];
  /*const colorStops = [
    [0, [0, 100, 200]],     // Light Blue
    [20, [0, 200, 150]],    // Cyan/Green
    [40, [0, 255, 0]],      // Bright Green
    [60, [255, 255, 0]],    // Yellow
    [80, [255, 128, 0]],    // Orange
    [100, [255, 0, 0]],     // Red
    [125, [255, 0, 255]],   // Magenta
    [150, [150, 0, 255]]    // Purple
  ];*/

  // Find the two stops the current WS value is between
  let lowerStop = colorStops[0];
  let upperStop = colorStops[colorStops.length - 1];
  for (let i = 0; i < colorStops.length - 1; i++) {
    if (ws >= colorStops[i][0] && ws <= colorStops[i + 1][0]) {
      lowerStop = colorStops[i];
      upperStop = colorStops[i + 1];
      break;
    }
  }
  // Handle values above the max range by clamping to the last color
  if (ws > upperStop[0]) {
    return `rgba(${upperStop[1][0]}, ${upperStop[1][1]}, ${upperStop[1][2]}, 0.5)`;
  }

  const range = upperStop[0] - lowerStop[0];
  const factor = range === 0 ? 0 : (ws - lowerStop[0]) / range;

  // Linearly interpolate the R, G, and B values
  const r = Math.round(lowerStop[1][0] + factor * (upperStop[1][0] - lowerStop[1][0]));
  const g = Math.round(lowerStop[1][1] + factor * (upperStop[1][1] - lowerStop[1][1]));
  const b = Math.round(lowerStop[1][2] + factor * (upperStop[1][2] - lowerStop[1][2]));

  return `rgba(${r}, ${g}, ${b}, 0.5)`;
}

/** Infers temperature advection from sounding temperature and wind profiles.
 * @param {*} Sound Parameter for inferred_temp_adv.
 * @param {*} dp Parameter for inferred_temp_adv.
 * @param {*} lat Parameter for inferred_temp_adv.
 * @returns {*} Result of the function.
 */
function inferred_temp_adv(Sound, dp=-50, lat=35){
  const Snd = Sound.Sounding;
  const OMEGA = (2.0 * Math.PI) / 86164.0;

  // QC checks
  if (!Snd.W || Snd.W.every(v => v.WD === null || isNaN(v.WD))) {
    return { temp_adv: null, pressure_bounds: null };
  }
  //if (Math.max(...Snd.P.filter(p => !isNaN(p))) <= 50) {
  //  return { temp_adv: null, pressure_bounds: null };
  //}

  // Get surface index
  const sfc_idx = GetLayerByPres(Snd, "SFC");
  const sfc_pres = sfc_idx.P;

  // Filter pressures >= 100
  const valid_pres = Snd.P.filter(p => p >= 100);
  const top_pres_val = valid_pres[valid_pres.length - 1];

  // Build pressure array from sfc down to top, stepping by dp
  const pressures = [];
  for (let p = sfc_pres; p > top_pres_val; p += dp) {
    pressures.push(GetLayerByPres(Snd, p));
  }

  if (pressures.length < 2) {
    return { temp_adv: null, pressure_bounds: null };
  }

  // Interpolate temps (C->K), heights, and wind directions at each pressure
  const temps = pressures.map(p => CtoK(p.T));
  const heights = pressures.map(p => p.H);
  const dirs = pressures.map(p => p.WD);

  const n = pressures.length - 1;
  const temp_adv = new Array(n);
  const pressure_bounds = new Array(n).fill(null).map(() => [0, 0]);

  // Check latitude QC
  if (lat === null || isNaN(lat)) {
    temp_adv.fill(NaN);
    return { temp_adv, pressure_bounds };
  }

  const f = 2.0 * OMEGA * Math.sin(lat * Math.PI / 180.0);
  const multiplier = (f / 9.81) * (Math.PI / 180.0);

  for (let i = 1; i < pressures.length; i++) {
    const bottom_pres = pressures[i - 1];
    const top_pres = pressures[i];

    const btemp = temps[i - 1];
    const ttemp = temps[i];

    const bhght = heights[i - 1];
    const thght = heights[i];

    let bottom_wdir = dirs[i - 1];
    let top_wdir = dirs[i];

    const avg_temp = (ttemp + btemp) * 2.0;

    // Mean wind between layers
    const meanW = MeanWind(Snd, bottom_pres.P, top_pres.P, 1);
    let Cart = ConvertCartToPolarReal(meanW);

    // Change in wind direction with height
    const mod = 180 - bottom_wdir;
    top_wdir = top_wdir + mod;
    if (top_wdir < 0) {
      top_wdir += 360;
    } else if (top_wdir >= 360) {
      top_wdir -= 360;
    }
    const d_theta = top_wdir - 180.0;

    // Temperature advection (K/s -> K/hr)
    const dz = thght - bhght;
    const t_adv = multiplier * Math.pow(Cart.WS, 2) * avg_temp * (d_theta / dz);

    pressure_bounds[i - 1] = [bottom_pres.P, top_pres.P];
    temp_adv[i - 1] = t_adv * 3600.0;
  }

  return { temp_adv, pressure_bounds };
}

/** Draws vertical bars content.
 * @param {*} Sounding Parameter for drawVerticalBars.
 * @param {*} comparisonSoundings Parameter for drawVerticalBars.
 * @param {*} fromVwpRedraw Parameter for drawVerticalBars.
 * @returns {void} No value.
 */
function drawVerticalBars(Sounding, comparisonSoundings = [], fromVwpRedraw = false) {
  const Canv = $("verticalBar");
  if (!Canv) return;
  const ctx = Canv.getContext("2d");
  /** Returns the gradient stop for a given y-coordinate.
   * @param {*} y Parameter for gradStop.
   * @returns {*} Result of the function.
   */
  const gradStop = (y) => clamp(y / 800, 0, 1);
  var TAdVMax;
  var TAdVMax2;

  var SSlice = GetLayerByHght(Sounding.Sounding, "SFC");
  var ESlice = GetLayerByPres(Sounding.Sounding, "Last");

  // Increase canvas width for three wider plots (150px each)
  Canv.width = 400;
  Canv.height = 800;

  ctx.clearRect(0, 0, Canv.width, Canv.height);
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 0, Canv.width, Canv.height);
  ctx.save();
  ctx.scale(1, SkewTScale);
  ctx.translate(0, SkewTPosition.y);

  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 100, 800);   // Wind Speed
  ctx.strokeRect(100, 0, 150, 800); // RH
  ctx.strokeRect(250, 0, 150, 800); // LR

  const soundData = Sounding.Sounding.Slice;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  var lowestPN, highestPN;

  // --- 1. WIND SPEED PLOT [X: 0-150] ---
  const maxWindSpeed = 150;
  const linGradWS = ctx.createLinearGradient(0, 0, 0, 800);
  lowestPN = 0; highestPN = 0;

  ctx.beginPath();
  for (let i = 0; i < soundData.length; i++) {
    const slice = soundData[i];
    const p = slice[0], ws = slice[5];
    if (ws === -9999 || isNaN(ws)) continue;
    const y = pres_to_pix(p);
    if (lowestPN === 0) { lowestPN = y; ctx.moveTo(0, y); }
    highestPN = y;
    if (y < 0) {
      linGradWS.addColorStop(0, getWSGradientColor(ws));
      ctx.lineTo((ws / maxWindSpeed) * 100, 0);
      break;
    }
    linGradWS.addColorStop(gradStop(y), getWSGradientColor(ws));
    ctx.lineTo((ws / maxWindSpeed) * 100, y);
  }
  ctx.lineTo(0, highestPN);
  ctx.closePath();
  ctx.fillStyle = linGradWS;
  ctx.fill();

  ctx.beginPath();
  let firstWSPoint = true;
  for (let i = 0; i < soundData.length; i++) {
    const slice = soundData[i];
    const p = slice[0], ws = slice[5];
    if (ws === -9999 || isNaN(ws)) { firstWSPoint = true; continue; }
    const y = pres_to_pix(p);
    const x = (ws / maxWindSpeed) * 100;
    if (firstWSPoint) { ctx.moveTo(x, y); firstWSPoint = false; }
    else { ctx.lineTo(x, y); }
  }
  ctx.stroke();

  // ctx.fillStyle = "rgba(255,255,255,1)";
  // ctx.font = "bold 30px Arial"; // Increased font size
  // ctx.textAlign = "center";
  // ctx.fillText("Wind Spd", 75, 25);

  // --- 2. Inferred Temp Adv PLOT [X: 150-300] ---
  if (Presets['Vertical'] != "Default"){
    const linGradRH = ctx.createLinearGradient(0, 0, 0, 800);
    lowestPN = 0; highestPN = 0;

    ctx.beginPath();
    for (let i = 0; i < soundData.length; i++) {
      const slice = soundData[i];
      const p = slice[0], t = slice[2], d = slice[3];
      if (t === -9999 || d === -9999) continue;
      const rh = RelHum(t, d);
      if (isNaN(rh) || rh < 0) continue;
      const y = pres_to_pix(p);
      if (lowestPN === 0) { lowestPN = y; ctx.moveTo(100, y); }
      highestPN = y;
      if (y < 0) {
        linGradRH.addColorStop(0, getRHGradientColor(rh));
        ctx.lineTo(100 + (rh / 100) * 150, 0);
        break;
      }
      linGradRH.addColorStop(gradStop(y), getRHGradientColor(rh));
      ctx.lineTo(100 + (rh / 100) * 150, y);
    }
    ctx.lineTo(100, highestPN);
    ctx.closePath();
    ctx.fillStyle = linGradRH;
    ctx.fill();

    ctx.beginPath();
    let firstRHPoint = true;
    for (let i = 0; i < soundData.length; i++) {
      const slice = soundData[i];
      const p = slice[0], t = slice[2], d = slice[3];
      if (t === -9999 || d === -9999) { firstRHPoint = true; continue; }
      const rh = RelHum(t, d);
      if (isNaN(rh)) { firstRHPoint = true; continue; }
      const y = pres_to_pix(p);
      const x = 100 + (rh / 100) * 150;
      if (firstRHPoint) { ctx.moveTo(x, y); firstRHPoint = false; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  } else {
    var LATD;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.strokeRect(175, 0, 1, 800); // RH
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    //TEMP ADV
    if (Sounding.Location2 == null){
      LATD = 35;
    } else {
      LATD = Sounding.Location2[0];
    }
    const linGradTA = ctx.createLinearGradient(0, 0, 0, 800);
    lowestPN = 0; highestPN = 0;

    const TAdv = fromVwpRedraw ? { temp_adv: null, pressure_bounds: null } : inferred_temp_adv(Sounding, -50, LATD);

    if (TAdv && Array.isArray(TAdv.temp_adv) && Array.isArray(TAdv.pressure_bounds)) {
      if (TAdv.temp_adv.every(Number.isNaN)){
        TAdv.temp_adv.fill(0);

        for (let i = 0; i < TAdv.pressure_bounds.length; i++){
          TAdv.pressure_bounds[i] = [SSlice.P - 50*i, SSlice.P - ((i+1)*50)]
        }
      }

      TAdVMax = Math.round(clamp(1 + Math.max(...TAdv.temp_adv.map(absoluteValue)), 10, 20));
      TAdVMax2 = TAdVMax*2;

      ctx.beginPath();
      for (let i = 0; i < TAdv.pressure_bounds.length; i++){
        const PresLvl = TAdv.pressure_bounds[i][0];
        const TAd = TAdv.temp_adv[i];
        if (TAd === null || PresLvl === null) continue;
        const y = pres_to_pix(PresLvl);
        const y2 = pres_to_pix(TAdv.pressure_bounds[i][1]);
        if (lowestPN === 0) { lowestPN = y; ctx.moveTo(175, y); }
        highestPN = y2;
        if (y < 0) {
          linGradTA.addColorStop(0, getTempAdvGradientColor(TAd));
          linGradTA.addColorStop(gradStop(y2 - 1), getTempAdvGradientColor(TAd));
          ctx.moveTo(175 + ((clamp(TAd, -TAdVMax, TAdVMax)) / TAdVMax2) * 150, 0);
          ctx.lineTo(175 + ((clamp(TAd, -TAdVMax, TAdVMax)) / TAdVMax2) * 150, y2);
          break;
        }
        linGradTA.addColorStop(gradStop(y - 1), getTempAdvGradientColor(TAd));
        linGradTA.addColorStop(gradStop(y2), getTempAdvGradientColor(TAd));
        ctx.lineTo(175 + ((clamp(TAd, -TAdVMax, TAdVMax)) / TAdVMax2) * 150, y);
        ctx.lineTo(175 + ((clamp(TAd, -TAdVMax, TAdVMax)) / TAdVMax2) * 150, y2);
      }
      ctx.lineTo(175, highestPN);
      ctx.closePath();
      ctx.fillStyle = linGradTA;
      ctx.fill();

      ctx.beginPath();
      let firstRHPoint = true;
      for (let i = 0; i < TAdv.pressure_bounds.length; i++){
        const PresLvl = TAdv.pressure_bounds[i][0];
        const TAd = TAdv.temp_adv[i];
        if (PresLvl === null || TAd === null) { firstRHPoint = true; continue; }
        if (isNaN(TAd)) { firstRHPoint = true; continue; }
        const y = pres_to_pix(PresLvl);
        const y2 = pres_to_pix(TAdv.pressure_bounds[i][1])
        const x = 175 + ((clamp(TAd, -TAdVMax, TAdVMax)) / TAdVMax2) * 150;
        if (firstRHPoint) { ctx.moveTo(x, y); ctx.lineTo(x, y2); firstRHPoint = false; }
        else { ctx.lineTo(x, y); ctx.lineTo(x, y2); }
      }
      ctx.stroke();
    }
  }

  if (Presets['Vertical'] === "Winter") {
    var TAdVMaxW;
    var TAdVMax2W;
    var LATDW;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.strokeRect(325, 0, 1, 800);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,1)";

    if (Sounding.Location2 == null) {
      LATDW = 35;
    } else {
      LATDW = Sounding.Location2[0];
    }

    const linGradTAW = ctx.createLinearGradient(0, 0, 0, 800);
    lowestPN = 0; highestPN = 0;

    const TAdvW = fromVwpRedraw ? { temp_adv: null, pressure_bounds: null } : inferred_temp_adv(Sounding, -50, LATDW);
    if (TAdvW && Array.isArray(TAdvW.temp_adv) && Array.isArray(TAdvW.pressure_bounds)) {
      TAdVMaxW = Math.round(clamp(1 + Math.max(...TAdvW.temp_adv.map(absoluteValue)), 10, 20));
      TAdVMax2W = TAdVMaxW * 2;

      ctx.beginPath();
      for (let i = 0; i < TAdvW.pressure_bounds.length; i++) {
        const PresLvl = TAdvW.pressure_bounds[i][0];
        const TAd = TAdvW.temp_adv[i];
        if (TAd === null || PresLvl === null) continue;
        const y = pres_to_pix(PresLvl);
        const y2 = pres_to_pix(TAdvW.pressure_bounds[i][1]);
        if (lowestPN === 0) { lowestPN = y; ctx.moveTo(325, y); }
        highestPN = y2;
        if (y < 0) {
          linGradTAW.addColorStop(0, getTempAdvGradientColor(TAd));
          linGradTAW.addColorStop(gradStop(y2 - 1), getTempAdvGradientColor(TAd));
          ctx.moveTo(325 + ((clamp(TAd, -TAdVMaxW, TAdVMaxW)) / TAdVMax2W) * 150, 0);
          ctx.lineTo(325 + ((clamp(TAd, -TAdVMaxW, TAdVMaxW)) / TAdVMax2W) * 150, y2);
          break;
        }
        linGradTAW.addColorStop(gradStop(y - 1), getTempAdvGradientColor(TAd));
        linGradTAW.addColorStop(gradStop(y2), getTempAdvGradientColor(TAd));
        ctx.lineTo(325 + ((clamp(TAd, -TAdVMaxW, TAdVMaxW)) / TAdVMax2W) * 150, y);
        ctx.lineTo(325 + ((clamp(TAd, -TAdVMaxW, TAdVMaxW)) / TAdVMax2W) * 150, y2);
      }
      ctx.lineTo(325, highestPN);
      ctx.closePath();
      ctx.fillStyle = linGradTAW;
      ctx.fill();

      ctx.beginPath();
      let firstTAWPoint = true;
      for (let i = 0; i < TAdvW.pressure_bounds.length; i++) {
        const PresLvl = TAdvW.pressure_bounds[i][0];
        const TAd = TAdvW.temp_adv[i];
        if (PresLvl === null || TAd === null || isNaN(TAd)) { firstTAWPoint = true; continue; }
        const y = pres_to_pix(PresLvl);
        const y2 = pres_to_pix(TAdvW.pressure_bounds[i][1]);
        const x = 325 + ((clamp(TAd, -TAdVMaxW, TAdVMaxW)) / TAdVMax2W) * 150;
        if (firstTAWPoint) { ctx.moveTo(x, y); ctx.lineTo(x, y2); firstTAWPoint = false; }
        else { ctx.lineTo(x, y); ctx.lineTo(x, y2); }
      }
      ctx.stroke();

      // store for footer labels
      var _winterTAdVMax = TAdVMaxW;
    }
  } else {
    const linGradLR = ctx.createLinearGradient(0, 0, 0, 800);
    lowestPN = 0; highestPN = 0;

    ctx.beginPath();
    for (let i = SSlice.H; i < (ESlice.H - 1000); i += 250) {
      const slice = GetLayerByHght(Sounding.Sounding, i);
      const NS = GetLayerByHght(Sounding.Sounding, i + 1000);
      if (!slice || !NS || slice.VT === -9999 || NS.VT == -9999) continue;
      const lr = clamp(slice.VT - NS.VT, 0, 10);
      if (isNaN(lr) || lr < 0) continue;
      const y_start = pres_to_pix(slice.P);
      if (lowestPN == 0) { lowestPN = y_start; ctx.moveTo(250, y_start); }
      highestPN = y_start;
      if (slice.P < 100) {
        linGradLR.addColorStop(0, getLRGradientColor(lr));
        ctx.lineTo(250 + (lr / 10) * 150, 0);
        break;
      }
      linGradLR.addColorStop(gradStop(y_start), getLRGradientColor(lr));
      ctx.lineTo(250 + (lr / 10) * 150, y_start);
    }
    ctx.lineTo(250, highestPN);
    ctx.closePath();
    ctx.fillStyle = linGradLR;
    ctx.fill();

    ctx.beginPath();
    let firstLRPoint = true;
    for (let i = SSlice.H; i < (ESlice.H - 1000); i += 250) {
      const slice = GetLayerByHght(Sounding.Sounding, i);
      const NS = GetLayerByHght(Sounding.Sounding, i + 1000);
      if (!slice || !NS || slice.VT === -9999 || NS.VT === -9999) { firstLRPoint = true; continue; }
      const lr = clamp(slice.VT - NS.VT, 0, 10);
      if (isNaN(lr)) { firstLRPoint = true; continue; }
      const y = pres_to_pix(slice.P);
      const x = 250 + (lr / 10) * 150;
      if (firstLRPoint) { ctx.moveTo(x, y); firstLRPoint = false; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  }

  // --- 4. Draw Comparison Model Outlines ---
  if (comparisonSoundings && comparisonSoundings.length > 0) {
    comparisonSoundings.forEach(comp => {
      if (!comp.metadata.isVisible) return;
      ctx.strokeStyle = comp.metadata.comparisonColor || "rgba(0, 191, 255, 1)";
      ctx.lineWidth = 8;
      const compSounding = comp.sounding.Sounding;
      const compS_Slice = GetLayerByHght(compSounding, "SFC");
      const compE_Slice = GetLayerByPres(compSounding, "Last");

      ctx.beginPath();
      let firstPointWS = true;
      for (let i = 0; i < compSounding.Slice.length; i++) {
        const slice = compSounding.Slice[i];
        const p = slice[0], ws = slice[5];
        if (ws === -9999 || isNaN(ws)) { firstPointWS = true; continue; }
        const y = pres_to_pix(p);
        const x = (ws / maxWindSpeed) * 100;
        if (firstPointWS) { ctx.moveTo(x, y); firstPointWS = false; }
        else { ctx.lineTo(x, y); }
      }
      ctx.stroke();

      if (Presets['Vertical'] != "Default"){
        ctx.beginPath();
        let firstPointRH = true;
        for (let i = 0; i < compSounding.Slice.length; i++) {
          const slice = compSounding.Slice[i];
          const p = slice[0], t = slice[2], d = slice[3];
          if (t === -9999 || d === -9999) { firstPointRH = true; continue; }
          const rh = RelHum(t, d);
          if (isNaN(rh)) { firstPointRH = true; continue; }
          const y = pres_to_pix(p);
          const x = 100 + (rh / 100) * 150;
          if (firstPointRH) { ctx.moveTo(x, y); firstPointRH = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }

      if (Presets['Vertical'] !== "Winter") {
        ctx.beginPath();
        let firstPointLR = true;
        for (let i = compS_Slice.H; i < (compE_Slice.H - 1000); i += 250) {
          const slice = GetLayerByHght(compSounding, i);
          const nextSlice = GetLayerByHght(compSounding, i + 1000);
          if (!slice || !nextSlice || slice.VT === -9999 || nextSlice.VT === -9999) { firstPointLR = true; continue; }
          const lr = (slice.VT - nextSlice.VT);
          if (isNaN(lr)) { firstPointLR = true; continue; }
          const y = pres_to_pix(slice.P);
          const x = 250 + clamp(lr / 10, 0, 1) * 150;
          if (firstPointLR) { ctx.moveTo(x, y); firstPointLR = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }
    });
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.font = `bold 20px ${globalFont}`;
  ctx.textAlign = "center";
  ctx.fillText("Wind Spd", 45, 25);
  ctx.fillText("kts", 45, 45);

  ctx.font = `bold 27px ${globalFont}`;
  if (Presets['Vertical'] !== "Default"){
    ctx.fillText("RH %", 175, 25);
  } else {
    ctx.font = `bold 25px ${globalFont}`;
    ctx.fillText("Inferred", 175, 25);
    ctx.fillText("Temp. Adv.", 175, 48);
    ctx.font = `900 20px ${globalFont}`;
    ctx.fillText("K / H", 175, 75);
  }

  if (Presets['Vertical'] === "Winter") {
    ctx.font = `bold 25px ${globalFont}`;
    ctx.fillText("Inferred", 325, 25);
    ctx.fillText("Temp. Adv.", 325, 48);
    ctx.font = `900 20px ${globalFont}`;
    ctx.fillText("K / H", 325, 75);
  } else {
    ctx.font = `bold 25px ${globalFont}`;
    ctx.fillText("LR 1km", 325, 25);
    ctx.font = `900 20px ${globalFont}`;
    ctx.fillText("C / km", 325, 45);
  }
  ctx.restore();

  // --- 5. Draw DGZ Lines & Restore ---
  const dgzTopLayer = GetLayerByTemp(Sounding.Sounding, -18);
  const dgzBottomLayer = GetLayerByTemp(Sounding.Sounding, -12);
  if (dgzTopLayer && dgzBottomLayer) {
    const y_top = pres_to_pix(dgzTopLayer.P);
    const y_bottom = pres_to_pix(dgzBottomLayer.P);
    ctx.fillStyle = "rgba(255, 175, 126, 1)";
    ctx.fillRect(5, y_top - 1, 440, 2);
    ctx.fillRect(5, y_bottom - 1, 440, 2);
  }

  ctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform for text
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `900 20px ${globalFont}`;
  const labelY = Canv.height - 8;

  ctx.textAlign = "left";
  ctx.fillText("0", 5, labelY);
  ctx.textAlign = "right";
  ctx.fillText("150", 95, labelY);

  if (Presets['Vertical'] !== "Default"){
    ctx.fillText("100", 245, labelY);
    ctx.textAlign = "left";
    ctx.fillText("0", 105, labelY);
  } else {
    ctx.fillText(`${TAdVMax}`, 245, labelY);
    ctx.textAlign = "center";
    ctx.fillText(`0`, (105 + 245)/2, labelY);
    ctx.textAlign = "left";
    ctx.fillText(`-${TAdVMax}`, 105, labelY);
  }

  if (Presets['Vertical'] === "Winter") {
    ctx.fillText(`${_winterTAdVMax}`, 395, labelY);
    ctx.textAlign = "center";
    ctx.fillText(`0`, (255 + 395) / 2, labelY);
    ctx.textAlign = "left";
    ctx.fillText(`-${_winterTAdVMax}`, 255, labelY);
  } else {
    ctx.textAlign = "right";
    ctx.fillText("10", 395, labelY);
    ctx.textAlign = "center";
    ctx.fillText("5", 320, labelY);
    ctx.textAlign = "left";
    ctx.fillText("0", 255, labelY);
  }
  ctx.fontStretch = 'normal';
  ctx.restore();

  if (noWSBox){
    ctx.drawImage(
      Canv,      // Use the canvas itself as the source
      100, 0,      // The source slice (x=150 to 450)
      300, 800,    // Source dimensions
      0, 0,        // Destination coordinates
      400, 800     // Destination dimensions (the stretch)
    );
  }
}

/** Vertical bar panel: full, or without the wind-speed column. Toggles when omitted.
 * @param {*} showWindSpeed Parameter for ChangeWBox.
 * @returns {*} Result of the function.
 */
function ChangeWBox(showWindSpeed){
  noWSBox = typeof showWindSpeed === 'boolean' ? !showWindSpeed : !noWSBox;
  if (Snding && Snding.Sounding) drawVerticalBars(Snding, currentComparisonSoundings, false);
  return !noWSBox;
}

let noWSBox = false;
let presetsAutoSet = false;
/** True after the user changes Wind/Lapse, Inset, Vertical, or Side Panel. Survives time scrubs. */
let userLockedPresets = false;

/** Unlock users sounding presets
 * @returns {void} No value.
 */
function unlockUserSoundingPresets() {
    userLockedPresets = false;
    presetsAutoSet = false;
}

/** Chooses chart presets from the sounding characteristics.
 * @param {*} Sounding Parameter for autoSetPresetsFromSounding.
 * @returns {void} No value.
 */
function autoSetPresetsFromSounding(Sounding) {
    if (userLockedPresets || presetsAutoSet) return;
    presetsAutoSet = true;

    // Always reset to defaults first
    Presets['WindLapse'] = 'Default';
    Presets['Inset'] = 'Default';
    Presets['Vertical'] = 'Default';
    SidePanelMode = 'Graph';

    const Sound = Sounding.Sounding;
    const sfcLayer = GetLayerByPres(Sound, "SFC");

    const E_inf = EffInflowCalc(Sound, sfcLayer);
    const sfcTemp = sfcLayer ? sfcLayer.T : null;
    const sfcDew = sfcLayer ? sfcLayer.D : null;
    
    const sfcRH = (sfcTemp !== null && sfcDew !== null && sfcTemp !== -9999 && sfcDew !== -9999)
        ? RelHum(sfcTemp, sfcDew)
        : null;

    const muParcel = LiftParcel(Sound, "MU", 767);
    const layer1km = GetLayerByHght(Sound, 1000);
    const layer1km_RH = RelHum(layer1km.T, layer1km.D);
    const layer3km = GetLayerByHght(Sound, 3000);
    const layer3km_theta = thetae(layer3km.P, layer3km.T, layer3km.D);
    const sfcTheta = thetae(sfcLayer.P, sfcLayer.T, sfcLayer.D);
    const layer1km_thetea = thetae(layer1km.P, layer1km.T, layer1km.D);
    const muCape = muParcel ? muParcel.Cape : 0;

    const isWinter = sfcTemp !== null && sfcTemp < 5;
    const isFire = sfcRH !== null && sfcRH < 20;
    let isAmbient = false;

    if (sfcRH !== null && layer1km_RH !== null){
      if (muCape <= 10 && sfcRH >= 80 && sfcTemp <= 20 && layer1km_RH < 30 && sfcLayer.WS <= 10){
        //Foggy
        isAmbient = true;
      } 

      if (sfcTemp >= 35 && muCape <= 500 && sfcLayer.WS <= 15){
        //Hot
        isAmbient = true;
      }

      if (sfcTemp <= 0 && muCape <= 50 && sfcLayer.WS >= 1){
        //Cold
        isAmbient = true;
      }

      if (muCape == 0 && sfcTheta <= 320 && layer1km_thetea <= 320 && layer3km_theta && !isWinter && !isFire){
        //Nothing
        isAmbient = true;
      }
    }

    if (isAmbient) {
        Presets['WindLapse'] = 'Winter';
        Presets['Inset'] = 'Ambient';
        Presets['Vertical'] = 'Winter';
        SidePanelMode = 'Winter';
    } else if (isWinter){
        Presets['WindLapse'] = 'Winter';
        Presets['Inset'] = 'Winter';
        Presets['Vertical'] = 'Winter';
        SidePanelMode = 'Winter';
    } else if (isFire) {
        Presets['WindLapse'] = 'Fire';
        Presets['Inset'] = 'Fire';
        Presets['Vertical'] = 'Fire';
    } else if (muCape > 500) {
      if (isSoundingInTornadoClimoBounds(Sounding)){
        SidePanelMode = 'Tornado';    
      } else {
        SidePanelMode = 'Graph';
      }
      
      if (E_inf !== false){
        if (E_inf.Bot+100 <= sfcLayer.P){
          Presets['WindLapse'] = 'Elevated';
          Presets['Inset'] = 'Default';
          Presets['Vertical'] = 'Default';
        }
      }
    }

    if (Math.abs(sfcTheta - layer1km_thetea) < 5 && Math.abs(sfcTheta - layer3km_theta) < 10 && sfcRH <= 25 && muCape <= 100){
      Presets['WindLapse'] = 'Dryline';
      Presets['Inset'] = 'Default';
      Presets['Vertical'] = 'Default';
    }

    autoPresets = {
      WindLapse: Presets['WindLapse'],
      Inset: Presets['Inset'],
      Vertical: Presets['Vertical'],
      SidePanel: SidePanelMode,
    };
    applyPresetOverrides(Sounding);
}

/** Presets the user pinned (null = follow the automatic choice for each sounding). */
let presetOverrides = { WindLapse: null, Inset: null, Vertical: null, SidePanel: null };
/** What autoSetPresetsFromSounding picked for the current sounding. */
let autoPresets = { WindLapse: 'Default', Inset: 'Default', Vertical: 'Default', SidePanel: 'Graph' };

/** Applies user overrides to the active chart presets.
 * @param {*} Sounding Parameter for applyPresetOverrides.
 * @returns {void} No value.
 */
function applyPresetOverrides(Sounding) {
    for (const key of ['WindLapse', 'Inset', 'Vertical']) {
      Presets[key] = presetOverrides[key] || autoPresets[key];
    }
    SidePanelMode = presetOverrides.SidePanel || autoPresets.SidePanel;
    if (SidePanelMode === 'Tornado' && Sounding && Sounding.Location2 && !isSoundingInTornadoClimoBounds(Sounding)) {
      SidePanelMode = autoPresets.SidePanel === 'Tornado' ? 'Graph' : autoPresets.SidePanel;
    }
    UpdatePresets(Presets);
    applySidePanelVisibility();
    emit("change");
}

/**
 * Pin a preset, or pass "auto" to follow the per-sounding choice again.
 * @param {'WindLapse'|'Inset'|'Vertical'|'SidePanel'} type
 * @param {string} value

 * @returns {void} No value.
 */
function setPreset(type, value) {
  if (!(type in presetOverrides)) throw new Error(`SharpJS: unknown preset ${type}`);
  presetOverrides[type] = value && value !== 'auto' ? value : null;
  if (type === 'SidePanel') {
    ChangeSidePanelMode(presetOverrides.SidePanel || autoPresets.SidePanel);
    return;
  }
  Presets[type] = presetOverrides[type] || autoPresets[type];
  UpdatePresets(Presets);
  emit("change");
  if (Snding && Snding.Sounding) {
    drawVerticalBars(Snding, currentComparisonSoundings);
    LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  }
}

/** Draws skew tghost content.
 * @param {*} Sounding Parameter for DrawSkewTGhost.
 * @param {*} Soundings Parameter for DrawSkewTGhost.
 * @returns {void} No value.
 */
function DrawSkewTGhost(Sounding, Soundings) {
  const Canv = $("skewT");
  if (!Canv) return;
  const ctx = Canv.getContext("2d");

  Canv.width = 800;//Canv.style.width;
  Canv.height = 800;
  DrawHodograph(Sounding, Soundings);
}

var DSnding = false;
var isBoxSounding = true;
var GlobalEffInflow = [];

/** Draws skew t content.
 * @param {*} Sounding Parameter for DrawSkewT.
 * @param {*} resetStart Parameter for DrawSkewT.
 * @param {*} modify Parameter for DrawSkewT.
 * @param {*} modify2 Parameter for DrawSkewT.
 * @param {*} ghosted Parameter for DrawSkewT.
 * @param {*} comparisonSoundings Parameter for DrawSkewT.
 * @param {*} setmot Parameter for DrawSkewT.
 * @param {*} vwpactive Parameter for DrawSkewT.
 * @returns {void} No value.
 */
function DrawSkewT(Sounding, resetStart = false, modify = false, modify2 = false, ghosted = false, comparisonSoundings = [], setmot=false, vwpactive=false) {
  if (vwpactive !== true) {
    VWPActive = false;
  }
  if (typeof document === "undefined" || !$("skewT")) {
    return;
  }
  setSkewTDomainsFromSounding(Sounding, comparisonSoundings);
  Clean();
  drawVerticalBars(Sounding, comparisonSoundings, vwpactive === true);
  currentComparisonSoundings = comparisonSoundings;

  const Canv = $("skewT");
  const ctx = Canv.getContext("2d");

  SetTitle(Sounding);

  let EndSlice = GetLayerByPres(Sounding.Sounding, "Last");
  let SBParcel = LiftParcel(Sounding.Sounding, "SB");
  let EffInflow = false;
  let StartSlice = GetLayerByPres(Sounding.Sounding, "SFC");
  if (SBParcel.Path == false) {
    let EffInflow = false;
  } else {
    EffInflow = EffInflowCalc(Sounding.Sounding, StartSlice);
  }
  GlobalEffInflow = EffInflow;

  if (resetStart) {
      userSelectedParcel = defaultParcel;
      userSelectedMotion = defaultMotion;
      let SMS = GetBM(Sounding.Sounding, EffInflow);
      Motions = SMS;
      Motions.RM.y *= -1;
      Motions.LM.y *= -1;
      Motions.MM.y *= -1;
      Motions.US.y *= -1;
      Motions.DS.y *= -1;
      Motions.DTMR.y *= -1;
      Motions.DTML.y *= -1;
      CUMot = customMotionVector();
      
      CSMot = SMS.RM;
      userSetCustomLapse = false;
      userSetCustomWind = false;
      // Auto-presets run on a new sounding (new location / load). Do not re-run on
      // forecast-hour / RAOB / dropsonde time changes (resetStart is false there),
      // and never overwrite a user choice while they scrub.
      if (!userLockedPresets) {
        presetsAutoSet = false;
        autoSetPresetsFromSounding(Sounding);
        drawVerticalBars(Sounding, comparisonSoundings, vwpactive === true);
      }

      const graphCanvas = $("Values4");
      const climoCanvas = $("Values6");
      
      if (SidePanelMode === "Graph") {
          if (graphCanvas) graphCanvas.classList.remove('skewthidden');
          if (climoCanvas) climoCanvas.classList.add('skewthidden');
      } else {
          if (graphCanvas) graphCanvas.classList.add('skewthidden');
          if (climoCanvas) climoCanvas.classList.remove('skewthidden');
      }
  }

  if (DSnding == false || modify2) {
    DSnding = JSON.parse(JSON.stringify(Sounding));
  }
  Set();
  ctx.fillStyle = DarkMode == true && "rgba(0,0,0,1)" || "rgba(255,255,255,1)";
  ctx.fillRect(0, 0, 1000, 1000);

  Canv.width = 800;//Canv.style.width;
  Canv.height = 800;

  ctx.scale(SkewTScale, SkewTScale);
  ctx.translate(SkewTPosition.x, SkewTPosition.y);

  DrawSkewNumbers();


  ctx.lineWidth = 1;

  if (!VWPActive){
    if (setmot !== false){
      CSMot = setmot;
    } else {
      let SMS = GetBM(Sounding.Sounding, EffInflow);
      Motions = SMS;
      Motions.RM.y *= -1;
      Motions.LM.y *= -1;
      Motions.MM.y *= -1;
      Motions.US.y *= -1;
      Motions.DS.y *= -1;
      Motions.DTMR.y *= -1;
      Motions.DTML.y *= -1;
      CUMot = customMotionVector();
      
      CSMot = SMS.RM;
    }
  }

  // Restore storm motion (on a new sounding this applies the default motion)
  if (!VWPActive) {
      if (userSelectedMotion === 'LM') {
          CSMot = Motions.LM;
      } else if (userSelectedMotion === 'MM') {
          CSMot = Motions.MM;
      } else if (userSelectedMotion === 'US') {
          CSMot = Motions.US;
      } else if (userSelectedMotion === 'DS') {
          CSMot = Motions.DS;
      } else if (userSelectedMotion === 'DTMR') {
          CSMot = Motions.DTMR;
      } else if (userSelectedMotion === 'DTML') {
          CSMot = Motions.DTML;
      } else if (userSelectedMotion === 'CM') {
          CSMot = CUMot;
      } else {
          CSMot = Motions.RM;
      }
  }

  // ECAPE inside LiftParcel reads the storm motion from the calc module; give it the one in use.
  if (!VWPActive && CSMot && CSMot.x !== undefined) UpdateCSMotStorm(CSMot);

  SBParcel = LiftParcel(Sounding.Sounding, "SB");
  let MLParcel = LiftParcel(Sounding.Sounding, "ML");
  let MUParcel = LiftParcel(Sounding.Sounding, "MU", 767);
  let CUParcel = LiftParcel(Sounding.Sounding, "CU", 900);

  CUPrcl = CUParcel;
  DP = MUParcel;

  let Sound = Sounding.Sounding;

  if (!userSetCustomLapse) {
      CustomLapseLayer = {
          Title: 'C: 950-850mb',
          T: 950,
          B: 850,
          Lapse: LapseRatePres(Sound, 950, 850, LapseType, 100),
      }
  } else {
      // Recalculate lapse rate with same bounds but new sounding data (heights or pressures)
      CustomLapseLayer.Lapse = CustomLapseLayer.Mode === "Hght"
        ? LapseRateHght(Sound, CustomLapseLayer.T, CustomLapseLayer.B, LapseType, 100)
        : LapseRatePres(Sound, CustomLapseLayer.T, CustomLapseLayer.B, LapseType, 100);
  }

  let DCapeProf = GetDCape(Sounding.Sounding);

  GetLapseBox(Sounding.Sounding);

  StartSlice = GetLayerByPres(Sound, "SFC");

  rStart = StartSlice;

  if (resetStart == true || relStart == false) {
    // console.log("Rest");
    relStart = JSON.parse(JSON.stringify(StartSlice));
  }

  

  let ESRH = 0;
  // console.log(EffInflow);
  if (EffInflow != false) {
    ESRH = GetSRH(Sound, EffInflow.Bot, EffInflow.Top, "Pres");
    ESRH = ESRH.SRHP + ESRH.SRHM;
  }
  let ME = 0;

  if (EffInflow != false) {
    ME = WindShearFindP(Sound, EffInflow.Bot, EffInflow.Top, true)
  }
  let hght0km = GetLayerByHght(Sound, "SFC");
  // let hght05km = GetLayerByHght(Sound, 500);
  // let hght1km = GetLayerByHght(Sound, 1000);
  // let hght3km = GetLayerByHght(Sound, 3000);
  // let hght6km = GetLayerByHght(Sound, 6000);

  let hght2km = GetLayerByHght(Sound, 2000);

  if (!userSetCustomWind) {
      let swv = GetSWV(Sound, hght0km.P, hght2km.P, "Pres", { x: CSMot.x, y: -CSMot.y });
      CustomWindLayer = {
          Title: 'C: 0km-2km',
          T: 0,
          B: 2000,
          SRH: GetSRH(Sound, hght0km.P, hght2km.P, "Pres"),
          SHR: WindShearFind(Sound, "SFC", 2000),
          MW: WindShearFind(Sound, "SFC", 2000, true),
          EHI: 0,
          SWV: -swv.SWV/swv.LevelHght,
          CWV: -swv.CWV/swv.LevelHght,
          SWVPercent: swv.SWPercent
      }
      CustomWindLayer.EHI = GetParams({ DP, SRHAmn: (CustomWindLayer.SRH.SRHP + CustomWindLayer.SRH.SRHM) }, "EHI")
  } else {
      // Recalculate with same bounds but new sounding data
      const botLayer = GetLayerByPres(Sound, CustomWindLayer.T) || hght0km;
      const topLayer = GetLayerByPres(Sound, CustomWindLayer.B) || hght2km;
      CustomWindLayer.SRH = GetSRH(Sound, botLayer.P, topLayer.P, "Pres");
      CustomWindLayer.SHR = WindShearFind(Sound, botLayer.H, topLayer.H);
      CustomWindLayer.MW = WindShearFind(Sound, botLayer.H, topLayer.H, true);
      CustomWindLayer.EHI = GetParams({ DP, SRHAmn: (CustomWindLayer.SRH.SRHP + CustomWindLayer.SRH.SRHM) }, "EHI")
  }

  CustomWindLayer.EHI = GetParams({ DP, SRHAmn: (CustomWindLayer.SRH.SRHP + CustomWindLayer.SRH.SRHM) }, "EHI")

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.fillStyle = "rgba(255,0,0,1)";

  Info = { DCapeProf, EffInflow, SBParcel, MLParcel, MUParcel };
  Snding = Sounding;

  Snding.End = EndSlice;

  let displayParcel;
  if (userSelectedParcel === 'SB') {
      displayParcel = Info.SBParcel;
  } else if (userSelectedParcel === 'ML') {
      displayParcel = Info.MLParcel;
  } else if (userSelectedParcel === 'CU') {
      displayParcel = CUPrcl;
  } else {
      displayParcel = MUParcel; // default MU
  }
  DP = displayParcel;

  if (ghosted != false) {
      DrawSkewTGhost(Sounding, ghosted);
      ghost = ghosted;
      LoadWithWind(Sounding, Info, true, comparisonSoundings);

      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.fillStyle = "rgba(255,0,0,1)";
      LoadWithParcel(Sounding, displayParcel, Info, true, comparisonSoundings);
  } else {
      LoadWithWind(Sounding, Info, false, comparisonSoundings);

      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.fillStyle = "rgba(255,0,0,1)";
      LoadWithParcel(Sounding, displayParcel, Info, false, comparisonSoundings);
  }

  ChangeStateSkewTSkew(false);

  if (modify) {
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillText("Custom Surface Data", 0.5 * Canv.width, 0.027 * Canv.height);
  }
}

let HodoMode = true;
let Hodo2D = true;

let ChangeMod = false;
let M = "(Modified)";

/** Resets hodograph state.
 * @returns {void} No value.
 */
function ResetHodograph() {
  let NN = JSON.parse(JSON.stringify(DSnding));
  Snding.Sounding.W = NN.Sounding.W;

  for (let i = 0; i < Snding.Sounding.Slice.length; i++) {
    let J = Snding.Sounding.Slice[i];
    let J2 = NN.Sounding.Slice[i];
    J[4] = J2[4];
    J[5] = J2[5];
  }

  Slices = [];

  const Canv = $("hodographOverHang3");
  const ctx = Canv.getContext("2d");
  ctx.clearRect(0, 0, 1000, 1000);

  SetTitle(Snding);
  ShowObjects();
  let Mot = GetBM(Snding.Sounding);
  Motions = Mot;
  Motions.RM.y *= -1;
  Motions.LM.y *= -1;
  Motions.MM.y *= -1;
  Motions.US.y *= -1;
  Motions.DS.y *= -1;
  Motions.DTMR.y *= -1;
  Motions.DTML.y *= -1;
  CSMot = Motions.RM;

  DrawHodograph(Snding, false, currentComparisonSoundings);
  DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
}

/** Resets skew t state.
 * @returns {void} No value.
 */
function ResetSkewT() {
  let NN = JSON.parse(JSON.stringify(DSnding));
  Snding.Sounding.T = NN.Sounding.T;
  Snding.Sounding.D = NN.Sounding.D;
  Snding.Sounding.TW = NN.Sounding.TW;
  Snding.Sounding.DW = NN.Sounding.DW;
  for (let i = 0; i < Snding.Sounding.Slice.length; i++) {
    let J = Snding.Sounding.Slice[i];
    let J2 = NN.Sounding.Slice[i];
    J[2] = J2[2];
    J[3] = J2[3];
    J[6] = J2[6];
  }
  Slices = [];
  const Canv = $("skewTOverHang2");
  const ctx = Canv.getContext("2d");
  ctx.clearRect(0, 0, 1000, 1000);
  SetTitle(Snding);
  ShowObjects();

  DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
}

/** Checks is numeric.
 * @param {*} n Parameter for isNumeric.
 * @returns {*} Result of the function.
 */
function isNumeric(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}

// 1. First, let's fix the ShowObjects function to ensure it doesn't overwrite event listeners

/** Shows the objects in the UI.
 * @returns {void} No value.
 */
function ShowObjects() {
  let tableBody = $("modifySkewTBody");
  tableBody.innerHTML = "";

  let sfcLayer = GetLayerByHght(Snding.Sounding, "SFC");

  for (let i = 0; i < Snding.Sounding.Slice.length; i++) {
    let dataLayer = ConvertToInfo(Snding.Sounding.Slice[i]);

    let tableRow = document.createElement("tr");
    // Add a class to highlight the layers currently selected by the user
    if (Slices.some(slice => slice.Pos === i)) {
      tableRow.classList.add("highlight-row");
    }

    // Define the columns with their properties
    let columns = [
      {
        value: `${Math.round(10 * dataLayer.P) / 10}`,
        suffix: " mb",
        editable: false,
        field: null
      },
      {
        value: `${Math.round(10 * dataLayer.H) / 10}`,
        suffix: " m",
        editable: false,
        field: null
      },
      {
        value: dataLayer.T !== -9999 ? Math.round(100 * dataLayer.T) / 100 : "--",
        suffix: "°C",
        editable: true,
        field: 'T'
      },
      {
        value: dataLayer.D !== -9999 ? Math.round(100 * dataLayer.D) / 100 : "--",
        suffix: "°C",
        editable: true,
        field: 'D'
      },
      {
        value: dataLayer.WD !== -9999 ? Math.round(100 * dataLayer.WD) / 100 : "--",
        suffix: "°",
        editable: true,
        field: 'WD'
      },
      {
        value: dataLayer.WS !== -9999 ? Math.round(100 * dataLayer.WS) / 100 : "--",
        suffix: " kts",
        editable: true,
        field: 'WS'
      }
    ];

    // Create table cells for each column
    columns.forEach(column => {
      let cell = document.createElement("td");
      cell.textContent = column.value + column.suffix;

      if (column.editable) {
        cell.classList.add("editable");
        cell.setAttribute("contenteditable", "true");
        cell.dataset.layer = i;
        cell.dataset.field = column.field;
        cell.dataset.original = column.value;
        cell.dataset.suffix = column.suffix;

        // Add event listeners for editing
        cell.addEventListener("focus", handleCellFocus);
        cell.addEventListener("blur", handleCellBlur);
        cell.addEventListener("keydown", handleCellKeydown);
      } else {
        cell.classList.add("non-editable");
      }

      tableRow.appendChild(cell);
    });

    tableBody.appendChild(tableRow);
  }

  // We'll call setupModalEvents here to ensure they're attached after populating the table
  setupModalEvents();
}

// 2. Create a separate function to set up the modal event listeners
/** Sets or applies up modal events state.
 * @returns {void} No value.
 */
function setupModalEvents() {
  const closeBtn = $("closeModifySkewTModal");


  // Remove existing listeners before adding new ones (to prevent duplicates)
  if (closeBtn) {
    closeBtn.removeEventListener("click", closeModifyModal);
    closeBtn.addEventListener("click", function (e) {
      closeModifyModal();
    });
  }
}

/** Turn off modify mode and reset state.
 * @returns {void} No value.
 */
function TurnOff() {
  ChangeMod = false;
  // Clear per-chart state so late callbacks cannot redraw into removed canvases.
  VWPActive = false;
  Snding = {};
  userLockedPresets = false;
  presetsAutoSet = false;
}
// 3. Update the ChangeModify function to use our new setup
/** Sets or applies modify mode state.
 * @param {*} on Parameter for setModifyMode.
 * @returns {void} No value.
 */
function setModifyMode(on) {
  setChangeModState(!!on);
  let modifyModal = $("modifySkewTModal");

  const skewTOverhang = $("skewTOverHang2");
  if (skewTOverhang) {
    const ctx = skewTOverhang.getContext("2d");
    ctx.clearRect(0, 0, skewTOverhang.width, skewTOverhang.height);
  }

  if (ChangeMod) {
    CursorActive = true;
    setReadOutOnState(false);
    setFrontActiveState(false);

    const hodoThing = $("hodographOverHang3");
    if (hodoThing) {
      const ctx2 = hodoThing.getContext("2d");
      ctx2.clearRect(0, 0, hodoThing.width, hodoThing.height);
    }

    if (modifyModal) modifyModal.style.display = "block";
    Slices = [];
    ShowObjects();
    CursorReadout(false);
  } else if (modifyModal) {
    modifyModal.style.display = "none";
  }
}

/** Handles handle cell focus events.
 * @param {*} event Parameter for handleCellFocus.
 * @returns {void} No value.
 */
function handleCellFocus(event) {
  const cell = event.target;
  // Remove the suffix when editing
  cell.textContent = cell.dataset.original;

  // Show the edit helper
  const editHelper = $("editHelper");
  editHelper.classList.add("active");

  // Select all text in the cell
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(cell);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Handles handle cell blur events.
 * @param {*} event Parameter for handleCellBlur.
 * @returns {void} No value.
 */
function handleCellBlur(event) {
  const cell = event.target;
  const editHelper = $("editHelper");

  // Add the suffix back when not editing
  if (cell.textContent !== "") {
    updateCellValue(cell);
  } else {
    cell.textContent = cell.dataset.original + cell.dataset.suffix;
  }

  // Hide the edit helper
  editHelper.classList.remove("active");
}

// Modified handleCellKeydown function to apply changes immediately when Enter is pressed
/** Handles handle cell keydown events.
 * @param {*} event Parameter for handleCellKeydown.
 * @returns {void} No value.
 */
function handleCellKeydown(event) {
  const cell = event.target;

  if (event.key === "Enter") {
    event.preventDefault();

    // Update the cell value
    const oldValue = parseFloat(cell.dataset.original);
    let newValue = parseFloat(cell.textContent);

    if (isNaN(newValue)) {
      cell.textContent = cell.dataset.original + cell.dataset.suffix;
      cell.blur();
      return;
    }

    // Get the data layer
    const layerIndex = parseInt(cell.dataset.layer);
    const field = cell.dataset.field;
    let dataLayer = ConvertToInfo(Snding.Sounding.Slice[layerIndex]);
    const sfcLayer = GetLayerByPres(Snding.Sounding, "SFC");

    // Apply constraints and update the cell visually
    if (field === 'T') {
      // Temperature can't be less than dewpoint
      newValue = Math.max(newValue, dataLayer.D);
    } else if (field === 'D') {
      // Dewpoint can't be greater than temperature
      newValue = Math.min(newValue, dataLayer.T);
    } else if (field === 'WD') {
      // Wind direction between 0 and 360
      newValue = ((newValue % 360) + 360) % 360;
    } else if (field === 'WS') {
      // Wind speed can't be negative
      newValue = Math.max(0, newValue);
    }

    // Update the cell display
    cell.dataset.original = newValue.toString();
    cell.textContent = newValue + cell.dataset.suffix;

    // console.log(`Immediate update: ${field} at layer ${layerIndex} from ${oldValue} to ${newValue}`);

    // IMPORTANT: Apply the change directly to the data structure
    if (field === 'T') {
      // Update temperature
      Snding.Sounding.T[layerIndex] = newValue;
      dataLayer.T = newValue;

      if (Snding.Sounding.TW[layerIndex]) {
        Snding.Sounding.TW[layerIndex].T = newValue;
      }

      // Update the slice
      Snding.Sounding.Slice[layerIndex][2] = newValue;

      // Recalculate virtual temp and wet bulb
      dataLayer.VT = VirtTemp(dataLayer, sfcLayer.P, true, true);
      dataLayer.WB = wetbulb(dataLayer.P, dataLayer.T, dataLayer.D);

      Snding.Sounding.Slice[layerIndex][6] = dataLayer.WB;  // Update wetbulb in slice

      if (Snding.Sounding.TW[layerIndex]) {
        Snding.Sounding.TW[layerIndex].VT = dataLayer.VT;
        Snding.Sounding.TW[layerIndex].WB = dataLayer.WB;
      }

    } else if (field === 'D') {
      // Update dewpoint
      Snding.Sounding.D[layerIndex] = newValue;
      dataLayer.D = newValue;

      if (Snding.Sounding.DW[layerIndex]) {
        Snding.Sounding.DW[layerIndex].D = newValue;
      }

      // Update the slice
      Snding.Sounding.Slice[layerIndex][3] = newValue;

      // Recalculate virtual temp and wet bulb
      dataLayer.VT = VirtTemp(dataLayer, sfcLayer.P, true, true);
      dataLayer.WB = wetbulb(dataLayer.P, dataLayer.T, dataLayer.D);

      Snding.Sounding.Slice[layerIndex][6] = dataLayer.WB;  // Update wetbulb in slice

      if (Snding.Sounding.TW[layerIndex]) {
        Snding.Sounding.TW[layerIndex].VT = dataLayer.VT;
        Snding.Sounding.TW[layerIndex].WB = dataLayer.WB;
      }

    } else if (field === 'WD') {
      // Update wind direction
      Snding.Sounding.Slice[layerIndex][4] = newValue;
      dataLayer.WD = newValue;

      if (Snding.Sounding.W[layerIndex]) {
        Snding.Sounding.W[layerIndex].WD = newValue;
      }

    } else if (field === 'WS') {
      // Update wind speed
      Snding.Sounding.Slice[layerIndex][5] = newValue;
      dataLayer.WS = newValue;

      if (Snding.Sounding.W[layerIndex]) {
        Snding.Sounding.W[layerIndex].WS = newValue;
      }
    }

    // Update the slice with the modified data
    Snding.Sounding.Slice[layerIndex] = ConvertToRaw(dataLayer);

    // Add "(Modified)" to the title if not already present
    if (!Snding.Title.includes("(Modified)")) {
      Snding.Title += " (Modified)";
      SetTitle(Snding);
    }

    // Refresh all calculations
    Info.SBParcel = LiftParcel(Snding.Sounding, "SB");
    Info.MLParcel = LiftParcel(Snding.Sounding, "ML");
    Info.MUParcel = LiftParcel(Snding.Sounding, "MU", 767);
    Info.DCapeProf = GetDCape(Snding.Sounding);

    // Recalculate storm motions
    let BM = GetBM(Snding.Sounding);
    Motions = BM;
    Motions.RM.y *= -1;
    Motions.LM.y *= -1;
    Motions.MM.y *= -1;
    Motions.US.y *= -1;
    Motions.DS.y *= -1;
    Motions.DTMR.y *= -1;
    Motions.DTML.y *= -1;

    // Only reset CSMot if it's the default right motion
    if (CSMot === Motions.RM) {
      CSMot = BM.RM;
    }

    // Redraw everything
    DrawHodograph(Snding);
    DrawSkewT(Snding, false, true, currentComparisonSoundings);

    cell.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cell.textContent = cell.dataset.original + cell.dataset.suffix;
    cell.blur();
  } else if (cell.dataset.field === 'T' || cell.dataset.field === 'D' ||
    cell.dataset.field === 'WD' || cell.dataset.field === 'WS') {
    // Only allow numbers, decimal point, minus sign, backspace, delete, and arrow keys
    if (!/^[\d.-]$/.test(event.key) &&
      event.key !== "Backspace" &&
      event.key !== "Delete" &&
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Tab") {
      event.preventDefault();
    }
  }
}

/** update skew-t modification cell values
 * @param {*} cell Parameter for updateCellValue.
 * @returns {void} No value.
 */
function updateCellValue(cell) {
  const layerIndex = parseInt(cell.dataset.layer);
  const field = cell.dataset.field;
  const oldValue = parseFloat(cell.dataset.original);
  let newValue = parseFloat(cell.textContent);

  if (isNaN(newValue)) {
    cell.textContent = cell.dataset.original + cell.dataset.suffix;
    return;
  }

  // Get the data layer
  let dataLayer = ConvertToInfo(Snding.Sounding.Slice[layerIndex]);

  // Apply constraints based on field type
  if (field === 'T') {
    // Temperature can't be less than dewpoint
    newValue = Math.max(newValue, dataLayer.D);
  } else if (field === 'D') {
    // Dewpoint can't be greater than temperature
    newValue = Math.min(newValue, dataLayer.T);
  } else if (field === 'WD') {
    // Wind direction between 0 and 360
    newValue = ((newValue % 360) + 360) % 360;
  } else if (field === 'WS') {
    // Wind speed can't be negative
    newValue = Math.max(0, newValue);
  }

  // Check if the value actually changed
  if (newValue !== oldValue) {
    // Mark this cell as modified
    cell.classList.add("modified");
    // console.log(`Cell marked as modified: ${field} at layer ${layerIndex} from ${oldValue} to ${newValue}`);
  } else {
    cell.classList.remove("modified");
  }

  // Update the cell value and display
  cell.dataset.original = newValue.toString();
  cell.textContent = newValue + cell.dataset.suffix;
}

// 6. Simplify the closeModifyModal function
/** Turns off modify mode and resets state.
 * @returns {void} No value.
 */
function closeModifyModal() {
  setModifyMode(false);
  emit("change");
}

var DisplayGraphMode = true;

/**
 * Custom wind-shear layer. Nnn = "R" resets to 0-6 km, anything else loads `values`.
 * @param {string} Nnn
 * @param {{ bottom?: number|string, top?: number|string, mode?: 'Hght'|'Pres' }} [values]  km AGL or mb

 * @param {*} values Parameter for LoadNewShearLyr.
 * @returns {void} No value.
 */
function LoadNewShearLyr(Nnn, values = {}) {
  if (!Snding || !Snding.Sounding) return;
    if (Nnn === 'R') {
        userSetCustomWind = false;
    } else {
        userSetCustomWind = true;
    }
  try {
    // Note based on UI labels: 
    // "ShearTop" ID = Bottom Level (Start)
    // "ShearBot" ID = Top Level (End)
    let StartInput = values.bottom ?? "";
    let EndInput = values.top ?? "";
    let Mode = values.mode || "Hght";

    // --- RESET LOGIC (Default 0-6km Bulk Shear) ---
    if (Nnn == "R") {
      let Sfc = GetLayerByHght(Snding.Sounding, "SFC"); // Surface
      // Find 6km AGL
      let TargetHeight = Sfc.H + 6000;
      let TopL = GetLayerByHght(Snding.Sounding, TargetHeight);
      let swv = GetSWV(Snding.Sounding, Sfc.P, TopL.P, "Pres", { x: CSMot.x, y: -CSMot.y });

      CustomWindLayer = {
        Title: `C: 0km-6km`,
        T: Sfc.P,
        B: TopL.P,
        SRH: GetSRH(Snding.Sounding, Sfc.P, TopL.P, "Pres"),
        SHR: WindShearFind(Snding.Sounding, Sfc.H, TopL.H),
        MW: WindShearFind(Snding.Sounding, Sfc.H, TopL.H, true),
        EHI: 0,
        SWV: swv.SWV/swv.LevelHght,
        CWV: swv.CWV/swv.LevelHght,
        SWVPercent: swv.SWPercent,
      }

      if (DP && CustomWindLayer.SRH) {
        CustomWindLayer.EHI = GetParams({
          DP,
          SRHAmn: ((CustomWindLayer.SRH.SRHP || 0) + (CustomWindLayer.SRH.SRHM || 0))
        }, "EHI");
      }

      LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
      return;
    }

    // --- HEIGHT MODE (Strict KM) ---
    if (Mode == "Hght") {
      // 1. Parse inputs as Kilometers
      let StartKM = parseFloat(StartInput);
      let EndKM = parseFloat(EndInput);

      // Defaults if empty
      if (isNaN(StartKM)) StartKM = 0;
      if (isNaN(EndKM)) EndKM = 6;

      // 2. Get Surface Height in Meters
      let SfcH = GetLayerByPres(Snding.Sounding, "SFC").H;

      // Convert KM input to meters AGL, then add Surface Height to get MSL.
      let StartMetersMSL = SfcH + (StartKM * 1000);
      let EndMetersMSL = SfcH + (EndKM * 1000);

      // Find the closest actual data layers
      let LayerStart = GetLayerByHght(Snding.Sounding, StartMetersMSL);
      let LayerEnd = GetLayerByHght(Snding.Sounding, EndMetersMSL);


      if (!LayerStart || !LayerEnd) {
        emit("error", "Could not find data layers for these heights.");
        return;
      }

      let swv = GetSWV(Snding.Sounding, LayerStart.H, LayerEnd.H, "Hght", { x: CSMot.x, y: -CSMot.y });

      // 5. Create Layer Object with KM Title
      CustomWindLayer = {
        Title: `C: ${StartKM}km-${EndKM}km`,
        T: LayerStart.P,
        B: LayerEnd.P,
        SRH: GetSRH(Snding.Sounding, LayerStart.P, LayerEnd.P, "Pres"),
        SHR: WindShearFind(Snding.Sounding, LayerStart.H, LayerEnd.H),
        MW: WindShearFind(Snding.Sounding, LayerStart.H, LayerEnd.H, true),
        EHI: 0,
        SWV: swv.SWV/swv.LevelHght,
        CWV: swv.CWV/swv.LevelHght,
        SWVPercent: swv.SWPercent,
      }

      if (DP && CustomWindLayer.SRH) {
        let srhSum = (CustomWindLayer.SRH.SRHP || 0) + (CustomWindLayer.SRH.SRHM || 0);
        CustomWindLayer.EHI = GetParams({ DP, SRHAmn: srhSum }, "EHI");
      }

      LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);

      // --- PRESSURE MODE (mb) ---
    } else if (Mode == "Pres") {
      // "Top" ID is actually the bottom pressure (higher number) in typical UI ordering,
      // but usually users input Top Pressure (smaller number) and Bottom Pressure (larger number).
      // Let's stick to the generic parsing and sort them.

      let Val1 = parseFloat(StartInput);
      let Val2 = parseFloat(EndInput);
      let SfcP = Snding.Sounding.P[0];

      if (isNaN(Val1)) Val1 = SfcP;
      if (isNaN(Val2)) Val2 = Val1 - 100;

      // Sort: P_Bottom is Higher Value (e.g. 1000), P_Top is Lower Value (e.g. 500)
      let P_Bottom = Math.max(Val1, Val2);
      let P_Top = Math.min(Val1, Val2);

      // Clamp to surface
      P_Bottom = Math.min(P_Bottom, SfcP);

      let LayerBot = GetLayerByPres(Snding.Sounding, P_Bottom);
      let LayerTop = GetLayerByPres(Snding.Sounding, P_Top);

      let swv = GetSWV(Snding.Sounding, LayerBot.H, LayerTop.H, "Hght", { x: CSMot.x, y: -CSMot.y });

      CustomWindLayer = {
        Title: `C: ${Math.round(LayerBot.P)}mb-${Math.round(LayerTop.P)}mb`,
        T: LayerBot.P,
        B: LayerTop.P,
        SRH: GetSRH(Snding.Sounding, LayerBot.P, LayerTop.P, "Pres"),
        SHR: WindShearFind(Snding.Sounding, LayerBot.H, LayerTop.H),
        MW: WindShearFind(Snding.Sounding, LayerBot.H, LayerTop.H, true),
        EHI: 0,
        SWV: swv.SWV/swv.LevelHght,
        CWV: swv.CWV/swv.LevelHght,
        SWVPercent: swv.SWPercent
      }

      if (DP && CustomWindLayer.SRH) {
        let srhSum = (CustomWindLayer.SRH.SRHP || 0) + (CustomWindLayer.SRH.SRHM || 0);
        CustomWindLayer.EHI = GetParams({ DP, SRHAmn: srhSum }, "EHI");
      }

      LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
    }

  } catch (err) {
    console.error("Error in LoadNewShearLyr:", err);
  }
}

let userSetCustomLapse = false;
let userSetCustomWind = false;
let DisplayStormMotions = false;
let DisplayEHI = false;
let DisplayOnMapCape = true;

/** Show every storm motion estimate in the lapse-rate box. Toggles when omitted.
 * @param {*} show Parameter for LoadStormMotions.
 * @returns {*} Result of the function.
 */
function LoadStormMotions(show){
  DisplayStormMotions = typeof show === 'boolean' ? show : !DisplayStormMotions;
  if (Snding && Snding.Sounding) GetLapseBox(Snding.Sounding);
  return DisplayStormMotions;
}

/** Show EHI in wind box
 * @param {*} show Parameter for LoadEHIWindBox.
 * @returns {*} Result of the function.
 */
function LoadEHIWindBox(show){
  DisplayEHI = typeof show === 'boolean' ? show : !DisplayEHI;
  if (Snding && Snding.Sounding) LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
  return DisplayEHI;
}

/** Show EHI in wind box
 * @param {*} show Parameter for LoadEHIWindBox.
 * @returns {*} Result of the function.
 */
function LoadOnMapCape(show){
  DisplayOnMapCape = typeof show === 'boolean' ? show : !DisplayOnMapCape;
  if (Snding && Snding.Sounding) DrawSkewT(Snding, false, false, currentComparisonSoundings);
  return DisplayOnMapCape;
}

/**
 * Custom lapse-rate layer. Nnn = "R" resets to 0-3 km, anything else loads `values`.
 * @param {string} Nnn
 * @param {{ bottom?: number|string, top?: number|string, mode?: 'Hght'|'Pres' }} [values]  km AGL or mb

 * @param {*} values Parameter for LoadNewLapseLyr.
 * @returns {void} No value.
 */
function LoadNewLapseLyr(Nnn, values = {}) {
  if (!Snding || !Snding.Sounding) return;
    if (Nnn === 'R') {
        userSetCustomLapse = false; // reset flag on reset
    } else {
        userSetCustomLapse = true; // user loaded a custom layer
    }
  try {
    // Note based on UI labels: 
    // "LapseTop" ID = Bottom Level (Start)
    // "LapseBot" ID = Top Level (End)
    let StartInput = values.bottom ?? "";
    let EndInput = values.top ?? "";
    let Mode = values.mode || "Hght";

    // --- RESET LOGIC (Default 0-3km) ---
    if (Nnn == "R") {
      let Sfc = GetLayerByHght(Snding.Sounding, "SFC");
      let TargetHeight = Sfc.H + 3000; // 3km AGL
      let TopL = GetLayerByHght(Snding.Sounding, TargetHeight);

      CustomLapseLayer = {
        Title: `C: 0km-3km`,
        Mode: "Hght",
        T: Sfc.H,
        B: TopL.H,
        Lapse: LapseRateHght(Snding.Sounding, Sfc.H, TopL.H, LapseType),
      }

      GetLapseBox(Snding.Sounding);
      return;
    }

    // --- HEIGHT MODE (Strict KM) ---
    if (Mode == "Hght") {
      let StartKM = parseFloat(StartInput);
      let EndKM = parseFloat(EndInput);

      if (isNaN(StartKM)) StartKM = 0;
      if (isNaN(EndKM)) EndKM = 3;

      // Get Surface Height
      let SfcH = GetLayerByPres(Snding.Sounding, "SFC").H;

      // Convert KM input to Meters AGL, then add Surface Height to get MSL
      let StartMetersMSL = SfcH + (StartKM * 1000);
      let EndMetersMSL = SfcH + (EndKM * 1000);

      // Find actual layers
      let LayerStart = GetLayerByHght(Snding.Sounding, StartMetersMSL);
      let LayerEnd = GetLayerByHght(Snding.Sounding, EndMetersMSL);

      if (!LayerStart || !LayerEnd) {
        emit("error", "Could not find data layers.");
        return;
      }

      CustomLapseLayer = {
        Title: `C: ${StartKM}km-${EndKM}km`,
        Mode: "Hght",
        T: LayerStart.H,
        B: LayerEnd.H,
        Lapse: LapseRateHght(Snding.Sounding, LayerStart.H, LayerEnd.H, LapseType),
      }

      GetLapseBox(Snding.Sounding);

      // --- PRESSURE MODE (mb) ---
    } else if (Mode == "Pres") {
      let Val1 = parseFloat(StartInput);
      let Val2 = parseFloat(EndInput);
      let SfcP = Snding.Sounding.P[0];

      if (isNaN(Val1)) Val1 = SfcP;
      if (isNaN(Val2)) Val2 = Val1 - 100;

      // Sort and Clamp
      let P_Bottom = Math.max(Val1, Val2);
      let P_Top = Math.min(Val1, Val2);
      P_Bottom = Math.min(P_Bottom, SfcP);

      let LayerBot = GetLayerByPres(Snding.Sounding, P_Bottom);
      let LayerTop = GetLayerByPres(Snding.Sounding, P_Top);

      CustomLapseLayer = {
        Title: `C ${Math.round(LayerBot.P)}mb-${Math.round(LayerTop.P)}mb`,
        Mode: "Pres",
        T: LayerBot.P,
        B: LayerTop.P,
        Lapse: LapseRatePres(Snding.Sounding, LayerBot.P, LayerTop.P, LapseType, 100),
      }

      GetLapseBox(Snding.Sounding);
    }
  } catch (err) {
    console.error("Error in LoadNewLapseLyr:", err);
  }
}

/** Returns snding data.
 * @returns {*} Result of the function.
 */
function getSnding() {
  return Snding;
}

/** Returns the visible comparison soundings.
 * @returns {*} Result of the function.
 */
function getCurrentComparisonSoundings() {
  return currentComparisonSoundings;
}

/** Last custom storm motion typed by the user (degrees from, knots). */
let customMotionInput = { direction: 0, speed: 10 };

/** Chart-space vector for the custom motion. Redraws rebuild it from the user's input so it survives.
 * @returns {*} Result of the function.
 */
function customMotionVector() {
  const Angg = ((parseFloat(customMotionInput.direction) % 360) + 360) % 360 || 0;
  const Spdd = clamp(parseFloat(customMotionInput.speed) || 10, 0, 100);
  const v = ConvertPolartoCart({ WD: Angg, WS: Spdd });
  const snap = (n) => (Math.abs(n) < 1e-9 ? 0 : n);
  return { x: snap(v.x), y: snap(-v.y) };
}

/**
 * Select the storm motion used for storm-relative calculations.
 * @param {'RM'|'LM'|'MM'|'US'|'DS'|'DTMR'|'DTML'|'CM'} N
 * @param {boolean} [activateChanges=true] redraw afterwards
 * @param {{ direction?: number, speed?: number }} [custom] for "CM": motion direction (deg) and speed (kt)

 * @param {*} custom Parameter for LoadNewWind.
 * @returns {void} No value.
 */
function LoadNewWind(N, activateChanges=true, custom=null) {
  userSelectedMotion = N;
  if (custom) {
    customMotionInput = {
      direction: custom.direction ?? customMotionInput.direction,
      speed: custom.speed ?? customMotionInput.speed,
    };
  }

  if (N == "RM") {
    CSMot = Motions.RM;
  } else if (N == "LM") {
    CSMot = Motions.LM;
  } else if (N == "MM") {
    CSMot = Motions.MM;
  } else if (N == "DTMR") {
    CSMot = Motions.DTMR;
  } else if (N == "DTML") {
    CSMot = Motions.DTML;
  } else if (N == "US") {
    CSMot = Motions.US;
  } else if (N == "DS") {
    CSMot = Motions.DS;
  } else if (N == "CM") {
    CUMot = customMotionVector();
    CSMot = CUMot;
  }
  emit("change");

  if (activateChanges && Snding && Snding.Sounding){
    const inVwp = VWPActive === true;
    LoadWithWind(Snding, Info, ghost, currentComparisonSoundings);
    DrawFront(false, true);
    CursorReadout(false, true);
    // VWP must use vwpactive=true so DrawSkewT does not clear VWPActive; otherwise layout
    // reverts to full Skew-T and DrawBoxes can index past the last wind level (undefined .WS).
    if (inVwp) {
      DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings, 'VWPSKIP', true);
    } else {
      DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings, CSMot);
    }
  }
  
}

let DarkMode = true;
let ModifiedWind = false;

/** Convert a temperature in `mode` units ("F", "C" or "K") to Celsius.
 * @param {*} N Parameter for Conv.
 * @param {*} mode Parameter for Conv.
 * @returns {*} Result of the function.
 */
function Conv(N, mode = "F") {
  if (mode == "F") {
    return FtoC(N);
  } else if (mode == "C") {
    return N;
  } else if (mode == "K") {
    return N - 273.15;
  } else {
    return N;
  }
}

/** Returns a finite number or a fallback value.
 * @param {*} v Parameter for finiteOr.
 * @param {*} fallback Parameter for finiteOr.
 * @returns {*} Result of the function.
 */
const finiteOr = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Modify (N = "New") or restore (N = "Old") the surface level.
 * @param {'New'|'Old'} N
 * @param {'tmp'|'wnd'} t
 * @param {object} [values]
 *   tmp: { temperature, dewpoint, unit: 'F'|'C'|'K' }  (blank values keep the current surface)
 *   wnd: { direction, speed }                          (degrees, knots)

 * @returns {void} No value.
 */
function LoadNewSfc(N, t, values = {}) {
  if (!Snding || !Snding.Sounding) return;
  if (t == "tmp") {
    let mode = values.unit || "F";

    if (N == "New") {
      let TMPC = finiteOr(Conv(parseFloat(values.temperature), mode), rStart.T);
      TMPC = clamp(TMPC, -78, 150);
      let DWPC = finiteOr(Conv(parseFloat(values.dewpoint), mode), rStart.D);
      DWPC = clamp(DWPC, -79, TMPC);

      let VTemp = virtemp(rStart.P, TMPC, TMPC);
      let WBulb = wetbulb(rStart.P, TMPC, DWPC);

      let nSlice = rStart;

      nSlice.VT = VTemp;
      nSlice.T = TMPC;
      nSlice.D = DWPC;
      nSlice.WB = WBulb;
      let Sound = Snding.Sounding;
      Sound.D[0] = DWPC;
      Sound.DW[0].D = DWPC;
      Sound.TW[0].T = TMPC;
      Sound.TW[0].VT = VTemp;
      Sound.TW[0].WB = WBulb;
      Sound.T[0] = TMPC;
      Sound.Slice[0] = ConvertToRaw(nSlice);

      DrawSkewT(Snding, false, true, false, false, currentComparisonSoundings);

    } else if (N == "Old") {
      let nSlice = relStart;
      let TMPC = nSlice.T;
      let DWPC = nSlice.D;
      let WBulb = nSlice.WB;
      let VTemp = nSlice.VT;
      let Sound = Snding.Sounding;
      Sound.D[0] = DWPC;
      Sound.DW[0].D = DWPC;
      Sound.TW[0].T = TMPC;
      Sound.TW[0].VT = VTemp;
      Sound.TW[0].WB = WBulb;
      Sound.T[0] = TMPC;
      Sound.Slice[0] = ConvertToRaw(nSlice);

      DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
    }
  } else if (t == "wnd") {
    if (N == "New") {
      let WSP = clamp(finiteOr(values.speed, 10), 0, 1000);
      let WDI = clamp(finiteOr(values.direction, 180) % 360, 0, 360);
      let nSlice = rStart;
      nSlice.WD = WDI;
      nSlice.WS = WSP;

      let Sound = Snding.Sounding;
      Sound.W[0].WD = WDI;
      Sound.W[0].WS = WSP;
      Sound.Slice[0] = ConvertToRaw(nSlice);

      let SMS = GetBM(Snding.Sounding);
      Motions = SMS;
      Motions.RM.y *= -1;
      Motions.LM.y *= -1;
      Motions.MM.y *= -1;
      Motions.US.y *= -1;
      Motions.DS.y *= -1;
      Motions.DTMR.y *= -1;
      Motions.DTML.y *= -1;

      ModifiedWind = true;

      DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);

    } else if (N == "Old") {
      let nSlice = relStart;
      let WSP = nSlice.WS;
      let WDI = nSlice.WD;

      let Sound = Snding.Sounding;
      Sound.W[0].WD = WDI;
      Sound.W[0].WS = WSP;
      Sound.Slice[0] = ConvertToRaw(nSlice);

      ModifiedWind = false;

      let SMS = GetBM(Snding.Sounding);
      Motions = SMS;
      Motions.RM.y *= -1;
      Motions.LM.y *= -1;
      Motions.MM.y *= -1;
      Motions.US.y *= -1;
      Motions.DS.y *= -1;
      Motions.DTMR.y *= -1;
      Motions.DTML.y *= -1;

      DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings);
    }
  }
}

// Add these near the other global variables
let userSelectedParcel = 'MU'; // track what user picked
let userSelectedMotion = 'RM'; // track what user picked
/** Parcel / storm motion selected when a new sounding loads (settings: defaultParcel, defaultMotion). */
let defaultParcel = 'MU';
let defaultMotion = 'RM';

/** Last custom parcel starting pressure (mb). */
let customParcelPressure = 900;

/**
 * Select the displayed parcel.
 * @param {'SB'|'ML'|'MU'|'CU'} N
 * @param {number} [pressure] for "CU": starting pressure in mb

 * @returns {void} No value.
 */
function LoadNewParcel(N, pressure) {
  userSelectedParcel = N;
  if (pressure != null && !isNaN(parseFloat(pressure))) customParcelPressure = parseFloat(pressure);
  emit("change");
  if (!Snding || !Snding.Sounding) return;

  if (N == "SB") {
    DP = Info.SBParcel;
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  } else if (N == "ML") {
    DP = Info.MLParcel;
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  } else if (N == "MU") {
    DP = Info.MUParcel;
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  } else if (N == "CU") {
    let Pressure = customParcelPressure || 900;
    let Max = GetLayerByPres(Snding.Sounding, "Last");
    Pressure = clamp(Pressure, Max.P, Info.SBParcel.Start.P);
    DP = LiftParcel(Snding.Sounding, "CU", Pressure);
    CUPrcl = DP;
    LoadWithParcel(Snding, DP, Info, ghost, currentComparisonSoundings);
  }
  LoadWithWind(Snding, Info, ghost, currentComparisonSoundings)
}


/** Sets or applies title state.
 * @param {*} K Parameter for SetTitle.
 * @returns {void} No value.
 */
function SetTitle(K) {
  const Canv = $("skewTTitle");
  if (!Canv) return;
  const ctx = Canv.getContext("2d");
  if (!ctx) return;
  const dropsondeMode = isDropsondeSounding(K);
  const bg = dropsondeMode ? (DarkMode ? "#0a0c0e" : "#f7f8fa") : "rgba(0,0,0,1)";
  const fg = dropsondeMode ? (DarkMode ? "#e8eef2" : "#1a2228") : "rgba(255,255,255,1)";
  const muted = DarkMode ? "#8ea3b3" : "#5a6b78";

  Canv.width = 800;
  Canv.height = dropsondeMode ? 54 : 30;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, Canv.width, Canv.height);

  const title = `${K.Title || ""}`;
  const padX = 0.02 * Canv.width;

  if (!dropsondeMode) {
    ctx.font = `bold ${title.length > 35 ? Canv.width / 50 : Canv.width / 40}px ${globalFont}`;
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, 0.025 * Canv.width, 22);
    ctx.fillRect(25, 28, 795, 2);
    return;
  }

  // Dropsonde: mission title on first line, SharpJS branding below
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const titleY = 16;
  const brandY = 38;
  const parts = title.split(/\s*·\s*/);
  const primary = (parts[0] || title).trim();
  const secondary = parts.slice(1).join(" · ").trim();

  ctx.font = `700 ${Canv.width / 38}px ${globalFont}`;
  ctx.fillStyle = fg;
  ctx.fillText(primary, padX, titleY);

  let x = padX + ctx.measureText(primary).width;

  if (secondary) {
    ctx.font = `600 ${Canv.width / 42}px ${globalFont}`;
    ctx.fillStyle = muted;
    const sep = "  ·  ";
    ctx.fillText(sep, x, titleY);
    x += ctx.measureText(sep).width;
    ctx.fillText(secondary, x, titleY);
  }

  ctx.font = `600 ${Canv.width / 48}px ${globalFont}`;
  ctx.fillStyle = muted;
  ctx.fillText(brandLine(" · "), padX, brandY);

  ctx.fillStyle = DarkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  ctx.fillRect(padX, Canv.height - 2, Canv.width - padX * 2, 1);
}


/**
 * Draw a sounding.
 * @param {string|object} text  SHARPpy-style text, or an already parsed sounding (with processed=true)
 * @param {boolean} [processed=false]
 * @param {object} [opts]
 * @param {boolean} [opts.reset=true]  treat as a new sounding: re-run auto presets, reset parcel/motion
 *                                     choices to their defaults and remember it for "Reset SkewT/Hodograph"
 * @param {Array}   [opts.comparisons] comparison soundings ({ sounding, metadata }) to overlay

 * @returns {void} No value.
 */
function Load(text, processed = false, opts = {}) {
  let K = text;
  if (!processed) {
    K = Process(text);
  }
  const reset = opts.reset !== false;
  const comparisons = Array.isArray(opts.comparisons) ? opts.comparisons : currentComparisonSoundings;

  Clean()
  SetTitle(K);

  ghost = false;
  if (reset || !DSnding) DSnding = JSON.parse(JSON.stringify(K));
  DrawSkewT(K, reset, false, reset, false, comparisons);
  ShowObjects();
  const err = $("Error");
  if (err) err.style.visibility = "hidden";
}


// 1. New function to just get the data and filename
/** Returns sounding text content data.
 * @param {*} format Parameter for GetSoundingTextContent.
 * @returns {*} Result of the function.
 */
function GetSoundingTextContent(format = SoundingExport) {
  if (!Snding || !Snding.Sounding) return null;
  return exportSounding(Snding, format, { savedBy: options.savedBy, filePrefix: options.filePrefix });
}

// 2. Modified original function (Kept for backward compatibility/browser fallback)
/** Downloads the current sounding.
 * @returns {void} No value.
 */
function DownloadSounding() {
  const data = GetSoundingTextContent();
  if (!data) return;

  let element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(data.text));
  element.setAttribute('download', data.filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}


/** Averages multiple soundings.
 * @param {*} Files Parameter for AverageAll.
 * @returns {void} No value.
 */
function AverageAll(Files) {
  let TF = [];

  

  Files.forEach((N) => {
    TF.push(Process(N[1]))//[N[0], Process(N[1])]);
  });

  let Avg = {
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

  let Return = [];

  let LowestP = 0;
  let HighestP = 999;

  TF.forEach((P) => {
    LowestP = Math.max(LowestP, GetLayerByPres(P.Sounding, "SFC").P);
    HighestP = Math.min(HighestP, GetLayerByPres(P.Sounding, "Last").P);
  });

  let Build = [];

  for (let i = Math.min(1000, LowestP - 2); Math.max(100, HighestP) < i; i -= 10) {
    let Slice = [0, 0, 0, 0, 0, 0];
    let T = 0;
    //p,h,t,d,wd,ws

    TF.forEach((P) => {
      let R = GetLayerByPres(P.Sounding, "SFC").P;
      let R2 = GetLayerByPres(P.Sounding, "Last").P;

      if (R <= i || i <= R2) {
        ;
      } else {
        T++;
        let Lyr = GetLayerByPres(P.Sounding, i);

        Slice[0] += Lyr.P;
        Slice[1] += Lyr.H;
        Slice[2] += Lyr.T;
        Slice[3] += Lyr.D;
        Slice[4] += Lyr.WD;
        Slice[5] += Lyr.WS;
      }
    });

    Slice[0] /= T;
    Slice[1] /= T;
    Slice[2] /= T;
    Slice[3] /= T;
    Slice[4] /= T;
    Slice[5] /= T;

    Build.push(Slice);
  }

  let InfoString = "";

  let Sound = Snding.Sounding;
  for (let i = 0; i < Build.length; i++) {
    let P = Build[i]
    InfoString += ` ${P[0]},\t${P[1]},\t${P[2]},\t${P[3]},\t${P[4]},\t${P[5]}\n`;
  }

  let text = `%TITLE%
AVERAGE OF ${TF.length} SOUNDINGS
     LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD
-------------------------------------------------------------------
%RAW%
${InfoString}%END%`;

  let RR = Process(text);

  ghost = TF;
  DSnding = JSON.parse(JSON.stringify(RR));
  SetTitle(DSnding);
  DrawSkewT(DSnding, true, false, false, TF, currentComparisonSoundings);
  //DrawSkewT(RR, true, false, false, false, TF);
}

const GetColorComp = [
  "rgb(0, 225, 255)",
  "rgb(255, 0, 0)",
  "rgb(246, 255, 0)",
  "rgb(85, 255, 0)",
  "rgb(170, 0, 255)",
  "rgba(255, 255, 255, 1)",
]

/** Replace the comparison soundings ({ sounding, metadata } items) and redraw.
 * @param {*} list Parameter for setComparisons.
 * @returns {void} No value.
 */
function setComparisons(list) {
  currentComparisonSoundings = Array.isArray(list) ? list : [];
  redraw();
}

/** Remove every comparison sounding and redraw the main one.
 * @returns {void} No value.
 */
function clearComparisons() {
  currentComparisonSoundings = [];
  if (DSnding && DSnding.Sounding) {
    SetTitle(DSnding);
    DrawSkewT(DSnding, false, false, false, false, []);
  }
}

/**
 * Overlay comparison soundings. Files: [[name, text], ...] (sparse arrays from older callers are fine).

 * @param {*} Files Parameter for CompareSoundings.
 * @returns {void} No value.
 */
function CompareSoundings(Files) {
  let TF = [];

  Files.forEach((N) => {
    TF.push({
      metadata:{
        comparisonColor: 0,
        date: 0,
        fh: 0,
        isVisible: true,
        model: 'nam',
        run: 12,
      },
      sounding: Process(N[1])
    })//[N[0], Process(N[1])]);
  });

  for (let i = 0; i < TF.length; i++){
    let P = TF[i];

    P.metadata.comparisonColor = GetColorComp[i%GetColorComp.length];
    P.metadata.date = "Cstm";
    P.metadata.fh = 0;
    P.metadata.model = 'Snding';
    P.metadata.run = 12;
    P.metadata.title = P.sounding.STitle;

    P.metadata.title = P.metadata.title.replace("|", " ");
    P.metadata.title = P.metadata.title.replace('Z|F-', "FH");
    P.metadata.title = P.metadata.title.replace('FH', "z FH ").replace("|LOC-", " -AT: ").replace("N-", "N, -");
    P.metadata.title = P.metadata.title.replace('VALID-', " ");

    P.metadata.title = P.metadata.title.substring(0, Math.min(P.sounding.STitle.length, 45));

    if (P.sounding.STitle.length > 45){
      P.metadata.title = `${P.metadata.title}...`;
    }
  }

  SetTitle(DSnding);
  DrawSkewT(DSnding, true, false, false, false, TF);
  //DrawSkewT(RR, true, false, false, false, TF);
}

/** Takes a screenshot of the current view.
 * @param {*} del Parameter for Screenshot.
 * @param {*} scale Parameter for Screenshot.
 * @returns {*} Result of the function.
 */
function Screenshot(del = true, scale = 1) {
  return new Promise((resolve, reject) => {
    let ModifiedPanel = $("Values6");
    if ($("Values6").classList.contains("skewthidden")) {
      ModifiedPanel = $("Values4");
    }

    const shift = 150;

    let ToLoad = [
      [$("skewTTitle"), 0, 2 * scale, 38 * 800/30 * scale, 38 * scale],
      [$("skewT"), 0, 40 * scale, (960 - shift) * scale, 720 * scale, true],
      [$("verticalBar"), (985 - 100) * scale, 39 * scale, 214 * scale, 721 * scale],
      [$("skewTNumbers"), 0, 760 * scale, (1050 - shift) * scale, 40 * scale],
      [$("hodograph"), 1100 * scale, 0, 900 * scale, 800 * scale],
      [$("Values1"), 0, 800 * scale, 825 * scale, 200 * scale],
      [$("Values2"), 825 * scale, 800 * scale, 275 * scale, 200 * scale],
      [$("Values3"), 0, 1000 * scale, 1100 * scale, 200 * scale],
      [$("Values5"), 1100 * scale, 800 * scale, 540 * scale, 400 * scale],
      [ModifiedPanel, 1640 * scale, 800 * scale, 360 * scale, 400 * scale],
    ];

    let ToLoad2 = [
      [$("barbs"), (942 - shift) * scale, 40 * scale, 100 * scale, 720 * scale],
    ];

    if (VWPActive){
      ToLoad = [
        [$("skewTTitle"), 0, 2 * scale, 38 * 800/30 * scale, 38 * scale],
        [$("hodograph"), 0, 40 * scale, 2000 * 0.60 * scale, 1200  * scale, true],
        [$("Values5"), 2000 * 0.60 * scale, 0,  2000 * 0.4 * scale, 1200 * 0.36666 * scale],
        [$("Values7"), 2000 * 0.60 * scale, 1200 * 0.36666 * scale,  2000 * 0.4 * scale, 1200 * 0.18333 * scale],
        [$("Values8"), 2000 * 0.60 * scale, 1200 * 0.55 * scale,  2000 * 0.4 * scale, 1200 * 0.45 * scale],
      ];

      ToLoad2 = [];
    }

    const downloadedImg = document.createElement("canvas");
    const dImg = downloadedImg.getContext("2d");
    downloadedImg.width = 2000 * scale;
    downloadedImg.height = 1200 * scale;
    dImg.fillStyle = "rgba(0,0,0,1)";
    dImg.fillRect(0, 0, downloadedImg.width, downloadedImg.height);

    // Convert a single canvas entry to a drawn image — all in parallel
    /** Draws entry content.
     * @param {*} img Parameter for drawEntry.
     * @returns {*} Result of the function.
     */
    const drawEntry = (img) => new Promise((res) => {
      if (!img[0]) { res(); return; }

      img[0].toBlob((blob) => {
        if (!blob) { res(); return; }

        const newImg = document.createElement("img");
        const url = URL.createObjectURL(blob);
        newImg.src = url;

        newImg.onload = () => {
          dImg.drawImage(newImg, img[1], img[2], img[3] || 0, img[4] || 0);
          if (!["skewT", 'skewTNumbers', 'skewTTitle', 'verticalBar', 'barbs'].includes(img[0].dataset.sjs)) {
            dImg.strokeStyle = "rgba(125,125,125,1)";
            dImg.lineWidth = 3;
            dImg.strokeRect(img[1], img[2], img[3] || 0, img[4] || 0);
          }
          if (["skewTTitle"].includes(img[0].dataset.sjs)){
            dImg.fillStyle = "rgb(255, 255, 255)";
            dImg.fillRect(25/800 * 1200 * scale, 28/30 * 40 * scale, 795/800 * 1200 * scale, 2/30 * 40 * scale);
          }
          URL.revokeObjectURL(url);
          newImg.remove();
          res();
        };

        newImg.onerror = () => {
          console.error("Failed to load a canvas image for screenshotting.");
          URL.revokeObjectURL(url);
          res(); // don't reject — just skip
        };
      });
    });

    Promise.all(ToLoad.map(drawEntry))
      .then(() => Promise.all(ToLoad2.map(drawEntry)))
      .then(() => {
        const finalImageDataUrl = downloadedImg.toDataURL("image/png");

        if (!del) {
          resolve(finalImageDataUrl);
        } else {
          const element = document.createElement('a');
          element.setAttribute('href', finalImageDataUrl);
          element.setAttribute('download', `${Snding.Title}_saved.png`);
          element.style.display = 'none';
          document.body.appendChild(element);
          element.click();
          document.body.removeChild(element);
          downloadedImg.remove();
          resolve(finalImageDataUrl);
        }
      })
      .catch(reject);
  });
}



/** Sets or applies  state.
 * @returns {void} No value.
 */
function Set() {
  const c0 = $("skewTOverHang2");

  c0.width = 800;//Canv.style.width;
  c0.height = 800;

  const c2 = $("skewTOverHang");
  const ct2 = c2.getContext("2d");

  c2.width = 800;//Canv.style.width;
  c2.height = 800;
  const Canv2 = $("hodographOverHang");
  const ctx2 = Canv2.getContext("2d");
  Canv2.width = 800;
  Canv2.height = 800;

  ctx2.scale(2, 2);

  const Canv3 = $("hodographOverHang2");
  const ctx3 = Canv2.getContext("2d");

  Canv3.width = 800;
  Canv3.height = 800;

  ctx3.scale(2, 2);

  const Canv4 = $("hodographOverHang3");
  const ctx4 = Canv2.getContext("2d");

  Canv4.width = 800;
  Canv4.height = 800;

  ctx4.scale(2, 2);
}

let Presets = {
  "WindLapse": "Default",
  "Inset": "Default",
  "Vertical": "Default",
}

let SoundingExport = "Default";

/** Export text format: "Default" (SHARPpy), "SharpJS" (SHARPpy + omega) or "CM1".
 * @param {*} format Parameter for setExportFormat.
 * @returns {*} Result of the function.
 */
function setExportFormat(format) {
  if (['Default', 'SharpJS', 'CM1'].includes(format)) SoundingExport = format;
  emit("change");
  return SoundingExport;
}

let VWPSounding = {};

/** Applies motion and sounding data from a VWP profile.
 * @returns {void} No value.
 */
function applyVwpMotionsAndSndingFromVWPSounding() {
  let SMS = GetBM(VWPSounding.Sounding);
  Motions = SMS;
  Motions.RM.y *= -1;
  Motions.LM.y *= -1;
  Motions.MM.y *= -1;
  Motions.US.y *= -1;
  Motions.DS.y *= -1;
  Motions.DTMR.y *= -1;
  Motions.DTML.y *= -1;

  if (userSelectedMotion === 'LM') {
    CSMot = Motions.LM;
  } else if (userSelectedMotion === 'MM') {
    CSMot = Motions.MM;
  } else if (userSelectedMotion === 'US') {
    CSMot = Motions.US;
  } else if (userSelectedMotion === 'DS') {
    CSMot = Motions.DS;
  } else if (userSelectedMotion === 'DTMR') {
    CSMot = Motions.DTMR;
  } else if (userSelectedMotion === 'DTML') {
    CSMot = Motions.DTML;
  } else if (userSelectedMotion === 'CM') {
    CSMot = CUMot;
  } else {
    CSMot = Motions.RM;
  }
  Snding = VWPSounding;
}

/**
 * Apply a VWP sounding (built by io/vwp.js buildVwpSounding) to the live skew-T / hodograph.
 * @param {object} stored Deep clone-safe plain object

 * @returns {void} No value.
 */
function applyNexradVwpStoredSounding(stored) {
  if (!stored || !stored.Sounding) return;
  VWPActive = true;
  VWPSounding = JSON.parse(JSON.stringify(stored));
  applyVwpMotionsAndSndingFromVWPSounding();
  DrawHodograph(VWPSounding, false, currentComparisonSoundings);
  redrawSkewTFromVwp(VWPSounding);
}

/** Redraws the skew-T after applying a VWP sounding.
 * @param {*} VWPSounding Parameter for redrawSkewTFromVwp.
 * @param {*} options Parameter for redrawSkewTFromVwp.
 * @returns {void} No value.
 */
function redrawSkewTFromVwp(VWPSounding, options = {}) {
  // Canvases can be gone if the viewer was destroyed between a fetch and its redraw.
  if (!$("skewT") || !$("skewTTitle")) {
    return;
  }
  const skipMotionFix = options.skipMotionFix === true;
  SetTitle(VWPSounding);
  if (!skipMotionFix) {
    if (isNaN(CSMot.x) && isNaN(CSMot.y)) {
      userSelectedMotion = 'CM';
      CSMot = CUMot;
      LoadNewWind('CM', false);
    }
    UpdateCSMotStorm(CSMot);
  }
  VWPActive = true;
  DrawSkewT(
    VWPSounding,
    false,
    false,
    false,
    false,
    currentComparisonSoundings,
    'VWPSKIP',
    true
  );
  VWPActive = true;
}

/** Returns the active ghost sounding.
 * @returns {*} Result of the function.
 */
function getGhost() { return ghost; }
/** Returns the active display parcel.
 * @returns {*} Result of the function.
 */
function getDP() { return DP; }
/** Returns the current chart analysis information.
 * @returns {*} Result of the function.
 */
function getInfo() { return Info; }

const UNIT_SYSTEMS = ['default', 'metric', 'imperial'];
const PARCELS = ['SB', 'ML', 'MU'];
const MOTIONS = ['RM', 'LM', 'MM', 'US', 'DS', 'DTMR', 'DTML'];

/** Snapshot of every user-facing option. Settings persistence and the controls panel read this.
 * @returns {*} Result of the function.
 */
function getState() {
  return {
    units: UNIT_SYSTEMS[useImperialUnits] || 'default',
    skewTSkew: UserSkewNumber,
    hodographNumbers: DisplayHodographNumbers,
    hodographColorTable: HodographColorTable,
    hodographScaleMode: HodographScaleMode,
    hodographTrimWindProfile: HodographTrimWindProfile,
    hodographMode: HodoMode ? 'Relative' : 'Storm',
    readOut: ReadOutOn,
    verticalBarsWindSpeed: !noWSBox,
    showStormMotions: DisplayStormMotions,
    showEhiInWindBox: DisplayEHI,
    showCapeOnMap: DisplayOnMapCape,
    presets: { WindLapse: Presets.WindLapse, Inset: Presets.Inset, Vertical: Presets.Vertical, SidePanel: SidePanelMode },
    presetOverrides: Object.fromEntries(Object.entries(presetOverrides).map(([k, v]) => [k, v || 'auto'])),
    autoPresets: { ...autoPresets },
    efScale: currentEFScale,
    parcel: userSelectedParcel,
    motion: userSelectedMotion,
    defaultParcel,
    defaultMotion,
    customParcelPressure,
    customMotion: { ...customMotionInput },
    exportFormat: SoundingExport,
    frontActive: FrontActive,
    modifyActive: ChangeMod,
    tornadoClimoAvailable,
    vwpActive: VWPActive,
    hasSounding: !!(Snding && Snding.Sounding),
    title: (Snding && Snding.Title) || '',
  };
}

/** Redraw everything for the current sounding, keeping parcel / storm-motion choices.
 * @returns {void} No value.
 */
function redraw() {
  if (!Snding || !Snding.Sounding) return;
  if (VWPActive) {
    DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings, 'VWPSKIP', true);
  } else {
    DrawSkewT(Snding, false, false, false, false, currentComparisonSoundings, CSMot && CSMot.x !== undefined ? CSMot : false);
  }
  CursorReadout(false, true, true);
}

/**
 * Apply several options at once (same keys as getState()) and redraw once.
 * Unknown keys and invalid values are ignored.

 * @param {*} next Parameter for applyState.
 * @param {*} options Parameter for applyState.
 * @returns {*} Result of the function.
 */
function applyState(next = {}, { redraw: doRedraw = true } = {}) {
  if (!next || typeof next !== 'object') return getState();
  if (UNIT_SYSTEMS.includes(next.units)) setSoundingUnits(next.units);
  setSoundingDesignState({
    hodographNumbers: next.hodographNumbers,
    hodographColorTable: next.hodographColorTable,
    hodographScaleMode: next.hodographScaleMode,
    hodographTrimWindProfile: next.hodographTrimWindProfile,
    readOutOn: next.readOut,
    skewTSkew: next.skewTSkew,
  });
  if (next.hodographMode === 'Relative' || next.hodographMode === 'Storm') HodoMode = next.hodographMode === 'Relative';
  if (typeof next.verticalBarsWindSpeed === 'boolean') noWSBox = !next.verticalBarsWindSpeed;
  if (typeof next.showStormMotions === 'boolean') DisplayStormMotions = next.showStormMotions;
  if (typeof next.showEhiInWindBox === 'boolean') DisplayEHI = next.showEhiInWindBox;
  if (typeof next.showCapeOnMap === 'boolean') DisplayOnMapCape= next.showCapeOnMap;
  if (next.efScale === 'EF2+' || next.efScale === 'EF0+') currentEFScale = next.efScale;
  if (['Default', 'SharpJS', 'CM1'].includes(next.exportFormat)) SoundingExport = next.exportFormat;
  if (PARCELS.includes(next.defaultParcel)) defaultParcel = next.defaultParcel;
  if (MOTIONS.includes(next.defaultMotion)) defaultMotion = next.defaultMotion;
  if (next.presetOverrides && typeof next.presetOverrides === 'object') {
    for (const key of Object.keys(presetOverrides)) {
      if (key in next.presetOverrides) {
        const v = next.presetOverrides[key];
        presetOverrides[key] = typeof v === 'string' && v !== 'auto' ? v : null;
      }
    }
    applyPresetOverrides(Snding && Snding.Sounding ? Snding : null);
  }
  if (doRedraw) redraw();
  emit('change');
  return getState();
}

let listenersAttached = false;
/** The calc module keeps storm motion / presets in module state; point it at this chart first.
 * @returns {void} No value.
 */
function syncCalcState() {
  UpdateCSMotStorm(CSMot);
  UpdatePresets(Presets);
}
/** Wraps a chart action with synchronized calculation state.
 * @param {*} fn Parameter for withCalcState.
 * @returns {*} Result of the function.
 */
const withCalcState = (fn) => function (...args) {
  syncCalcState();
  return fn.apply(this, args);
};
const handlers = {
  keyup: withCalcState(onWindowKeyUp),
  keydown: withCalcState(onWindowKeyDown),
  mouseup: withCalcState(onWindowMouseUp),
};

/** Start listening for keyboard / mouse-up events on the window (modify mode, alt-drag).
 * @returns {void} No value.
 */
function attach() {
  if (listenersAttached || typeof window === 'undefined') return;
  for (const [type, fn] of Object.entries(handlers)) window.addEventListener(type, fn);
  listenersAttached = true;
}
/** Remove window listeners and drop per-chart state.
 * @returns {void} No value.
 */
function detach() {
  if (listenersAttached) {
    for (const [type, fn] of Object.entries(handlers)) window.removeEventListener(type, fn);
    listenersAttached = false;
  }
  TurnOff();
  elementCache.clear();
}

// ---------------------------------------------------------------------------------------------
const api = {
  // lifecycle
  attach,
  detach,
  // data in / out
  Load,
  AverageAll,
  CompareSoundings,
  clearComparisons,
  setComparisons,
  applyNexradVwpStoredSounding,
  setVwpActive,
  SetMapImage,
  GetSoundingTextContent,
  DownloadSounding,
  Screenshot,
  // options
  getState,
  applyState,
  redraw,
  setSoundingUnits,
  setSoundingDesignState,
  setPreset,
  setExportFormat,
  ChangeSidePanelMode,
  SetHodoMode,
  SetEFScale,
  ChangeStateSkewTSkew,
  ChangeStateDynamicHodo,
  ChangeStateHodographColorTable,
  ChangeStateHodographNumbers,
  setHodographTrimWindProfile,
  ChangeWBox,
  LoadStormMotions,
  LoadEHIWindBox,
  LoadOnMapCape,
  // analysis controls
  LoadNewParcel,
  LoadNewWind,
  LoadNewSfc,
  LoadNewLapseLyr,
  LoadNewShearLyr,
  ResetSkewT,
  ResetHodograph,
  // cursor tools
  ChangeReadOut,
  setReadOutOnState,
  ChangeFront,
  setFrontActiveState,
  setModifyMode,
  CursorReadout,
  DrawFront,
  // pointer events (bound by viewer/template.js)
  SkewTMouseMoved,
  SkewTMouseDown,
  SkewTWheel,
  Flip,
  HodographMouseMoved,
  HodographMouseDown,
  HodographWheel,
  Front,
  // lower-level drawing, for hosts that compose their own layout
  DrawSkewT,
  DrawHodograph,
  DrawInflowHodo,
  DrawVWPInsets,
  LoadWithParcel,
  GenerateDropSondeLooks,
  RemoteDataStores,
  TurnOff,
  unlockUserSoundingPresets,
  getSnding,
  getInfo,
  getDP,
  getGhost,
  getCurrentComparisonSoundings,
};
// Every API call may change user-facing state; the host diffs getState() to find out.
for (const key of Object.keys(api)) {
  if (key === 'getState') continue;
  const fn = withCalcState(api[key]);
  api[key] = function (...args) {
    const result = fn.apply(this, args);
    emit('change');
    return result;
  };
}
return api;
}
