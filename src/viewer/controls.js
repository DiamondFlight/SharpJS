/**
 * Built-in controls panel (plain DOM, no framework). Hosts with their own UI pass
 * { controls: false } to SharpJS() and call the handle / engine methods instead.
 */
import { PRESET_VALUES } from '../settings/schema.js';
import { createBufkitMapButton } from '../io/bufkit_map.js';
import { expandBufkitTimeSeries } from './time-slider.js';

const PARCELS = [
  ['SB', 'Surface-Based'],
  ['ML', 'Mixed-Layer'],
  ['MU', 'Most-Unstable'],
  ['CU', 'Custom Pressure'],
];
const MOTIONS = [
  ['RM', 'Right'],
  ['LM', 'Left'],
  ['MM', 'Mean'],
  ['US', 'Corfidi Up'],
  ['DS', 'Corfidi Down'],
  ['DTMR', 'Nixon Dev. R'],
  ['DTML', 'Nixon Dev. L'],
  ['CM', 'Custom'],
];
const PRESET_LABELS = {
  WindLapse: { Default: 'Tornado', Severe: 'Surface-Based Severe/MCS', Dryline: 'Dryline/Confluence', Elevated: 'Elevated Severe/MCS', Winter: 'Winter', Fire: 'Fire' },
  Inset: { Default: 'Tornado', Severe: 'Severe/MCS', Ambient: 'Fog/Ambient', Winter: 'Winter', Fire: 'Fire' },
  Vertical: { Default: 'Severe/Tornado', Winter: 'Winter', Fire: 'Fire' },
  SidePanel: { Graph: 'Graph w/ Height', Tornado: 'Tornado Climatology (CONUS)', Winter: 'Winter Stats' },
};
const PRESET_TITLES = { WindLapse: 'Wind / Lapse', Inset: 'Inset Parameters', Vertical: 'Vertical Levels', SidePanel: 'Side Panel' };
const COLOR_TABLES = ['Default', 'SounderPY', 'Rainbow', 'Greyscale'];
const SCALE_MODES = ['None', 'Storm Relative', 'Dynamic'];
const SKEWS = { 0.5: 'Low', 0.625: 'Medium', 0.75: 'Default', 0.825: 'High' };
const UNITS = { default: 'Default (kt / °C)', metric: 'Metric', imperial: 'Imperial' };
const EXPORTS = { Default: 'SHARPpy', SharpJS: 'SharpJS (SHARPpy + omega)', CM1: 'CM1 input_sounding' };
const BUFKIT_MODELS = { hrrr: 'HRRR', rap: 'RAP', ruc: 'RUC', nam: 'NAM', nam4km: 'NAM 3 km', gfs: 'GFS' };
const SECTION_NAV = [
  ['display', 'Display/Graphics'],
  ['file', 'Export/Import Sounding'],
  ['archive', 'Archive Data'],
  ['parcel', 'Parcel Selection'],
  ['motion', 'Motion Selection'],
  ['presets', 'Sounding Presets'],
  ['cursor', 'Cursor Settings'],
  ['surface', 'Surface Settings'],
  ['layers', 'Custom Layers'],
  ['settings', 'Reset Settings'],
];

/**
 * Create a DOM element, apply attributes/listeners, and append flattened children.
 * @param {Document} doc Owner document for the element.
 * @param {string} tag HTML tag name.
 * @param {object} attrs Element properties, attributes, styles, and event handlers.
 * @param {...(Node|string|number|null|boolean)} children Child nodes or text values.
 * @returns {HTMLElement} Created element.
 */
function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : doc.createTextNode(String(child)));
  }
  return el;
}

const utcDate = (d) => d.toISOString().slice(0, 10);

/** Most recent 00/12 Z launch at least 2 h old. */
function lastSynoptic(now = new Date()) {
  const d = new Date(now.getTime() - 2 * 3600 * 1000);
  d.setUTCHours(d.getUTCHours() >= 12 ? 12 : 0, 0, 0, 0);
  return d;
}

/**
 * @param {HTMLElement} host
 * @param {{ handle, engine, store, sources?, options?, setTimeSeries, setTimeSeriesLoading }} ctx
 */
export function createControls(host, {
  handle,
  engine,
  store,
  sources = null,
  options = {},
  setTimeSeries,
  setTimeSeriesLoading,
}) {
  const doc = host.ownerDocument;
  const H = (...args) => h(doc, ...args);
  const opts = options && typeof options === 'object' ? options : {};
  let currentSources = sources;
  let bufkitMap = null;
  const bufkitCache = new Map();
  const refs = {};
  const sections = {};
  const sectionNavButtons = {};
  const sectionAvailability = Object.fromEntries(SECTION_NAV.map(([id]) => [id, true]));
  let activeSection = 'display';
  let removeLoadListener = null;

  // ── helpers ──────────────────────────────────────────────────────────────────────────────
  const button = (label, onclick, attrs = {}) => H('button', { type: 'button', class: 'sjs-button', onclick, ...attrs }, label);
  const toggle = (key, title, onclick) => {
    const value = H('span');
    const b = H('button', { type: 'button', class: 'sjs-button', onclick, 'aria-pressed': 'false' }, H('span', {}, title), value);
    refs[key] = { button: b, value };
    return b;
  };
  const field = (label, control) => H('label', { class: 'sjs-field' }, H('span', {}, label), control);
  const input = (key, attrs = {}) => (refs[key] = H('input', { class: 'sjs-input', ...attrs }));
  const select = (key, options, attrs = {}) =>
    (refs[key] = H('select', { class: 'sjs-select', ...attrs }, Object.entries(options).map(([v, t]) => H('option', { value: v }, t))));
  const row = (cols, ...children) => H('div', { class: 'sjs-row', style: `--cols:${cols}` }, ...children);
  const fieldRow = (cols, ...children) => H('div', { class: 'sjs-field-row', style: `--cols:${cols}` }, ...children);
  const num = (el) => (el.value.trim() === '' ? undefined : Number(el.value));

  /**
   * Create a collapsible controls section and persist its expanded state.
   * @param {string} id Stable section identifier.
   * @param {string} title Visible section heading.
   * @param {...Node} children Content nodes for the section.
   * @returns {HTMLDetailsElement} Created details element.
   */
  function section(id, title, ...children) {
    const collapsed = store.get().collapsedSections.includes(id);
    const el = H('details', { class: 'sjs-section', 'data-section': id, open: !collapsed }, H('summary', {}, title), ...children);
    el.addEventListener('toggle', () => {
      const set = new Set(store.get().collapsedSections);
      if (el.open) set.delete(id);
      else set.add(id);
      store.set({ collapsedSections: [...set] });
    });
    sections[id] = el;
    return el;
  }

  function syncSectionNavigation() {
    for (const [id] of SECTION_NAV) {
      const available = sectionAvailability[id];
      sections[id].hidden = !available || id !== activeSection;
      sectionNavButtons[id].hidden = !available;
      sectionNavButtons[id].setAttribute('aria-pressed', id === activeSection && available ? 'true' : 'false');
    }
  }

  function showSection(id) {
    if (!sectionAvailability[id]) return;
    activeSection = id;
    sections[id].open = true;
    syncSectionNavigation();
  }

  function setSectionAvailability(id, available) {
    sectionAvailability[id] = available;
    if (!available && activeSection === id) activeSection = 'display';
    syncSectionNavigation();
  }

  const statusEl = H('p', { class: 'sjs-status', role: 'status', 'aria-live': 'polite' });
  let statusTimer = null;
  /**
   * Display a status message and mark errors for assistive technology and styling.
   * @param {string} message Text to display.
   * @param {boolean} isError Whether the message represents an error.
   * @returns {void} Updates the controls status element.
   */
  function status(message, isError = false) {
    clearTimeout(statusTimer);
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
    if (message && !isError) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 6000);
  }

  /**
   * Run an asynchronous controls action and show its progress or error.
   * @param {string} label Progress message shown while the action runs.
   * @param {Function} fn Asynchronous action to invoke.
   * @returns {Promise<void>} Resolves after the action or after its error is displayed.
   */
  async function run(label, fn) {
    status(label);
    try {
      await fn();
      status('');
    } catch (err) {
      status(err.message || String(err), true);
    }
  }

  // ── file pickers ─────────────────────────────────────────────────────────────────────────
  const fileInput = H('input', { type: 'file', multiple: true, hidden: true });
  let fileMode = 'auto';
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) handle.loadFiles(files, fileMode);
  });
  const pick = (mode) => {
    fileMode = mode;
    fileInput.click();
  };

  // ── sections ─────────────────────────────────────────────────────────────────────────────
  const fileSection = section('file', 'Sounding',
    field('Data format', select('exportFormat', EXPORTS, { onchange: (e) => engine.setExportFormat(e.target.value) })),
    row(2, button('Download .txt file', () => { if (!handle.downloadText()) status('Load a sounding first', true); }), button('Save image', () => run('Rendering image…', async () => { if (!(await handle.downloadImage())) throw new Error('Load a sounding first'); }))),
    row(1, button('Copy image', () => run('Copying…', async () => { if (!(await handle.copyImage())) throw new Error('Load a sounding first'); status('Image copied'); }))),
    H('div', { class: 'sjs-sub' }, 'Upload'),
    fileInput,
    row(1, button('Open sounding file…', () => pick('auto'))),
    row(2, button('Add comparison…', () => pick('compare')), button('Clear comparisons', () => handle.clearComparisons())),
    row(1, button('Average several files…', () => pick('average'))),
    H('p', { class: 'sjs-hint' }, 'Or drop files on the chart (Shift+drop adds comparisons).'),
  );

  const archive = H('div');
  const archiveSection = section('archive', 'Archive Data', archive);
  /**
   * Rebuild the archive controls from the currently available data-source callbacks.
   * @returns {void} Updates archive panel contents and visibility.
   */
  function renderArchive() {
    archive.innerHTML = '';
    if (!currentSources) {
      setSectionAvailability('archive', false);
      return;
    }
    setSectionAvailability('archive', true);
    const syn = lastSynoptic();
    const children = [];
    if (currentSources.fetchIemRaob) {
      children.push(
        H('div', { class: 'sjs-sub' }, 'Observed RAOB (IEM)'),
        fieldRow(2,
          field('Station', input('raobStation', { placeholder: 'OAX', value: opts.raobStation || 'OAX', autocomplete: 'off' })),
          field('Hour (UTC)', input('raobHour', { type: 'number', min: 0, max: 23, value: 12 }))),
        field('Date (UTC)', input('raobDate', { type: 'date', value: utcDate(syn) })),
        row(1, button('Load RAOB', () => run('Searching the IEM archive…', async () => {
          const time = new Date(`${refs.raobDate.value}T${String(refs.raobHour.value).padStart(2, '0')}:00:00Z`);
          handle.load(await currentSources.fetchIemRaob({ station: refs.raobStation.value, time }));
        }))),
      );
      refs.raobHour.value = String(syn.getUTCHours());
    }
    if (currentSources.fetchIemBufkit) {
      bufkitMap ??= createBufkitMapButton({
        document: doc,
        host,
        getModel: () => refs.bufkitModel.value,
        getRun: () => new Date(`${refs.bufkitDate.value}T${String(refs.bufkitRun.value || 0).padStart(2, '0')}:00:00Z`),
        onSelect: (station) => { refs.bufkitStation.value = station; },
      });
      children.push(
        H('div', { class: 'sjs-sub' }, 'Model BUFKIT (IEM)'),
        fieldRow(2,
          field('Model', select('bufkitModel', BUFKIT_MODELS)),
          field('Run date', input('bufkitDate', { type: 'date', value: utcDate(syn) })),
        fieldRow(2,
          field('Station', input('bufkitStation', { placeholder: 'dsm', value: opts.bufkitStation || 'kdsm', autocomplete: 'off' }))),
          row(1, bufkitMap.button),
        ),
        fieldRow(2,
          field('Run (Z)', input('bufkitRun', { type: 'number', min: 0, max: 23, value: syn.getUTCHours() })),
          field('F hour', input('bufkitFh', { type: 'number', min: 0, max: 384, value: 0 }))),
        H('p', { class: 'sjs-hint' }, 'RAP/RUC use 4-letter ids (kdsm); HRRR/NAM/GFS often use 3 (dsm).'),
        row(1, button('Load BUFKIT', () => run('Downloading BUFKIT…', async () => {
          const run = new Date(`${refs.bufkitDate.value}T${String(refs.bufkitRun.value || 0).padStart(2, '0')}:00:00Z`);
          const query = {
            model: refs.bufkitModel.value,
            station: refs.bufkitStation.value,
            run,
          };
          if (currentSources.fetchIemBufkitForecasts) {
            const cacheKey = `${query.model}|${query.station.trim().toLowerCase()}|${run.toISOString()}`;
            if (!bufkitCache.has(cacheKey)) {
              const promise = currentSources.fetchIemBufkitForecasts(query);
              bufkitCache.set(cacheKey, promise);
              promise.catch(() => {
                if (bufkitCache.get(cacheKey) === promise) bufkitCache.delete(cacheKey);
              });
              while (bufkitCache.size > 3) {
                bufkitCache.delete(bufkitCache.keys().next().value);
              }
            }
            const soundings = await bufkitCache.get(cacheKey);
            const timeline = expandBufkitTimeSeries(soundings);
            const selectedHour = Number(refs.bufkitFh.value) || 0;
            const selected = timeline.findIndex((item) => item.sounding?.meta?.forecastHour === selectedHour);
            if (selected === -1) throw new Error(`F${selectedHour} is not available in this BUFKIT file`);
            setTimeSeries(timeline, selected);
          } else {
            handle.load(await currentSources.fetchIemBufkit({
              ...query,
              forecastHour: Number(refs.bufkitFh.value) || 0,
            }));
          }
        }))),
      );
      refs.bufkitModel.value = 'rap';
    }
    if (currentSources.fetchNexradVwp) {
      children.push(
        H('div', { class: 'sjs-sub' }, 'NEXRAD VAD Wind Profile'),
        field('Radar', input('vwpRadar', { placeholder: 'OAX', value: opts.vwpRadar || 'OAX', autocomplete: 'off' })),
        ...(currentSources.fetchNexradVwpArchive ? [field('Archive date (UTC)', input('vwpDate', {
          type: 'date',
          min: '2020-01-01',
          max: utcDate(new Date()),
          value: utcDate(new Date()),
        }))] : []),
        ...(currentSources.fetchNexradVwpArchive ? [field('Archive hour (UTC)', input('vwpHour', {
          type: 'number',
          min: 0,
          max: 23,
          value: new Date().getUTCHours(),
        }))] : []),
        row(2,
          button('Latest VWP', () => run('Fetching VWP…', async () => {
            const snd = await currentSources.fetchNexradVwp({ radar: refs.vwpRadar.value, background: handle.getState().vwpActive ? undefined : handle.getSounding() || undefined });
            handle.setVwp(snd);
          })),
          (refs.vwpExit = button('Back to sounding', () => handle.setVwp(null)))),
        ...(currentSources.fetchNexradVwpArchive ? [row(1, button('Load 3-hour VWP archive', () => run('Loading VWP archive…', async () => {
          const hour = Number(refs.vwpHour.value);
          if (!refs.vwpDate.value || !Number.isInteger(hour) || hour < 0 || hour > 23) {
            throw new Error('Choose a valid VWP archive date and hour');
          }
          const end = new Date(`${refs.vwpDate.value}T${String(hour).padStart(2, '0')}:00:00Z`);
          if (end.getTime() > Date.now()) throw new Error('VWP archive time must not be in the future');
          const archiveStart = Date.UTC(2020, 0, 1);
          const start = new Date(Math.max(end.getTime() - 3 * 60 * 60 * 1000, archiveStart));
          const items = [];
          setTimeSeries([]);
          setTimeSeriesLoading(true);
          try {
            await currentSources.fetchNexradVwpArchive({
              radar: refs.vwpRadar.value,
              start,
              end,
              background: handle.getState().vwpActive ? undefined : handle.getSounding() || undefined,
              onVolume(sounding, progress) {
                items.push({ kind: 'vwp', time: sounding.volumeUnix * 1000, sounding });
                status(`Loaded VWP volume ${progress.index} of ${progress.total}`);
              },
            });
            setTimeSeries(items, items.length - 1);
          } finally {
            setTimeSeriesLoading(false);
          }
        })))] : []),
        H('p', { class: 'sjs-hint' }, 'Uses the loaded sounding for temperature/moisture, or a standard atmosphere.'),
      );
    }
    archive.append(...children);
  }

  const parcelSection = section('parcel', 'Parcel',
    row(2, ...PARCELS.map(([id, label]) => (refs[`parcel${id}`] = button(label, () => selectParcel(id))))),
    field('Custom parcel pressure (mb)', input('parcelPressure', { type: 'number', min: 100, max: 1100, step: 5, placeholder: '900', onchange: () => selectParcel('CU') })),
  );

  const motionSection = section('motion', 'Storm Motion',
    row(2, ...MOTIONS.map(([id, label]) => (refs[`motion${id}`] = button(label, () => selectMotion(id))))),
    fieldRow(2,
      field('Custom dir (°)', input('motionDir', { type: 'number', min: 0, max: 360, placeholder: '240', onchange: () => selectMotion('CM') })),
      field('Custom speed (kt)', input('motionSpd', { type: 'number', min: 0, max: 100, placeholder: '30', onchange: () => selectMotion('CM') }))),
  );

  const displaySection = section('display', 'Display',
    H('div', { class: 'sjs-stack' },
      toggle('verticalBars', 'Vertical bars', () => engine.ChangeWBox()),
      toggle('hodoNumbers', 'Hodograph heights', () => engine.ChangeStateHodographNumbers()),
      toggle('colorTable', 'Hodograph colors', () => engine.ChangeStateHodographColorTable()),
      toggle('hodoScale', 'Hodograph scale', () => engine.ChangeStateDynamicHodo()),
      toggle('trimWind', 'Hodograph wind', () => engine.setHodographTrimWindProfile(!engine.getState().hodographTrimWindProfile)),
      toggle('stormMotions', 'Storm motions', () => engine.LoadStormMotions()),
      toggle('ehiInWindBox', 'EHI within Wind Box', () => engine.LoadEHIWindBox()),
      toggle('onMapCape', 'HGZ/DGZ Cape on Skew-T', () => engine.LoadOnMapCape()),
      toggle('skew', 'Skew-T skew', () => engine.ChangeStateSkewTSkew()),
    ),
    field('Hodograph mode', select('hodoMode', { Relative: 'Hodo-relative (centered)', Storm: 'Storm-relative (fixed)' }, { onchange: (e) => engine.SetHodoMode(e.target.value) })),
    field('Units', select('units', UNITS, { onchange: (e) => engine.applyState({ units: e.target.value }) })),
  );

  const presetChildren = Object.keys(PRESET_VALUES).map((type) =>
    field(PRESET_TITLES[type], (refs[`preset${type}`] = H('select', { class: 'sjs-select', onchange: (e) => engine.setPreset(type, e.target.value) },
      PRESET_VALUES[type].map((v) => H('option', { value: v }, v === 'auto' ? 'Auto' : PRESET_LABELS[type][v] || v))))),
  );
  const efField = field('Tornado filter', select('efScale', { 'EF2+': 'Significant (EF2+)', 'EF0+': 'All tornadoes (EF0+)' }, { onchange: (e) => engine.SetEFScale(e.target.value) }));
  const presetSection = section('presets', 'Presets', ...presetChildren, efField,
    H('p', { class: 'sjs-hint' }, 'Auto picks presets from each sounding (winter, fire, elevated, …). Pinned choices are remembered.'));

  const cursorSection = section('cursor', 'Cursor Tools',
    H('div', { class: 'sjs-stack' },
      toggle('readout', 'Read-out', () => setReadout(!engine.getState().readOut)),
      toggle('front', 'Draw front (hodograph)', () => engine.ChangeFront()),
      toggle('modify', 'Modify sounding', () => engine.setModifyMode(!engine.getState().modifyActive))),
    row(2, button('Reset Skew-T', () => engine.ResetSkewT()), button('Reset hodograph', () => engine.ResetHodograph())),
  );

  const surfaceSection = section('surface', 'Modify Surface',
    fieldRow(3,
      field('Temp', input('sfcTemp', { type: 'number', step: 'any' })),
      field('Dewpoint', input('sfcDew', { type: 'number', step: 'any' })),
      field('Unit', select('sfcUnit', { F: '°F', C: '°C', K: 'K' }, { onchange: (e) => store.set({ surfaceTempUnit: e.target.value }) }))),
    row(2,
      button('Reset temps', () => engine.LoadNewSfc('Old', 'tmp')),
      button('Apply temps', () => engine.LoadNewSfc('New', 'tmp', { temperature: num(refs.sfcTemp), dewpoint: num(refs.sfcDew), unit: refs.sfcUnit.value }))),
    fieldRow(2,
      field('Wind dir (°)', input('sfcWd', { type: 'number', min: 0, max: 360 })),
      field('Wind speed (kt)', input('sfcWs', { type: 'number', min: 0 }))),
    row(2,
      button('Reset wind', () => engine.LoadNewSfc('Old', 'wnd')),
      button('Apply wind', () => engine.LoadNewSfc('New', 'wnd', { direction: num(refs.sfcWd), speed: num(refs.sfcWs) }))),
  );

  const layerSection = section('layers', 'Custom Layers',
    H('div', { class: 'sjs-sub' }, 'Lapse rate'),
    fieldRow(3,
      field('Bottom', input('lapseBot', { type: 'number', step: 'any', placeholder: '0' })),
      field('Top', input('lapseTop', { type: 'number', step: 'any', placeholder: '3' })),
      field('Mode', select('lapseMode', { Hght: 'km AGL', Pres: 'mb' }, { onchange: (e) => store.set({ lapseLayerMode: e.target.value }) }))),
    row(2,
      button('Reset', () => engine.LoadNewLapseLyr('R')),
      button('Apply', () => engine.LoadNewLapseLyr('N', { bottom: refs.lapseBot.value, top: refs.lapseTop.value, mode: refs.lapseMode.value }))),
    H('div', { class: 'sjs-sub' }, 'Wind shear'),
    fieldRow(3,
      field('Bottom', input('shearBot', { type: 'number', step: 'any', placeholder: '0' })),
      field('Top', input('shearTop', { type: 'number', step: 'any', placeholder: '6' })),
      field('Mode', select('shearMode', { Hght: 'km AGL', Pres: 'mb' }, { onchange: (e) => store.set({ shearLayerMode: e.target.value }) }))),
    row(2,
      button('Reset', () => engine.LoadNewShearLyr('R')),
      button('Apply', () => engine.LoadNewShearLyr('N', { bottom: refs.shearBot.value, top: refs.shearTop.value, mode: refs.shearMode.value }))),
  );

  const savedNote = H('p', { class: 'sjs-saved' });
  const settingsSection = section('settings', 'Settings',
    savedNote,
    row(1, button('Reset all settings', () => {
      if (typeof confirm === 'function' && !confirm('Reset every SharpJS setting to its default?')) return;
      handle.resetSettings();
      status('Settings reset');
    })),
  );

  const sectionNavigation = H('nav', { class: 'sjs-section-nav', 'aria-label': 'Control sections' },
    SECTION_NAV.map(([id, label]) => (sectionNavButtons[id] = H('button', {
      type: 'button',
      class: 'sjs-button sjs-section-button',
      title: sections[id].querySelector('summary').textContent,
      'aria-pressed': 'false',
      onclick: () => showSection(id),
    }, label))),
  );

  host.append(statusEl, sectionNavigation, displaySection, fileSection, archiveSection, parcelSection, motionSection, presetSection, cursorSection, surfaceSection, layerSection, settingsSection);
  renderArchive();
  showSection(activeSection);

  // ── actions ──────────────────────────────────────────────────────────────────────────────
  /**
   * Apply the selected parcel to the chart and persist non-custom parcel choices.
   * @param {string} id Parcel identifier (SB, ML, MU, or CU).
   * @returns {void} Updates chart parcel state.
   */
  function selectParcel(id) {
    engine.LoadNewParcel(id, id === 'CU' ? num(refs.parcelPressure) : undefined);
    if (id !== 'CU') engine.applyState({ defaultParcel: id }, { redraw: false });
  }

  /**
   * Apply the selected storm motion, including custom direction and speed when requested.
   * @param {string} id Storm-motion identifier.
   * @returns {void} Updates chart storm-motion state.
   */
  function selectMotion(id) {
    const custom = id === 'CM' ? { direction: num(refs.motionDir), speed: num(refs.motionSpd) } : null;
    engine.LoadNewWind(id, true, custom);
    if (id !== 'CM') engine.applyState({ defaultMotion: id }, { redraw: false });
  }

  /**
   * Toggle cursor readout and disable modification mode when readout is enabled.
   * @param {boolean} on Whether cursor readout should be active.
   * @returns {void} Updates chart interaction state.
   */
  function setReadout(on) {
    engine.setReadOutOnState(on);
    if (on) engine.setModifyMode(false);
    else engine.CursorReadout(false);
    engine.applyState({ readOut: on }, { redraw: false });
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────
  /**
   * Update a toggle control's displayed label and pressed state.
   * @param {string} key Toggle reference key.
   * @param {string} label Text displayed in the toggle.
   * @param {boolean} pressed Whether the toggle is pressed.
   * @returns {void} Updates the referenced control when it exists.
   */
  function setToggle(key, label, pressed) {
    const r = refs[key];
    if (!r) return;
    r.value.textContent = label;
    r.button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
  const setValue = (key, value) => {
    const el = refs[key];
    if (el && doc.activeElement !== el && el.value !== String(value)) el.value = String(value);
  };

  /**
   * Synchronize controls with the current chart state and persisted UI settings.
   * @param {object} state Chart-engine state.
   * @param {object} settings User settings.
   * @returns {void} Updates controls and section visibility.
   */
  function render(state = engine.getState(), settings = store.get()) {
    for (const [id] of PARCELS) refs[`parcel${id}`].setAttribute('aria-pressed', state.parcel === id ? 'true' : 'false');
    for (const [id] of MOTIONS) refs[`motion${id}`].setAttribute('aria-pressed', state.motion === id ? 'true' : 'false');

    setToggle('verticalBars', state.verticalBarsWindSpeed ? 'Full' : 'No wind speed', !state.verticalBarsWindSpeed);
    setToggle('hodoNumbers', state.hodographNumbers ? 'On' : 'Off', state.hodographNumbers);
    setToggle('colorTable', COLOR_TABLES[state.hodographColorTable] || 'Default', state.hodographColorTable !== 0);
    setToggle('hodoScale', SCALE_MODES[state.hodographScaleMode] || 'None', state.hodographScaleMode !== 0);
    setToggle('trimWind', state.hodographTrimWindProfile ? 'Trimmed' : 'Full resolution', !state.hodographTrimWindProfile);
    setToggle('stormMotions', state.showStormMotions ? 'Shown' : 'Hidden', state.showStormMotions);
    setToggle('ehiInWindBox', state.showEhiInWindBox ? 'Shown' : 'Hidden', state.showEhiInWindBox);
    setToggle('onMapCape', state.showCapeOnMap ? 'Shown' : 'Hidden', state.showCapeOnMap);
    setToggle('skew', SKEWS[state.skewTSkew] || 'Default', state.skewTSkew !== 0.75);
    setToggle('readout', state.readOut ? 'On' : 'Off', state.readOut);
    setToggle('front', state.frontActive ? 'On' : 'Off', state.frontActive);
    setToggle('modify', state.modifyActive ? 'On' : 'Off', state.modifyActive);

    setValue('hodoMode', state.hodographMode);
    setValue('units', state.units);
    setValue('exportFormat', state.exportFormat);
    setValue('efScale', state.efScale);
    setValue('sfcUnit', settings.surfaceTempUnit);
    setValue('lapseMode', settings.lapseLayerMode);
    setValue('shearMode', settings.shearLayerMode);

    for (const type of Object.keys(PRESET_VALUES)) {
      const sel = refs[`preset${type}`];
      const pinned = state.presetOverrides[type];
      const autoValue = state.autoPresets[type];
      sel.options[0].textContent = `Auto (${PRESET_LABELS[type][autoValue] || autoValue})`;
      setValue(`preset${type}`, pinned || 'auto');
      if (type === 'SidePanel') {
        const tornado = [...sel.options].find((o) => o.value === 'Tornado');
        if (tornado) tornado.disabled = !state.tornadoClimoAvailable;
      }
    }
    efField.hidden = state.presets.SidePanel !== 'Tornado';

    if (refs.vwpExit) refs.vwpExit.disabled = !state.vwpActive;
    const vwp = state.vwpActive;
    setSectionAvailability('parcel', !vwp);
    setSectionAvailability('surface', !vwp);
    setSectionAvailability('layers', !vwp);
    setSectionAvailability('cursor', !vwp);

    savedNote.textContent = store.storage === 'memory'
      ? 'Settings are kept for this page only.'
      : `Settings are saved in this browser (${store.storage === 'cookie' ? 'cookie' : store.storage === 'localStorage' ? 'local storage' : store.storage}).`;
  }

  render();
  removeLoadListener = handle.on('load', (sounding) => {
    const meta = sounding.meta;
    if (meta?.source !== 'bufkit') return;
    if (refs.bufkitFh) refs.bufkitFh.value = String(meta.forecastHour);
    if (meta.run && refs.bufkitDate && refs.bufkitRun) {
      const run = new Date(meta.run);
      refs.bufkitDate.value = utcDate(run);
      refs.bufkitRun.value = String(run.getUTCHours());
    }
  });

  return {
    render,
    status,
    setSources(next) {
      currentSources = next || null;
      renderArchive();
      render();
    },
    destroy() {
      removeLoadListener?.();
      clearTimeout(statusTimer);
      bufkitMap?.destroy();
      host.innerHTML = '';
    },
  };
}
