// Type declarations for SharpJS. The library itself is plain JavaScript (ES modules).

// ───────────────────────────────── soundings ─────────────────────────────────

/** Parsed sounding. `Sounding.Slice` rows are [pres mb, hght m, temp °C, dwpt °C, wdir °, wspd kt, wetbulb °C, omega]. */
export interface Sounding {
  Title: string;
  STitle: string;
  Sounding: {
    P: number[];
    H: number[];
    T: number[];
    D: number[];
    W: Array<{ WD: number; WS: number; H: number }>;
    TW: Array<{ T: number; VT: number; WB: number; P: number; H: number }>;
    DW: Array<{ D: number; P: number; H: number }>;
    Slice: number[][];
    OMEGA: number[];
    [key: string]: unknown;
  };
  /** [lat, lon] (negative west) when known. */
  Location?: [number, number] | false;
  /** [lat, west-positive lon]; used by the tornado climatology panel. */
  Location2?: [number, number];
  Coords?: { lat: number; lon: number };
  isDropsonde?: boolean;
  meta?: { source?: string; isModel?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ArraysProfile {
  /** hPa (mb) */
  pressure: ArrayLike<number | null>;
  /** m above sea level (computed from temperature and pressure when omitted) */
  height?: ArrayLike<number | null>;
  temperature: ArrayLike<number | null>;
  dewpoint?: ArrayLike<number | null>;
  /** % (used when dewpoint is not given) */
  relativeHumidity?: ArrayLike<number | null>;
  /** degrees the wind blows from */
  windDirection?: ArrayLike<number | null>;
  windSpeed?: ArrayLike<number | null>;
  u?: ArrayLike<number | null>;
  v?: ArrayLike<number | null>;
  /** Pa/s */
  omega?: ArrayLike<number | null>;
}

export interface ArraysOptions {
  title?: string;
  location?: { lat: number; lon: number };
  /** Surface height (m) used when heights are computed. */
  elevation?: number;
  units?: { temperature?: 'C' | 'K' | 'F'; windSpeed?: 'kt' | 'm/s' | 'mph' | 'km/h' };
  /** Gridded model output: skip the hodograph thinning used for dense observations. */
  isModel?: boolean;
  isDropsonde?: boolean;
}

/** Anything SharpJS can draw: text in a supported format, a parsed sounding, or arrays. */
export type SoundingInput = string | Sounding | (ArraysProfile & ArraysOptions);

export interface ParseOptions {
  /** BUFKIT: forecast hour to read (default: first in the file). */
  forecastHour?: number;
  title?: string;
  /** Hint for BUFKIT model / station names, e.g. "rap_kdsm.buf". */
  fileName?: string;
}

export function parseSounding(text: string, options?: ParseOptions): Sounding;
export function fromArrays(profile: ArraysProfile, options?: ArraysOptions): Sounding;
export function toSounding(input: SoundingInput, options?: ParseOptions & ArraysOptions): Sounding;
export function isSounding(value: unknown): value is Sounding;
export function withLocation(sounding: Sounding, location: { lat: number; lon: number }): Sounding;
export function Process(text: string): Sounding;

export type ExportFormat = 'Default' | 'SharpJS' | 'CM1';
export const EXPORT_FORMATS: Record<ExportFormat, string>;
export interface ExportOptions { savedBy?: string; filePrefix?: string }
export function exportSounding(sounding: Sounding, format?: ExportFormat, options?: ExportOptions): { text: string; filename: string } | null;
export function toSharppyText(sounding: Sounding, withOmega: boolean, options?: ExportOptions): { text: string; filename: string };
export function toCm1Text(sounding: Sounding): { text: string; filename: string };

export function isBufkitText(text: string): boolean;
export function listBufkitForecastHours(text: string): number[];
export function parseBufkit(text: string, options?: { forecastHour?: number; model?: string; station?: string; fileName?: string }): Sounding;
export function parseIemRaob(json: unknown, index?: number): Sounding;
export function parseVWP(raw: ArrayBuffer | Uint8Array): unknown;
export function buildVwpSounding(
  input: ArrayBuffer | Uint8Array | object,
  options?: { radar?: string; background?: Sounding; resample?: boolean },
): Sounding | null;

// ───────────────────────────────── analysis ─────────────────────────────────

export interface Wind { direction: number | null; speed: number | null }

export interface ParcelSummary {
  startPressure: number | null;
  startHeight: number | null;
  cape: number | null;
  cin: number | null;
  cape3km: number | null;
  cape6km: number | null;
  ecape: number | null;
  ncape: number | null;
  /** heights in m AGL */
  lcl: number | null;
  lfc: number | null;
  el: number | null;
  mpl: number | null;
}

export interface LayerKinematics {
  srh: number | null;
  bulkShear: Wind | null;
  meanWind: Wind | null;
  stormRelativeWind: Wind | null;
  ehi: number | null;
}

export type MotionName = 'RM' | 'LM' | 'MM' | 'US' | 'DS' | 'DTMR' | 'DTML';
export type ParcelName = 'SB' | 'ML' | 'MU' | 'CU';

export interface AnalyzeOptions {
  parcel?: ParcelName;
  parcelPressure?: number;
  motion?: MotionName | { direction: number; speed: number };
}

export interface Analysis {
  title: string;
  surface: { pressure: number | null; height: number | null; temperature: number | null; dewpoint: number | null; windDirection: number | null; windSpeed: number | null };
  parcels: { SB: ParcelSummary; ML: ParcelSummary; MU: ParcelSummary; CU?: ParcelSummary };
  downdraft: { dcape: number | null; downdraftTempF: number | null };
  stormMotion: { used: Wind | null } & Record<MotionName, Wind | null>;
  effectiveInflow: null | {
    bottomPressure: number | null;
    topPressure: number | null;
    bottomHeightAgl: number | null;
    topHeightAgl: number | null;
    srh: number | null;
    bulkShear: Wind | null;
    ebwd: Wind | null;
    meanWind: Wind | null;
    stormRelativeWind: Wind | null;
    ehi: number | null;
  };
  kinematics: { layers: Record<string, LayerKinematics> };
  indices: Record<
    | 'stpFixed' | 'stpEffective' | 'scp' | 'ship' | 'sigSevere' | 'wndg' | 'derecho' | 'pwat' | 'kIndex'
    | 'totalTotals' | 'freezingLevel' | 'meanMixingRatio' | 'convectiveTempF' | 'maxTempF' | 'lclTempF'
    | 'theta3kmDiff' | 'rhSurface' | 'rhLow' | 'rhMid' | 'rhDgzMean',
    number | null
  >;
  raw: Record<string, unknown>;
}

export function analyze(input: SoundingInput, options?: AnalyzeOptions): Analysis;
export function levelAt(
  input: SoundingInput,
  query: { pressure?: number; height?: number; agl?: boolean },
): { pressure: number | null; height: number | null; temperature: number | null; dewpoint: number | null; windDirection: number | null; windSpeed: number | null; wetbulb: number | null; virtualTemperature: number | null };

// ───────────────────────────────── settings ─────────────────────────────────

export type PresetValue<T extends string> = 'auto' | T;

export interface Settings {
  units: 'default' | 'metric' | 'imperial';
  skewTSkew: 0.5 | 0.625 | 0.75 | 0.825;
  hodographNumbers: boolean;
  hodographColorTable: 0 | 1 | 2 | 3;
  hodographScaleMode: 0 | 1 | 2;
  hodographTrimWindProfile: boolean;
  hodographMode: 'Relative' | 'Storm';
  readOut: boolean;
  verticalBarsWindSpeed: boolean;
  showStormMotions: boolean;
  showEhiInWindBox: boolean;
  presetOverrides: {
    WindLapse: PresetValue<'Default' | 'Severe' | 'Dryline' | 'Elevated' | 'Winter' | 'Fire'>;
    Inset: PresetValue<'Default' | 'Severe' | 'Ambient' | 'Winter' | 'Fire'>;
    Vertical: PresetValue<'Default' | 'Winter' | 'Fire'>;
    SidePanel: PresetValue<'Graph' | 'Tornado' | 'Winter'>;
  };
  efScale: 'EF2+' | 'EF0+';
  defaultParcel: 'MU' | 'SB' | 'ML';
  defaultMotion: MotionName;
  exportFormat: ExportFormat;
  surfaceTempUnit: 'F' | 'C' | 'K';
  lapseLayerMode: 'Hght' | 'Pres';
  shearLayerMode: 'Hght' | 'Pres';
  collapsedSections: string[];
}

export interface SettingsPayload { v: number; settings: Partial<Settings> }

/** Where settings are stored. load/save may be async (e.g. a user profile on your server). */
export interface StorageAdapter {
  kind?: string;
  available?(): boolean;
  load(): SettingsPayload | null | Promise<SettingsPayload | null>;
  save(payload: SettingsPayload): void | Promise<void>;
  clear?(): void | Promise<void>;
}

export type PersistOption = boolean | 'auto' | 'local' | 'cookie' | 'memory' | StorageAdapter;

export interface SettingsStore {
  readonly ready: Promise<Settings>;
  readonly storage: string;
  get(): Settings;
  set(partial: Partial<Settings>, options?: { save?: boolean; silent?: boolean }): boolean;
  reset(): Settings;
  subscribe(fn: (settings: Settings) => void): () => void;
}

export const SETTINGS_VERSION: number;
export const DEFAULT_SETTINGS: Readonly<Settings>;
export const SETTINGS_SCHEMA: Record<keyof Settings, (value: unknown) => boolean>;
export const PRESET_VALUES: Record<'WindLapse' | 'Inset' | 'Vertical' | 'SidePanel', string[]>;
export function sanitizeSettings(input: unknown, base?: Settings): Settings;
export function diffFromDefaults(settings: Settings): Partial<Settings>;
export function migrate(payload: unknown): Partial<Settings>;
export function createSettingsStore(options?: { persist?: PersistOption; key?: string; defaults?: Partial<Settings>; overrides?: Partial<Settings> }): SettingsStore;
export function localStorageAdapter(key?: string): StorageAdapter;
export function cookieAdapter(name?: string, options?: { days?: number; path?: string; sameSite?: string; domain?: string }): StorageAdapter;
export function memoryAdapter(initial?: SettingsPayload | null): StorageAdapter;
export function autoAdapter(key?: string): StorageAdapter;
export function resolveAdapter(persist: PersistOption, key?: string): StorageAdapter;

// ───────────────────────────────── viewer ─────────────────────────────────

export interface ChartState extends Pick<Settings,
  'units' | 'skewTSkew' | 'hodographNumbers' | 'hodographColorTable' | 'hodographScaleMode' | 'hodographTrimWindProfile'
  | 'hodographMode' | 'readOut' | 'verticalBarsWindSpeed' | 'showStormMotions' | 'showEhiInWindBox' | 'presetOverrides' | 'efScale'
  | 'defaultParcel' | 'defaultMotion' | 'exportFormat'> {
  presets: { WindLapse: string; Inset: string; Vertical: string; SidePanel: string };
  autoPresets: { WindLapse: string; Inset: string; Vertical: string; SidePanel: string };
  parcel: ParcelName;
  motion: MotionName | 'CM';
  customParcelPressure: number;
  customMotion: { direction: number; speed: number };
  frontActive: boolean;
  modifyActive: boolean;
  tornadoClimoAvailable: boolean;
  vwpActive: boolean;
  hasSounding: boolean;
  title: string;
}

export interface Comparison {
  sounding: SoundingInput;
  color?: string;
  label?: string;
  visible?: boolean;
}

export interface Sources {
  fetchIemRaob?(query: { station: string; time: Date | string | number }): Promise<Sounding>;
  fetchIemBufkit?(query: { model?: string; station: string; run: Date | string | number; forecastHour?: number }): Promise<Sounding>;
  fetchNexradVwp?(query: { radar: string; time?: Date | string | number; background?: Sounding }): Promise<Sounding>;
}

export interface SharpJSProps {
  /** The sounding to draw (null clears the chart). */
  sounding?: SoundingInput | null;
  /** Same key as the previous sounding = same place, new time: keep parcel / motion choices. */
  soundingKey?: string;
  title?: string;
  location?: { lat: number; lon: number };
  comparisons?: Comparison[] | null;
  /** NEXRAD VWP sounding (buildVwpSounding / fetchNexradVwp) or raw NVW bytes; null returns to the sounding. */
  vwp?: Sounding | ArrayBuffer | Uint8Array | null;
  /** Image drawn in the corner of the hodograph (e.g. a map around the sounding). */
  mapImage?: CanvasImageSource | null;
  /** Initial / forced settings (over saved ones). */
  settings?: Partial<Settings>;
  /** Defaults under saved settings. */
  defaultSettings?: Partial<Settings>;
  /** Where settings are remembered. Default "auto": localStorage, else a cookie. */
  persist?: PersistOption;
  storageKey?: string;
  /** Built-in controls panel (default true). */
  controls?: boolean | { raobStation?: string; bufkitStation?: string; vwpRadar?: string };
  /** Public data loaders for the controls' Archive section, e.g. `import * as sources from 'sharpjs/sources'`. */
  sources?: Sources | null;
  /** Your label in the chart credit: "<label> - powered by SharpJS v1.7". */
  brandLabel?: string;
  /** "Saved by:" line in exported text. */
  savedBy?: string;
  filePrefix?: string;
  font?: string;
  fileDrop?: boolean;
  injectStyles?: boolean;
  className?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  onChange?(state: ChartState): void;
  onSettingsChange?(settings: Settings): void;
  onLoad?(sounding: Sounding): void;
  onError?(error: Error): void;
}

export interface SharpJSHandle {
  readonly version: string;
  readonly element: HTMLElement;
  /** Lower-level chart engine (see src/viewer/engine.js). */
  readonly engine: Engine;
  readonly settings: SettingsStore;
  update(props: SharpJSProps): SharpJSHandle;
  load(input: SoundingInput, options?: { title?: string; key?: string; reset?: boolean; location?: { lat: number; lon: number }; parseOptions?: ParseOptions }): Sounding | null;
  clear(): void;
  compare(inputs: SoundingInput | Comparison | Array<SoundingInput | Comparison>): void;
  setComparisons(list: Comparison[]): void;
  clearComparisons(): void;
  average(texts: string[]): void;
  setVwp(input: Sounding | ArrayBuffer | Uint8Array | null, options?: { radar?: string }): Sounding | null;
  loadFiles(files: FileList | File[], mode?: 'auto' | 'compare' | 'average'): Promise<void>;
  getSounding(): Sounding | null;
  getState(): ChartState;
  getSettings(): Settings;
  setSettings(partial: Partial<Settings>): boolean;
  resetSettings(): Settings;
  analysis(options?: AnalyzeOptions): Analysis | null;
  exportText(format?: ExportFormat): { text: string; filename: string } | null;
  downloadText(format?: ExportFormat): { text: string; filename: string } | null;
  screenshot(options?: { scale?: number }): Promise<string | null>;
  downloadImage(options?: { scale?: number }): Promise<string | null>;
  copyImage(options?: { scale?: number }): Promise<boolean>;
  on(event: 'change', fn: (state: ChartState) => void): () => void;
  on(event: 'settingsChange', fn: (settings: Settings) => void): () => void;
  on(event: 'load', fn: (sounding: Sounding) => void): () => void;
  on(event: 'error', fn: (error: Error) => void): () => void;
  redraw(): void;
  destroy(): void;
}

/** Draw (or update) an interactive sounding in `target`. */
export function SharpJS(target: Element | string, props?: SharpJSProps): SharpJSHandle;
export namespace SharpJS {
  function get(target: Element | string): SharpJSHandle | null;
  const version: string;
}
export default SharpJS;

/** The chart engine behind SharpJS(); most hosts never need it. */
export interface Engine {
  getState(): ChartState;
  applyState(state: Partial<Settings>, options?: { redraw?: boolean }): ChartState;
  redraw(): void;
  setPreset(type: 'WindLapse' | 'Inset' | 'Vertical' | 'SidePanel', value: string): void;
  LoadNewParcel(parcel: ParcelName, pressure?: number): void;
  LoadNewWind(motion: MotionName | 'CM', redraw?: boolean, custom?: { direction?: number; speed?: number } | null): void;
  LoadNewSfc(mode: 'New' | 'Old', kind: 'tmp' | 'wnd', values?: { temperature?: number; dewpoint?: number; unit?: 'F' | 'C' | 'K'; direction?: number; speed?: number }): void;
  LoadNewLapseLyr(mode: 'N' | 'R', values?: { bottom?: number | string; top?: number | string; mode?: 'Hght' | 'Pres' }): void;
  LoadNewShearLyr(mode: 'N' | 'R', values?: { bottom?: number | string; top?: number | string; mode?: 'Hght' | 'Pres' }): void;
  [method: string]: unknown;
}
export function createEngine(root: HTMLElement, options?: { brandLabel?: string; savedBy?: string; filePrefix?: string; font?: string; emit?: (type: string, detail?: unknown) => void }): Engine;
export function renderChart(host: HTMLElement): HTMLElement;
export function injectStyles(doc?: Document): void;
export const SHARPJS_CSS: string;
export const VERSION: string;
