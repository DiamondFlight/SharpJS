/**
 * Sounding text parsers → SharpJS sounding objects.
 *
 * parseSounding() auto-detects:
 *   - SHARPpy / SharpJS text (%TITLE% … %RAW% … %END%), with or without an OMEGA column
 *   - CM1 input_sounding files
 *   - Chaser Archive JSON ({ level, hght, temp, dwpt, wdir, wspd })
 *   - BUFKIT model files
 *
 * Pure functions: no DOM, no network.
 */
import { Process } from './sharppy.js';
import { isBufkitText, parseBufkit } from './bufkit.js';

export { Process };

/**
 * Parse any supported sounding text into a SharpJS sounding object.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.forecastHour]  BUFKIT only: which forecast hour to pull (default: first in file).
 * @param {string} [options.title]         Override the sounding title.
 * @param {string} [options.fileName]      Used as a hint for BUFKIT model/station names.
 * @returns {object} sounding
 */
export function parseSounding(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('SharpJS: empty sounding text');
  }
  let sounding;
  if (isBufkitText(text)) {
    sounding = parseBufkit(text, options);
  } else {
    const looksSupported =
      text.includes('%RAW%') || text.includes('"level"') || !/\p{L}/u.test(text);
    if (!looksSupported) {
      throw new Error('SharpJS: unrecognized sounding format (expected SHARPpy text, CM1, Chaser Archive JSON or BUFKIT)');
    }
    sounding = Process(text);
  }
  if (!sounding || !sounding.Sounding || sounding.Sounding.Slice.length < 2) {
    throw new Error('SharpJS: sounding has fewer than two usable levels');
  }
  if (options.title) {
    sounding.Title = options.title;
    sounding.STitle = options.title;
  }
  return sounding;
}
