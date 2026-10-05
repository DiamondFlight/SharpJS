/**
 * Built-in controls panel (plain DOM, no framework). Hosts with their own UI pass
 * { controls: false } to SharpJS() and call the handle / engine methods instead.
 */
import { PRESET_VALUES } from '../settings/schema.js';

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
 * @param {{ handle, engine, store, sources?, options? }} ctx
 */
export function createControls(host, { handle, engine, store, sources = null, options = {} }) {
  const doc = host.ownerDocument;
  const H = (...args) => h(doc, ...args);
  const opts = options && typeof options === 'object' ? options : {};
  let currentSources = sources;
  const refs = {};
  const sections = {};

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

  const statusEl = H('p', { class: 'sjs-status', role: 'status', 'aria-live': 'polite' });
  let statusTimer = null;
  function status(message, isError = false) {
    clearTimeout(statusTimer);
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
    if (message && !isError) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 6000);
  }

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
    row(1, button('Open sounding file…', () => pick('auto'))),
    row(2, button('Add comparison…', () => pick('compare')), button('Clear comparisons', () => handle.clearComparisons())),
    row(1, button('Average several files…', () => pick('average'))),
    H('p', { class: 'sjs-hint' }, 'Or drop files on the chart (Shift+drop adds comparisons).'),
    H('div', { class: 'sjs-sub' }, 'Export'),
    field('Data format', select('exportFormat', EXPORTS, { onchange: (e) => engine.setExportFormat(e.target.value) })),
    row(2, button('Download data', () => { if (!handle.downloadText()) status('Load a sounding first', true); }), button('Save image', () => run('Rendering image…', async () => { if (!(await handle.downloadImage())) throw new Error('Load a sounding first'); }))),
    row(1, button('Copy image', () => run('Copying…', async () => { if (!(await handle.copyImage())) throw new Error('Load a sounding first'); status('Image copied'); }))),
    fileInput,
  );

  const archive = H('div');
  const archiveSection = section('archive', 'Archive Data', archive);
  function renderArchive() {
    archive.innerHTML = '';
    if (!currentSources) {
      archiveSection.hidden = true;
      return;
    }
    archiveSection.hidden = false;
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
      children.push(
        H('div', { class: 'sjs-sub' }, 'Model BUFKIT (IEM)'),
        fieldRow(2,
          field('Model', select('bufkitModel', BUFKIT_MODELS)),
          field('Station', input('bufkitStation', { placeholder: 'dsm', value: opts.bufkitStation || 'kdsm', autocomplete: 'off' }))),
        fieldRow(3,
          field('Run date', input('bufkitDate', { type: 'date', value: utcDate(syn) })),
          field('Run (Z)', input('bufkitRun', { type: 'number', min: 0, max: 23, value: syn.getUTCHours() })),
          field('F hour', input('bufkitFh', { type: 'number', min: 0, max: 384, value: 0 }))),
        H('p', { class: 'sjs-hint' }, 'RAP/RUC use 4-letter ids (kdsm); HRRR/NAM/GFS often use 3 (dsm).'),
        row(1, button('Load BUFKIT', () => run('Downloading BUFKIT…', async () => {
          const run = new Date(`${refs.bufkitDate.value}T${String(refs.bufkitRun.value || 0).padStart(2, '0')}:00:00Z`);
          handle.load(await currentSources.fetchIemBufkit({
            model: refs.bufkitModel.value,
            station: refs.bufkitStation.value,
            run,
            forecastHour: Number(refs.bufkitFh.value) || 0,
          }));
        }))),
      );
      refs.bufkitModel.value = 'rap';
    }
    if (currentSources.fetchNexradVwp) {
      children.push(
        H('div', { class: 'sjs-sub' }, 'NEXRAD VAD Wind Profile'),
        field('Radar', input('vwpRadar', { placeholder: 'OAX', value: opts.vwpRadar || 'OAX', autocomplete: 'off' })),
        row(2,
          button('Latest VWP', () => run('Fetching VWP…', async () => {
            const snd = await currentSources.fetchNexradVwp({ radar: refs.vwpRadar.value, background: handle.getState().vwpActive ? undefined : handle.getSounding() || undefined });
            handle.setVwp(snd);
          })),
          (refs.vwpExit = button('Back to sounding', () => handle.setVwp(null)))),
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

  host.append(statusEl, fileSection, archiveSection, parcelSection, motionSection, displaySection, presetSection, cursorSection, surfaceSection, layerSection, settingsSection);
  renderArchive();

  // ── actions ──────────────────────────────────────────────────────────────────────────────
  function selectParcel(id) {
    engine.LoadNewParcel(id, id === 'CU' ? num(refs.parcelPressure) : undefined);
    if (id !== 'CU') engine.applyState({ defaultParcel: id }, { redraw: false });
  }

  function selectMotion(id) {
    const custom = id === 'CM' ? { direction: num(refs.motionDir), speed: num(refs.motionSpd) } : null;
    engine.LoadNewWind(id, true, custom);
    if (id !== 'CM') engine.applyState({ defaultMotion: id }, { redraw: false });
  }

  function setReadout(on) {
    engine.setReadOutOnState(on);
    if (on) engine.setModifyMode(false);
    else engine.CursorReadout(false);
    engine.applyState({ readOut: on }, { redraw: false });
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────
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

  function render(state = engine.getState(), settings = store.get()) {
    for (const [id] of PARCELS) refs[`parcel${id}`].setAttribute('aria-pressed', state.parcel === id ? 'true' : 'false');
    for (const [id] of MOTIONS) refs[`motion${id}`].setAttribute('aria-pressed', state.motion === id ? 'true' : 'false');

    setToggle('verticalBars', state.verticalBarsWindSpeed ? 'Full' : 'No wind speed', !state.verticalBarsWindSpeed);
    setToggle('hodoNumbers', state.hodographNumbers ? 'On' : 'Off', state.hodographNumbers);
    setToggle('colorTable', COLOR_TABLES[state.hodographColorTable] || 'Default', state.hodographColorTable !== 0);
    setToggle('hodoScale', SCALE_MODES[state.hodographScaleMode] || 'None', state.hodographScaleMode !== 0);
    setToggle('trimWind', state.hodographTrimWindProfile ? 'Trimmed' : 'Full resolution', !state.hodographTrimWindProfile);
    setToggle('stormMotions', state.showStormMotions ? 'Shown' : 'Hidden', state.showStormMotions);
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
    parcelSection.hidden = vwp;
    surfaceSection.hidden = vwp;
    layerSection.hidden = vwp;
    cursorSection.hidden = vwp;

    savedNote.textContent = store.storage === 'memory'
      ? 'Settings are kept for this page only.'
      : `Settings are saved in this browser (${store.storage === 'cookie' ? 'cookie' : store.storage === 'localStorage' ? 'local storage' : store.storage}).`;
  }

  render();

  return {
    render,
    status,
    setSources(next) {
      currentSources = next || null;
      renderArchive();
      render();
    },
    destroy() {
      clearTimeout(statusTimer);
      host.innerHTML = '';
    },
  };
}
