/**
 * Restrict a numeric value to inclusive lower and upper bounds.
 * @param {number} n Value to constrain.
 * @param {number} m Lower bound.
 * @param {number} a Upper bound.
 * @returns {number} Constrained value.
 */
export function clamp(n, m, a) {
  return Math.max(Math.min(n, a), m);
}

/**
 * Check whether a numeric value falls inside the broad range accepted by this module.
 * @param {number} val Value to check.
 * @returns {number} 1 when accepted and 0 when outside the accepted range (in unitless).
 */
export function qc(val) {
  if (val < -998.0 || val > 2.0E+05) return 0;
  return 1;
}

/**
 * Convert an angle from radians to degrees.
 * @param {number} rad Angle (in radians).
 * @returns {number} Angle (in degrees).
 */
export function RadToDeg(rad) {
  return rad * (180 / Math.PI);
}

/**
 * Test whether a value is finite enough for use in a sounding row.
 * @param {number} N Candidate sounding value.
 * @returns {boolean} Whether N is not the missing-value sentinel and is not NaN.
 */
export function QCCheck(N) {
  return (N != -9999 && !isNaN(N));
}

/**
 * Convert a sounding level to the raw seven-column row layout.
 * @param {object} N Level fields P, H, T, D, WD, WS, and WB.
 * @param {*} SP Unused compatibility parameter.
 * @returns {number[]} Raw level values: pressure (in hPa), height (in m), temperature/dewpoint/wet-bulb (in °C), direction (in degrees), and speed (in kt).
 */
export function ConvertToRaw(N, SP) {
  return [N.P, N.H, N.T, N.D, N.WD, N.WS, N.WB];
}

/**
 * Calculate the natural logarithm using log identities.
 * @param {number} x Value to take the logarithm of (in unitless).
 * @returns {number} Natural logarithm of x (in unitless).
 */
export function ln(x) {
  return Math.log(x) / Math.log(Math.E);
}

/**
 * Convert wind speed from knots to meters per second.
 * @param {number} n Wind speed (in kt).
 * @returns {number} Wind speed (in m/s).
 */
export function KTStoMPS(n) {
  return n / 1.94384;
}

/**
 * Linearly interpolate between two numeric values.
 * @param {number} a Starting value.
 * @param {number} b Ending value.
 * @param {number} t Interpolation fraction (in unitless).
 * @returns {number} Interpolated value.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pad a value on the left with zeroes to the requested width.
 * @param {*} n Value to format.
 * @param {number} w Output width (in characters).
 * @returns {string} Zero-padded string.
 */
export function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * Convert a temperature from Celsius to kelvins.
 * @param {number} temperature Temperature (in °C).
 * @returns {number} Temperature (in K).
 */
export function celsiusToKelvin(temperature) {
  return temperature + 273.15;
}

/** An availability callback that always succeeds. */
export function alwaysAvailable() {
  return true;
}

/** A callback that intentionally does nothing. */
export function noop() {}

/**
 * Return the index argument supplied to an array callback.
 * @param {*} value Array element.
 * @param {number} index Element index (in unitless).
 * @returns {number} Element index (in unitless).
 */
export function arrayIndex(value, index) {
  return index;
}

/**
 * Return the absolute value of a number.
 * @param {number} value Number to make nonnegative (in UNK).
 * @returns {number} Absolute value (in UNK).
 */
export function absoluteValue(value) {
  return Math.abs(value);
}
