/**
 * User settings: the options a viewer remembers between visits.
 *
 * Saved settings are always merged over DEFAULT_SETTINGS and validated key by key, so:
 *   - new options added in a later release start at their default without touching the rest,
 *   - options removed in a later release are dropped quietly,
 *   - a bad or hand-edited value falls back to the default instead of breaking the chart.
 * Bump SETTINGS_VERSION and add a step to MIGRATIONS only when a key changes meaning or name.
 */

export const SETTINGS_VERSION = 1;

const oneOf = (...values) => (v) => values.includes(v);
const isBool = (v) => typeof v === 'boolean';
const PRESET_VALUES = {
  WindLapse: ['auto', 'Default', 'Severe', 'Dryline', 'Elevated', 'Winter', 'Fire'],
  Inset: ['auto', 'Default', 'Severe', 'Ambient', 'Winter', 'Fire'],
  Vertical: ['auto', 'Default', 'Winter', 'Fire'],
  SidePanel: ['auto', 'Graph', 'Tornado', 'Winter'],
};

/** key → validator. Every persisted setting must be listed here. */
export const SETTINGS_SCHEMA = {
  units: oneOf('default', 'metric', 'imperial'),
  skewTSkew: oneOf(0.5, 0.625, 0.75, 0.825),
  hodographNumbers: isBool,
  hodographColorTable: oneOf(0, 1, 2, 3),
  hodographScaleMode: oneOf(0, 1, 2),
  hodographTrimWindProfile: isBool,
  hodographMode: oneOf('Relative', 'Storm'),
  readOut: isBool,
  verticalBarsWindSpeed: isBool,
  showStormMotions: isBool,
  presetOverrides: (v) =>
    v !== null && typeof v === 'object' &&
    Object.entries(PRESET_VALUES).every(([k, allowed]) => v[k] === undefined || allowed.includes(v[k])),
  efScale: oneOf('EF2+', 'EF0+'),
  defaultParcel: oneOf('MU', 'SB', 'ML'),
  defaultMotion: oneOf('RM', 'LM', 'MM', 'US', 'DS', 'DTMR', 'DTML'),
  exportFormat: oneOf('Default', 'SharpJS', 'CM1'),
  // Controls-panel preferences (not used by the chart engine itself)
  surfaceTempUnit: oneOf('F', 'C', 'K'),
  lapseLayerMode: oneOf('Hght', 'Pres'),
  shearLayerMode: oneOf('Hght', 'Pres'),
  collapsedSections: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string') && v.length < 50,
};

export const DEFAULT_SETTINGS = Object.freeze({
  units: 'default',
  skewTSkew: 0.75,
  hodographNumbers: false,
  hodographColorTable: 0,
  hodographScaleMode: 0,
  hodographTrimWindProfile: true,
  hodographMode: 'Relative',
  readOut: true,
  verticalBarsWindSpeed: true,
  showStormMotions: false,
  presetOverrides: Object.freeze({ WindLapse: 'auto', Inset: 'auto', Vertical: 'auto', SidePanel: 'auto' }),
  efScale: 'EF2+',
  defaultParcel: 'MU',
  defaultMotion: 'RM',
  exportFormat: 'Default',
  surfaceTempUnit: 'F',
  lapseLayerMode: 'Hght',
  shearLayerMode: 'Hght',
  collapsedSections: Object.freeze([]),
});

export { PRESET_VALUES };

/** Steps from version n to n + 1. MIGRATIONS[1] would upgrade a v1 payload to v2. */
const MIGRATIONS = {};

/** Upgrade a stored payload ({ v, settings }) to the current version. */
export function migrate(payload) {
  if (!payload || typeof payload !== 'object') return {};
  let version = Number.isInteger(payload.v) ? payload.v : 1;
  let settings = payload.settings && typeof payload.settings === 'object' ? { ...payload.settings } : {};
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (step) settings = step(settings);
    version += 1;
  }
  return settings;
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * Merge `input` over `base` keeping only known keys with valid values.
 * presetOverrides is merged per preset so a partial object is fine.
 */
export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const out = clone(base);
  if (!input || typeof input !== 'object') return out;
  for (const [key, valid] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in input)) continue;
    let value = input[key];
    if (key === 'presetOverrides' && value && typeof value === 'object') {
      value = { ...out.presetOverrides, ...value };
    }
    if (valid(value)) out[key] = clone(value);
  }
  return out;
}

/** Only the keys whose values differ from DEFAULT_SETTINGS (what actually needs storing). */
export function diffFromDefaults(settings) {
  const out = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])) out[key] = clone(settings[key]);
  }
  return out;
}
