
class BufReader {
  constructor(bytes) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }

  u16(off) { return this.view.getUint16(off, false); } // big-endian
  i16(off) { return this.view.getInt16(off, false); }
  u32(off) { return this.view.getUint32(off, false); }
  i32(off) { return this.view.getInt32(off, false); }

  slice(start, end) {
    const sub = this.bytes.subarray(start, end);
    return new BufReader(sub);
  }

  ascii(start, len) {
    let s = '';
    const end = Math.min(start + len, this.length);
    for (let i = start; i < end; i++) s += String.fromCharCode(this.bytes[i]);
    return s;
  }
}

// ─── Zlib inflate (portable) ─────────────────────────────────────────────────

let _inflate;

/**
 * Decompress a zlib-compressed product using the available runtime implementation.
 * @param {Uint8Array|ArrayBuffer} bytes Compressed product bytes (in bytes).
 * @returns {Uint8Array} Decompressed product bytes.
 */
function inflate(bytes) {
  // Node.js — use built-in zlib (getBuiltinModule works from ES modules, Node ≥ 20.16)
  const zlib = typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('node:zlib')
    : null;
  if (zlib) {
    try {
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const nodeResult = zlib.inflateSync(Buffer.from(input));
      return new Uint8Array(nodeResult.buffer, nodeResult.byteOffset, nodeResult.byteLength);
    } catch (_) { /* fall through */ }
  }
  // Browser — use DecompressionStream (available in all modern browsers)
  if (typeof DecompressionStream !== 'undefined') {
    // DecompressionStream is async; we use a sync workaround via raw inflate
    // Since DecompressionStream is stream-based, we need a sync path.
    // Fall back to a tiny inline inflate implementation.
  }
  // Minimal sync inflate — use pako if available
  if (typeof globalThis.pako !== 'undefined') {
    return globalThis.pako.inflate(bytes);
  }
  throw new Error(
    'Zlib decompression needed but no runtime support found. ' +
    'In the browser, add pako: <script src="https://cdn.jsdelivr.net/npm/pako/dist/pako_inflate.min.js"></script> ' +
    'or import pako and set globalThis.pako = pako. ' +
    'Uncompressed VWP files (most real-time feeds) work without this.'
  );
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MSG_CODE_VWP = 48;
const PACKET_WIND_BARB = 0x0004;
const PACKET_TEXT = 0x0008;
const PACKET_VECTOR = 0x000A;

// Color code → RMS error (knots), per RPG ICD / vad-plotter
const COLOR_TO_RMS = { 1: 2, 2: 6, 3: 10, 4: 14, 5: 18 };

// 4/3 effective Earth radius in km (standard radar beam propagation model)
const R_E = (4 / 3) * 6371;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a NEXRAD Level III VWP product.
 * @param {Uint8Array|ArrayBuffer|Buffer} raw - Raw file bytes.
 * @returns {object} Structured wind profile data.
 */
function parseVWP(raw) {
  const buf = unwrap(raw);

  // ── Message Header Block (18 bytes) ──
  const msgCode = buf.u16(0);
  if (msgCode !== MSG_CODE_VWP) {
    throw new Error(
      `Not a VWP product (message code ${msgCode}, expected ${MSG_CODE_VWP}). ` +
      `This parser only handles product 48 (VAD Wind Profile).`
    );
  }

  // ── Product Description Block (102 bytes starting at offset 18) ──
  const pdb = parsePDB(buf, 18);
  const radarHeightKm = pdb.height * 0.0003048; // ft → km

  // ── Try tabular block first (preferred — matches vad-plotter) ──
  const tabOff = findBlock(buf, 3);
  let tabData = null;
  let metadata = {};
  if (tabOff !== -1) {
    const tabResult = parseTabularFull(buf, tabOff, radarHeightKm);
    tabData = tabResult.winds;
    metadata = tabResult.metadata;
  }

  // ── Fall back to symbology block if tabular is empty/missing ──
  const symOff = findBlock(buf, 1);
  let symData = null;
  if (symOff !== -1) {
    symData = parseSymbologyWinds(buf, symOff, pdb);
  }

  // Prefer tabular (like vad-plotter), fall back to symbology
  const useTabular = tabData && tabData.length > 0;
  const winds = useTabular ? tabData : (symData || []);
  const source = useTabular ? 'tabular' : 'symbology';

  // ── Group into profiles by time ──
  const profiles = {};
  for (const w of winds) {
    if (!profiles[w.time]) profiles[w.time] = [];
    profiles[w.time].push({
      altitude_km_agl: w.altitude_km_agl,
      altitude_ft_msl: w.altitude_ft_msl,
      direction_deg: w.direction_deg,
      speed_kts: w.speed_kts,
      rms_kts: w.rms_kts,
      divergence: w.divergence,
      slant_range_nm: w.slant_range_nm,
      elev_angle_deg: w.elev_angle_deg,
    });
  }
  for (const key of Object.keys(profiles)) {
    profiles[key].sort((a, b) => a.altitude_km_agl - b.altitude_km_agl);
  }

  // Ordered time list (most recent first)
  const times = Object.keys(profiles).sort((a, b) => {
    return parseInt(b, 10) - parseInt(a, 10);
  });

  // If we only got symbology, still try to get adaptation params from tabular
  if (!useTabular && tabOff !== -1) {
    const tabResult = parseTabularFull(buf, tabOff, radarHeightKm);
    Object.assign(metadata, tabResult.metadata);
  }

  return {
    radar: {
      latitude: pdb.latitude,
      longitude: pdb.longitude,
      height_ft: pdb.height,
      vcp: pdb.vcp,
      mode: pdb.opMode === 1 ? 'clear_air' : 'precipitation',
    },
    scan: {
      volume_time: nexradDate(pdb.volDate, pdb.volTime),
      generation_time: nexradDate(pdb.genDate, pdb.genTime),
    },
    source,
    times,
    profiles,
    metadata,
  };
}

// ─── Unwrapping ──────────────────────────────────────────────────────────────

/**
 * Remove transport headers and decompress a raw NEXRAD product when needed.
 * @param {Uint8Array|ArrayBuffer|Buffer} raw Product data from the feed (in bytes).
 * @returns {BufReader} Reader positioned at the NEXRAD message header.
 */
function unwrap(raw) {
  let buf = new BufReader(raw);

  // Strip text WMO/AWIPS header (lines ending \r\r\n)
  const textEnd = findTextHeaderEnd(buf);
  if (textEnd > 0) buf = buf.slice(textEnd, buf.length);

  // Decompress zlib if present
  if (buf.length > 2 && buf.bytes[0] === 0x78 &&
      (buf.bytes[1] === 0xDA || buf.bytes[1] === 0x9C || buf.bytes[1] === 0x01)) {
    const decompressed = inflate(buf.bytes);
    buf = new BufReader(decompressed);
  }

  // After decompression there may be NOAAPORT routing + another WMO header.
  if (buf.u16(0) !== MSG_CODE_VWP) {
    const off = findMessageStart(buf);
    if (off === -1) throw new Error('Could not locate VWP message header in buffer');
    buf = buf.slice(off, buf.length);
  }

  return buf;
}

/**
 * Locate the end of a leading WMO/AWIPS text header.
 * @param {BufReader} buf Product bytes.
 * @returns {number} Header end offset (in bytes), or 0 when no delimiter is found.
 */
function findTextHeaderEnd(buf) {
  let last = 0;
  const limit = Math.min(buf.length - 2, 300);
  for (let i = 0; i < limit; i++) {
    if (buf.bytes[i] === 0x0D && buf.bytes[i + 1] === 0x0D && buf.bytes[i + 2] === 0x0A) {
      last = i + 3;
      if (last < buf.length) {
        const next = buf.bytes[last];
        if (next === 0x78 || next === 0x00) return last;
      }
    }
  }
  return last;
}

/**
 * Find a valid VWP message header inside a routed or padded byte buffer.
 * @param {BufReader} buf Product bytes to search.
 * @returns {number} Message start offset (in bytes), or -1 when no VWP message is found.
 */
function findMessageStart(buf) {
  for (let i = 0; i < buf.length - 20; i++) {
    if (buf.u16(i) === MSG_CODE_VWP) {
      const date = buf.u16(i + 2);
      if (date > 10000 && date < 35000) {
        if (i + 18 < buf.length && buf.u16(i + 18) === 0xFFFF) {
          return i;
        }
      }
    }
  }
  return -1;
}

// ─── Product Description Block ───────────────────────────────────────────────

/**
 * Read radar and volume metadata from a NEXRAD Product Description Block.
 * @param {BufReader} buf Product bytes.
 * @param {number} offset PDB start offset (in bytes).
 * @returns {object} Radar metadata with latitude/longitude (in degrees), height (in ft), product/VCP codes, and volume/generation dates and times.
 */
function parsePDB(buf, offset) {
  const o = offset;
  return {
    latitude: buf.i32(o + 2) / 1000,
    longitude: buf.i32(o + 6) / 1000,
    height: buf.i16(o + 10),
    productCode: buf.u16(o + 12),
    opMode: buf.u16(o + 14),
    vcp: buf.u16(o + 16),
    volDate: buf.u16(o + 22),
    volTime: buf.u32(o + 24),
    genDate: buf.u16(o + 28),
    genTime: buf.u32(o + 30),
  };
}

// ─── Block / Packet parsing ──────────────────────────────────────────────────

/**
 * Find a length-validated NEXRAD product block by identifier.
 * @param {BufReader} buf Product bytes.
 * @param {number} blockId Block identifier (in unitless).
 * @returns {number} Block offset (in bytes), or -1 when absent.
 */
function findBlock(buf, blockId) {
  for (let i = 0; i < buf.length - 8; i += 2) {
    if (buf.u16(i) === 0xFFFF && buf.u16(i + 2) === blockId) {
      const len = buf.u32(i + 4);
      if (len > 0 && len < 500000) return i;
    }
  }
  return -1;
}

// ─── Symbology Block (fallback path) ─────────────────────────────────────────

/**
 * Decode wind barbs and chart labels from the symbology block fallback.
 * @param {BufReader} buf Product bytes.
 * @param {number} offset Symbology block offset (in bytes).
 * @param {object} pdb Parsed product description, including radar height (in ft).
 * @returns {object[]} Wind levels with altitude (in km AGL and ft MSL), direction (in degrees), and speed/error (in kt).
 */
function parseSymbologyWinds(buf, offset, pdb) {
  const blockLen = buf.u32(offset + 4);
  const blockEnd = Math.min(offset + 8 + blockLen, buf.length);
  let pos = offset + 16;

  const windBarbs = [];
  const textLabels = [];
  const vectorPackets = [];

  while (pos + 4 <= blockEnd) {
    const code = buf.u16(pos);
    const len = buf.u16(pos + 2);
    if (len === 0 || len > 50000 || pos + 4 + len > buf.length) break;

    const d = pos + 4;

    if (code === PACKET_WIND_BARB && len === 10) {
      windBarbs.push({
        color: buf.u16(d),
        i: buf.u16(d + 2),
        j: buf.u16(d + 4),
        direction_deg: buf.u16(d + 6),
        speed_kts: buf.u16(d + 8),
      });
    } else if (code === PACKET_TEXT && len >= 8) {
      textLabels.push({
        color: buf.u16(d),
        i: buf.u16(d + 2),
        j: buf.u16(d + 4),
        text: buf.ascii(d + 6, len - 6).trim(),
      });
    } else if (code === PACKET_VECTOR) {
      const vectors = [];
      for (let v = d + 2; v + 8 <= d + len; v += 8) {
        vectors.push({
          i0: buf.u16(v), j0: buf.u16(v + 2),
          i1: buf.u16(v + 4), j1: buf.u16(v + 6),
        });
      }
      vectorPackets.push({ color: buf.u16(d), vectors });
    }

    pos = d + len;
  }

  // ── Altitude map from tick marks + text labels ──
  const altLabelsFileOrder = textLabels
    .filter(l => (l.i === 31 || l.i < 40))
    .map(l => parseInt(l.text, 10))
    .filter(n => !isNaN(n) && n >= 1 && n <= 70);

  let altMap = {};
  if (vectorPackets.length >= 2 && altLabelsFileOrder.length > 0) {
    const ticks = vectorPackets[1].vectors.map(v => v.j0).reverse();
    if (ticks.length === altLabelsFileOrder.length) {
      for (let k = 0; k < ticks.length; k++) {
        altMap[ticks[k]] = altLabelsFileOrder[k];
      }
    }
  }

  if (Object.keys(altMap).length === 0) {
    for (const l of textLabels) {
      if (l.i === 31 || l.i < 40) {
        const n = parseInt(l.text, 10);
        if (!isNaN(n) && n >= 1 && n <= 70) altMap[l.j] = n;
      }
    }
  }

  // ── Time map ──
  const timeRef = textLabels.find(l => l.text === 'TIME');
  const timeJ = timeRef ? timeRef.j : 490;
  const timeLabelMap = {};
  for (const l of textLabels) {
    if (/^\d{4}$/.test(l.text) && Math.abs(l.j - timeJ) < 20) {
      timeLabelMap[l.i] = l.text;
    }
  }
  const timeIs = Object.keys(timeLabelMap).map(Number).sort((a, b) => b - a);

  // ── Map wind barbs → winds ──
  const radarElFt = pdb.height;
  const winds = [];

  for (const barb of windBarbs) {
    const timeI = nearestVal(timeIs, barb.i, 30);
    if (timeI === null) continue;
    const time = timeLabelMap[timeI];

    const altJs = Object.keys(altMap).map(Number);
    const altJ = nearestVal(altJs, barb.j, 20);
    if (altJ === null) continue;
    const altKft = altMap[altJ];

    const altKmAgl = (altKft - radarElFt / 1000) / 3.281;

    winds.push({
      time,
      altitude_km_agl: Math.round(altKmAgl * 1000) / 1000,
      altitude_ft_msl: altKft * 1000,
      direction_deg: barb.direction_deg,
      speed_kts: barb.speed_kts,
      rms_kts: COLOR_TO_RMS[barb.color] || null,
      divergence: null,
      slant_range_nm: null,
      elev_angle_deg: null,
    });
  }

  return winds;
}

// ─── Tabular Block (preferred path) ──────────────────────────────────────────

/**
 * Decode the tabular VAD output and its adaptation metadata.
 * @param {BufReader} buf Product bytes.
 * @param {number} offset Tabular block offset (in bytes).
 * @param {number} radarHeightKm Radar height above mean sea level (in km).
 * @returns {{winds: object[], metadata: object}} Wind levels (altitude in km AGL/ft MSL, direction in degrees, speed/error in kt, range in nmi, elevation in degrees) and parsed thresholds.
 */
function parseTabularFull(buf, offset, radarHeightKm) {
  const blockLen = buf.u32(offset + 4);
  const blockEnd = Math.min(offset + 8 + blockLen, buf.length);

  // Skip block header(8) + dup MHB(18) + dup PDB(102) + divider(2) = 130 bytes
  let pos = offset + 130;

  if (pos + 2 > blockEnd) return { winds: [], metadata: {} };

  const numPages = buf.i16(pos);
  pos += 2;

  if (numPages <= 0 || numPages > 100) return { winds: [], metadata: {} };

  const pages = [];
  let currentPage = [];
  while (pos + 2 <= blockEnd) {
    const numChars = buf.i16(pos);
    pos += 2;
    if (numChars === -1) {
      if (currentPage.length > 0) pages.push(currentPage);
      currentPage = [];
      continue;
    }
    if (numChars <= 0 || numChars > 200 || pos + numChars > blockEnd) {
      pos += Math.max(numChars, 0);
      continue;
    }
    currentPage.push(buf.ascii(pos, numChars));
    pos += numChars;
  }
  if (currentPage.length > 0) pages.push(currentPage);

  const winds = [];
  const metadata = {};

  for (const page of pages) {
    if (page.length > 0 && page[0].includes('VAD Algorithm Output')) {
      const timeMatch = page[0].match(/(\d{2}):(\d{2})/);
      const time = timeMatch ? timeMatch[1] + timeMatch[2] : 'unknown';

      for (let i = 3; i < page.length; i++) {
        const line = page[i].trim();
        if (!line || line.startsWith('-')) continue;
        const vals = line.split(/\s+/);
        if (vals.length < 10) continue;

        const windDir = parseFloat(vals[4]);
        const windSpd = parseFloat(vals[5]);
        const rmsError = parseFloat(vals[6]);
        const divStr = vals[7];
        const divergence = divStr === 'NA' ? null : parseFloat(divStr);
        const slantRange = parseFloat(vals[8]);
        const elevAngle = parseFloat(vals[9]);

        if (isNaN(windDir) || isNaN(windSpd) || isNaN(slantRange) || isNaN(elevAngle)) continue;

        const slantKm = slantRange * 6067.1 / 3281.0;
        const elevRad = elevAngle * Math.PI / 180;
        const altKm = Math.sqrt(
          R_E * R_E + slantKm * slantKm + 2 * R_E * slantKm * Math.sin(elevRad)
        ) - R_E;
        const altKmAgl = Math.round(altKm * 1000) / 1000;

        const altFtMsl = parseInt(vals[0], 10) * 100;

        winds.push({
          time,
          altitude_km_agl: altKmAgl,
          altitude_ft_msl: isNaN(altFtMsl) ? null : altFtMsl,
          direction_deg: windDir,
          speed_kts: windSpd,
          rms_kts: isNaN(rmsError) ? null : rmsError,
          divergence,
          slant_range_nm: slantRange,
          elev_angle_deg: elevAngle,
        });
      }
    }

    const fullText = page.join('\n');
    const m1 = fullText.match(/RMS THRESHOLD\s+([\d.]+)\s+KNOTS/);
    if (m1) metadata.rms_threshold_kts = parseFloat(m1[1]);
    const m2 = fullText.match(/SYMMETRY THRESHOLD\s+([\d.]+)\s+KNOTS/);
    if (m2) metadata.symmetry_threshold_kts = parseFloat(m2[1]);
    const m3 = fullText.match(/DATA POINTS THRESHOLD\s+(\d+)/);
    if (m3) metadata.data_points_threshold = parseInt(m3[1], 10);
    const m4 = fullText.match(/OPTIMUM SLANT RANGE\s+([\d.]+)/);
    if (m4) metadata.optimum_slant_range_nm = parseFloat(m4[1]);
  }

  return { winds, metadata };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the array value nearest to a target when it is within the allowed distance.
 * @param {number[]} arr Candidate numeric values
 * @param {number} target Target value
 * @param {number} maxDist Maximum accepted absolute distance
 * @returns {number|null} Nearest candidate, or null when none is close enough.
 */
function nearestVal(arr, target, maxDist) {
  let best = null;
  let bestDist = Infinity;
  for (const v of arr) {
    const dist = Math.abs(v - target);
    if (dist < bestDist) { bestDist = dist; best = v; }
  }
  return bestDist <= maxDist ? best : null;
}

/**
 * Convert a NEXRAD epoch-based Julian day and seconds-of-day to an ISO timestamp.
 * @param {number} julianDate One-based day count since 1970-01-01 UTC (in days).
 * @param {number} seconds Seconds elapsed in the day (in seconds).
 * @returns {string} UTC timestamp in ISO 8601 format.
 */
function nexradDate(julianDate, seconds) {
  // NEXRAD Julian date is 1-based (day 1 = 1970-01-01 UTC); Unix ms uses 0-based day count.
  // Matches e.g. MetPy nexrad_to_datetime(julian_date - 1, ...).
  const dayIndex = Math.max(0, julianDate - 1);
  const ms = dayIndex * 86400000 + seconds * 1000;
  return new Date(ms).toISOString();
}

// ─── Exports (dual CJS/ESM) ─────────────────────────────────────────────────

export { parseVWP };