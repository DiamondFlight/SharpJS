/**
 * SharpJS(target, props): one call that draws an interactive sounding and handles the rest
 * (controls, saved settings, file drop, exports). Call it again with new props to update.
 *
 *   import { SharpJS } from 'sharpjs';
 *   SharpJS('#chart', { sounding: text });            // mount
 *   SharpJS('#chart', { sounding: nextText });        // update the same chart
 *
 * It also returns a handle for imperative use (load, screenshot, getSettings, destroy, …).
 */
import { createEngine } from './engine.js';
import { renderChart } from './template.js';
import { injectStyles } from './styles.js';
import { createControls } from './controls.js';
import { createSettingsStore } from '../settings/store.js';
import { toSounding, isSounding } from '../io/input.js';
import { withLocation } from '../io/location.js';
import { buildVwpSounding } from '../io/vwp.js';
import { analyze } from '../analysis.js';
import { VERSION } from '../version.js';

/** Settings the chart engine owns (the rest belong to the controls panel). */
const ENGINE_SETTINGS = [
  'units', 'skewTSkew', 'hodographNumbers', 'hodographColorTable', 'hodographScaleMode',
  'hodographTrimWindProfile', 'hodographMode', 'readOut', 'verticalBarsWindSpeed', 'showStormMotions',
  'presetOverrides', 'efScale', 'defaultParcel', 'defaultMotion', 'exportFormat',
];

const COMPARISON_COLORS = ['rgb(0, 225, 255)', 'rgb(255, 0, 0)', 'rgb(246, 255, 0)', 'rgb(85, 255, 0)', 'rgb(170, 0, 255)', 'rgba(255, 255, 255, 1)'];

const instances = new WeakMap();

function resolveTarget(target) {
  if (typeof target === 'string') {
    if (typeof document === 'undefined') throw new Error('SharpJS: no document');
    const el = document.querySelector(target);
    if (!el) throw new Error(`SharpJS: no element matches ${target}`);
    return el;
  }
  if (!target || typeof target.appendChild !== 'function') throw new Error('SharpJS: target must be an element or selector');
  return target;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const safeName = (s) => String(s || 'sounding').trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'sounding';

/** Text in any supported format, or binary (NEXRAD VWP)? */
async function readFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = false;
  for (let i = 0; i < Math.min(bytes.length, 2048); i++) {
    const b = bytes[i];
    if (b === 0 || (b < 9 && b !== 4)) { binary = true; break; }
  }
  if (!binary || /\.txt$|\.buf$|\.csv$|\.json$/i.test(file.name)) {
    const text = new TextDecoder().decode(bytes);
    if (text.includes('%RAW%') || text.includes('STID') || text.includes('"level"') || !/\p{L}/u.test(text)) {
      return { name: file.name, text };
    }
  }
  return { name: file.name, buffer };
}

/**
 * @param {Element|string} target
 * @param {object} [props]  see README → "SharpJS(target, props)"
 * @returns {object} handle
 */
export function SharpJS(target, props = {}) {
  const el = resolveTarget(target);
  const existing = instances.get(el);
  if (existing) {
    existing.update(props);
    return existing;
  }
  const handle = mount(el, props);
  instances.set(el, handle);
  return handle;
}

/** The handle of the chart mounted on `target`, if any. */
SharpJS.get = (target) => instances.get(resolveTarget(target)) || null;
SharpJS.version = VERSION;

function mount(el, initialProps) {
  let props = { ...initialProps };
  let destroyed = false;
  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  };
  const fire = (type, detail) => {
    const propName = `on${type[0].toUpperCase()}${type.slice(1)}`;
    if (typeof props[propName] === 'function') {
      try { props[propName](detail); } catch (err) { console.error(err); }
    }
    for (const fn of listeners.get(type) || []) {
      try { fn(detail); } catch (err) { console.error(err); }
    }
  };

  if (props.injectStyles !== false) injectStyles(el.ownerDocument);

  // ── DOM ────────────────────────────────────────────────────────────────────────────────
  const root = el.ownerDocument.createElement('div');
  root.className = 'sharpjs';
  if (props.className) root.classList.add(...String(props.className).split(/\s+/).filter(Boolean));
  const controlsHost = el.ownerDocument.createElement('aside');
  controlsHost.className = 'sjs-controls';
  controlsHost.setAttribute('aria-label', 'Sounding controls');
  const stage = el.ownerDocument.createElement('div');
  stage.className = 'sjs-stage';
  const timeSlider = el.ownerDocument.createElement('div');
  timeSlider.className = 'sjs-timeslider';
  root.append(controlsHost, stage, timeSlider);
  el.appendChild(root);
  const viz = renderChart(stage);
  const q = (id) => viz.querySelector(`[data-sjs="${id}"]`);
  const empty = el.ownerDocument.createElement('div');
  empty.className = 'sjs-empty';
  viz.appendChild(empty);
  const renderEmpty = () => {
    empty.innerHTML = '';
    const strong = el.ownerDocument.createElement('strong');
    strong.textContent = props.emptyTitle || 'No sounding loaded';
    const msg = el.ownerDocument.createElement('span');
    msg.textContent = props.emptyMessage || (props.fileDrop === false
      ? 'Pass a sounding to SharpJS() to draw it.'
      : 'Drop a sounding file here (SHARPpy, CM1, BUFKIT, Chaser Archive JSON or NEXRAD VWP), or load one from the controls.');
    empty.append(strong, msg);
  };
  renderEmpty();

  // ── data (declared first: callbacks below read it) ───────────────────────────────────
  let main = null; // parsed main sounding (never the VWP variant)
  let comparisons = [];
  let soundingKey;
  let vwpOn = false;
  let controls = null;
  const hasSounding = () => !!(main || vwpOn);

  // ── settings ───────────────────────────────────────────────────────────────────────────
  const store = createSettingsStore({
    persist: props.persist ?? 'auto',
    key: props.storageKey || 'sharpjs:settings',
    defaults: props.defaultSettings,
    overrides: props.settings,
  });

  // ── engine ─────────────────────────────────────────────────────────────────────────────
  let stateTimer = null;
  let lastStateJson = '';
  let syncingFromEngine = false;
  const engineOptions = {
    brandLabel: props.brandLabel,
    savedBy: props.savedBy,
    filePrefix: props.filePrefix,
    font: props.font,
    emit: (type, detail) => {
      if (type === 'error') {
        reportError(new Error(detail));
        return;
      }
      scheduleStateCheck();
    },
  };
  const engine = createEngine(viz, engineOptions);
  engine.attach();

  function scheduleStateCheck() {
    if (stateTimer !== null || destroyed) return;
    stateTimer = Promise.resolve().then(() => {
      stateTimer = null;
      if (destroyed) return;
      const state = engine.getState();
      const json = JSON.stringify(state);
      if (json === lastStateJson) return;
      lastStateJson = json;
      syncingFromEngine = true;
      try {
        store.set(pick(state, ENGINE_SETTINGS));
      } finally {
        syncingFromEngine = false;
      }
      controls?.render(state, store.get());
      fire('change', state);
    });
  }

  store.subscribe((settings) => {
    if (!syncingFromEngine) {
      const current = engine.getState();
      const changed = ENGINE_SETTINGS.filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(current[k]));
      if (changed.length) engine.applyState(pick(settings, changed), { redraw: hasSounding() });
    }
    controls?.render(engine.getState(), settings);
    fire('settingsChange', settings);
  });

  engine.applyState(pick(store.get(), ENGINE_SETTINGS), { redraw: false });

  // ── data ───────────────────────────────────────────────────────────────────────────────
  function reportError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!listeners.get('error')?.size && typeof props.onError !== 'function') console.error(error);
    fire('error', error);
    controls?.status(error.message, true);
  }

  function showEmpty(show) {
    empty.style.display = show ? '' : 'none';
  }

  function normalizeComparisons(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((item, i) => {
        const input = item && (item.sounding ?? item);
        let parsed;
        try {
          parsed = toSounding(input);
        } catch (err) {
          reportError(err);
          return null;
        }
        const label = item.label || String(parsed.STitle || parsed.Title || `Sounding ${i + 1}`).trim().slice(0, 48);
        return {
          sounding: parsed,
          metadata: {
            comparisonColor: item.color || COMPARISON_COLORS[i % COMPARISON_COLORS.length],
            isVisible: item.visible !== false,
            title: label,
            date: '',
            model: '',
            run: '',
            fh: '',
          },
        };
      })
      .filter(Boolean);
  }

  function setDropsondeLayout(snd) {
    const isDrop = !!(snd && (snd.isDropsonde === true || /dropsonde|·\s*drop\b/i.test(`${snd.STitle || ''} ${snd.Title || ''}`)));
    viz.classList.toggle('dropsonde-mode', isDrop);
  }

  function drawMain({ reset }) {
    if (!main) return;
    setDropsondeLayout(main);
    engine.setVwpActive(false);
    vwpOn = false;
    engine.Load(main, true, { reset, comparisons });
    showEmpty(false);
  }

  /**
   * Load the main sounding.
   * @param {string|object} input
   * @param {{ title?: string, key?: string, reset?: boolean, location?: {lat:number, lon:number}, parseOptions?: object }} [opts]
   */
  function load(input, opts = {}) {
    try {
      const parsed = toSounding(input, opts.parseOptions);
      if (opts.location) withLocation(parsed, opts.location);
      if (opts.title || props.title) {
        parsed.Title = opts.title || props.title;
        parsed.STitle = parsed.Title;
      }
      const key = opts.key;
      const reset = opts.reset ?? !(key !== undefined && key === soundingKey);
      soundingKey = key;
      main = parsed;
      drawMain({ reset });
      fire('load', parsed);
      scheduleStateCheck();
      return parsed;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  function clear() {
    main = null;
    comparisons = [];
    vwpOn = false;
    engine.TurnOff();
    viz.classList.remove('dropsonde-mode');
    for (const c of viz.querySelectorAll('canvas')) {
      const ctx = c.getContext('2d');
      ctx?.clearRect(0, 0, c.width, c.height);
    }
    const modal = q('modifySkewTModal');
    if (modal) modal.style.display = 'none';
    showEmpty(true);
    scheduleStateCheck();
  }

  function setComparisons(list) {
    comparisons = normalizeComparisons(list);
    if (main && !vwpOn) engine.setComparisons(comparisons);
    scheduleStateCheck();
  }

  /** Overlay more soundings (text / parsed / arrays) on the current one. */
  function compare(inputs) {
    const items = (Array.isArray(inputs) ? inputs : [inputs]).map((s) => (s && s.sounding ? s : { sounding: s }));
    const offset = comparisons.length;
    const added = normalizeComparisons(items).map((c, i) => {
      if (!items[i].color) c.metadata.comparisonColor = COMPARISON_COLORS[(offset + i) % COMPARISON_COLORS.length];
      return c;
    });
    comparisons = comparisons.concat(added);
    if (main && !vwpOn) engine.setComparisons(comparisons);
    scheduleStateCheck();
  }

  /** Average several soundings into one (drawn with the members as ghosts). */
  function average(texts) {
    try {
      const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string');
      if (list.length < 2) throw new Error('SharpJS: averaging needs at least two sounding texts');
      setDropsondeLayout(null);
      engine.AverageAll(list.map((t, i) => [`${i}`, t]));
      main = engine.getSnding();
      vwpOn = false;
      showEmpty(false);
      scheduleStateCheck();
    } catch (err) {
      reportError(err);
    }
  }

  /**
   * Show a NEXRAD VWP. `input` is a VWP sounding (buildVwpSounding / sources.fetchNexradVwp) or raw
   * NVW bytes. Pass null to go back to the main sounding.
   */
  function setVwp(input, opts = {}) {
    try {
      if (!input) {
        if (vwpOn) {
          vwpOn = false;
          if (main) drawMain({ reset: false });
          else clear();
        }
        scheduleStateCheck();
        return null;
      }
      const stored = isSounding(input) ? input : buildVwpSounding(input, { background: main || undefined, ...opts });
      if (!stored) throw new Error('SharpJS: VWP product has no wind levels');
      viz.classList.remove('dropsonde-mode');
      vwpOn = true;
      engine.applyNexradVwpStoredSounding(stored);
      showEmpty(false);
      scheduleStateCheck();
      return stored;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  async function loadFiles(files, mode = 'auto') {
    const list = [...(files || [])];
    if (list.length === 0) return;
    try {
      const read = await Promise.all(list.map(readFile));
      const binary = read.find((r) => r.buffer);
      if (binary && read.length === 1) {
        setVwp(binary.buffer, { radar: (/([A-Z]{3})[_-]?NVW|NVW[_-]?([A-Z]{3})/i.exec(binary.name) || []).slice(1).find(Boolean) });
        return;
      }
      const texts = read.filter((r) => r.text);
      if (texts.length === 0) throw new Error('SharpJS: no readable sounding files');
      if (mode === 'average') return average(texts.map((t) => t.text));
      if (mode === 'compare' && main) return compare(texts.map((t) => ({ sounding: toSounding(t.text, { fileName: t.name }), label: t.name })));
      load(texts[0].text, { parseOptions: { fileName: texts[0].name } });
      if (texts.length > 1) {
        compare(texts.slice(1).map((t) => ({ sounding: toSounding(t.text, { fileName: t.name }), label: t.name })));
      }
    } catch (err) {
      reportError(err);
    }
  }

  // ── exports ────────────────────────────────────────────────────────────────────────────
  function exportText(format) {
    return engine.GetSoundingTextContent(format);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el.ownerDocument.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    el.ownerDocument.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText(format) {
    const data = exportText(format);
    if (!data) return null;
    downloadBlob(new Blob([data.text], { type: 'text/plain;charset=utf-8' }), data.filename);
    return data;
  }

  /** PNG data URL of the whole chart (2000×1200 × scale). */
  function screenshot({ scale = 1 } = {}) {
    if (!hasSounding()) return Promise.resolve(null);
    return engine.Screenshot(false, scale);
  }

  async function downloadImage({ scale = 2 } = {}) {
    const url = await screenshot({ scale });
    if (!url) return null;
    const blob = await (await fetch(url)).blob();
    const title = engine.getSnding()?.Title;
    downloadBlob(blob, `${props.filePrefix || 'SharpJS_Sounding'}_${safeName(title)}.png`);
    return url;
  }

  async function copyImage({ scale = 2 } = {}) {
    const url = await screenshot({ scale });
    if (!url) return false;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('Copying images is not supported in this browser');
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  }

  // ── pointer, wheel, help, drop ─────────────────────────────────────────────────────────
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const skewT = q('skewT');
  const hodo = q('hodograph');
  listen(skewT, 'click', (e) => engine.Flip(e));
  listen(skewT, 'mousemove', (e) => hasSounding() && engine.SkewTMouseMoved(e));
  listen(skewT, 'mousedown', (e) => engine.SkewTMouseDown(e));
  listen(skewT, 'wheel', (e) => { e.preventDefault(); if (hasSounding()) engine.SkewTWheel(e); }, { passive: false });
  listen(hodo, 'click', (e) => engine.Front(e));
  listen(hodo, 'mousemove', (e) => hasSounding() && engine.HodographMouseMoved(e));
  listen(hodo, 'mousedown', (e) => engine.HodographMouseDown(e));
  listen(hodo, 'wheel', (e) => { e.preventDefault(); if (hasSounding()) engine.HodographWheel(e); }, { passive: false });

  const help = q('helpOverlay');
  listen(viz, 'click', (e) => {
    const action = e.target.closest?.('[data-sjs-action]')?.dataset.sjsAction;
    if (action === 'help-open') help.hidden = false;
    else if (action === 'help-close' || e.target === help) help.hidden = true;
  });
  listen(el.ownerDocument, 'keydown', (e) => {
    if (e.key === 'Escape' && !help.hidden) help.hidden = true;
  });

  if (props.fileDrop !== false) {
    let depth = 0;
    listen(viz, 'dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      depth += 1;
      viz.classList.add('is-dragover');
      showEmpty(true);
    });
    listen(viz, 'dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    });
    listen(viz, 'dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        viz.classList.remove('is-dragover');
        showEmpty(!hasSounding());
      }
    });
    listen(viz, 'drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      viz.classList.remove('is-dragover');
      showEmpty(!hasSounding());
      loadFiles(e.dataTransfer.files, e.shiftKey ? 'compare' : 'auto');
    });
  }

  // Fonts can finish loading after the first draw; repaint once when they do.
  if (el.ownerDocument.fonts?.ready) {
    el.ownerDocument.fonts.ready.then(() => {
      if (!destroyed && hasSounding()) engine.redraw();
    });
  }

  // ── handle ─────────────────────────────────────────────────────────────────────────────
  const handle = {
    version: VERSION,
    element: root,
    /** The underlying chart engine (lower-level drawing API; see viewer/engine.js). */
    engine,
    /** The settings store (get / set / reset / subscribe). */
    settings: store,
    update,
    load,
    clear,
    compare,
    setComparisons,
    clearComparisons: () => setComparisons([]),
    average,
    setVwp,
    loadFiles,
    /** Current sounding (parsed), or null. */
    getSounding: () => (hasSounding() ? engine.getSnding() : null),
    getState: () => engine.getState(),
    getSettings: () => store.get(),
    setSettings: (partial) => store.set(partial),
    resetSettings: () => store.reset(),
    /** Headless analysis of the displayed sounding with the chart's parcel and storm motion. */
    analysis(options = {}) {
      const snd = engine.getSnding();
      if (!snd || !snd.Sounding) return null;
      const state = engine.getState();
      const motion = state.motion === 'CM' ? state.customMotion : state.motion;
      return analyze(snd, { parcel: state.parcel, parcelPressure: state.customParcelPressure, motion, ...options });
    },
    exportText,
    downloadText,
    screenshot,
    downloadImage,
    copyImage,
    on,
    redraw: () => engine.redraw(),
    destroy,
  };

  controls = props.controls === false
    ? null
    : createControls(controlsHost, { handle, engine, store, sources: props.sources, options: props.controls });
  if (!controls) controlsHost.remove();

  function update(next = {}) {
    if (destroyed) return handle;
    props = { ...props, ...next };
    if ('brandLabel' in next) engineOptions.brandLabel = next.brandLabel;
    if ('savedBy' in next) engineOptions.savedBy = next.savedBy;
    if ('filePrefix' in next) engineOptions.filePrefix = next.filePrefix;
    if ('emptyMessage' in next || 'emptyTitle' in next) renderEmpty();
    if (next.settings) store.set(next.settings);
    if ('sources' in next) controls?.setSources(next.sources);

    let redrawHodo = false;
    if ('mapImage' in next) {
      engine.SetMapImage(next.mapImage || null);
      redrawHodo = true;
    }
    if ('comparisons' in next) comparisons = normalizeComparisons(next.comparisons);

    if ('sounding' in next) {
      if (next.sounding == null) clear();
      else load(next.sounding, { key: next.soundingKey, title: next.title, location: next.location });
    } else if ('comparisons' in next) {
      setComparisons(next.comparisons);
    } else if ('title' in next && main) {
      main.Title = next.title || main.Title;
      main.STitle = main.Title;
      drawMain({ reset: false });
    } else if (redrawHodo && hasSounding()) {
      engine.redraw();
    }

    if ('vwp' in next) setVwp(next.vwp);
    scheduleStateCheck();
    return handle;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const fn of cleanups) fn();
    controls?.destroy();
    engine.detach();
    root.remove();
    instances.delete(el);
    listeners.clear();
  }

  // initial data
  showEmpty(true);
  if (props.vwp && !props.sounding) setVwp(props.vwp);
  if (props.sounding != null) {
    if (props.comparisons) comparisons = normalizeComparisons(props.comparisons);
    load(props.sounding, { key: props.soundingKey, title: props.title, location: props.location });
    if (props.vwp) setVwp(props.vwp);
  }
  if (props.mapImage) {
    engine.SetMapImage(props.mapImage);
    if (hasSounding()) engine.redraw();
  }
  scheduleStateCheck();
  store.ready.then(() => scheduleStateCheck());
  return handle;
}
