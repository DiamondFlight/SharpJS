import { parseSounding } from './parse.js';
import { fromArrays } from './arrays.js';

export { withLocation } from './location.js';

/** True for a parsed SharpJS sounding object. */
export function isSounding(value) {
  return !!(value && typeof value === 'object' && value.Sounding && Array.isArray(value.Sounding.Slice));
}

/**
 * Accept anything SharpJS can draw and return a parsed sounding:
 *   - text in any format parseSounding() understands
 *   - a parsed sounding (returned as is)
 *   - an arrays object for fromArrays(); it may also carry fromArrays options
 *     (title, location, units, elevation, isModel, isDropsonde)
 * @param {string|object} input
 * @param {object} [options]  passed to parseSounding / fromArrays
 */
export function toSounding(input, options = {}) {
  if (typeof input === 'string') return parseSounding(input, options);
  if (isSounding(input)) return input;
  if (input && typeof input === 'object' && Array.isArray(input.pressure)) {
    return fromArrays(input, { ...input, ...options });
  }
  throw new Error('SharpJS: expected sounding text, a parsed sounding, or { pressure, temperature, … } arrays');
}
