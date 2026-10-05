import { DEFAULT_SETTINGS, SETTINGS_VERSION, diffFromDefaults, migrate, sanitizeSettings } from './schema.js';
import { resolveAdapter } from './storage.js';

/**
 * Settings store: validated settings, persisted through an adapter.
 *
 *   const store = createSettingsStore({ persist: 'cookie' });
 *   store.get();                         // full settings object
 *   store.set({ units: 'metric' });      // validate, save, notify
 *   store.subscribe((settings) => …);    // returns an unsubscribe function
 *   store.reset();                       // back to defaults and clear storage
 *
 * @param {object} [options]
 * @param {boolean|string|object} [options.persist='auto']  see resolveAdapter()
 * @param {string} [options.key='sharpjs:settings']        storage key / cookie name
 * @param {object} [options.defaults]                      host defaults (under saved settings)
 * @param {object} [options.overrides]                     host values (over saved settings)
 */
export function createSettingsStore({ persist = 'auto', key = 'sharpjs:settings', defaults, overrides } = {}) {
  const adapter = resolveAdapter(persist, key);
  const base = sanitizeSettings(defaults, DEFAULT_SETTINGS);
  let settings = sanitizeSettings(overrides, base);
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) {
      try {
        fn(settings);
      } catch (err) {
        console.error('SharpJS settings listener failed', err);
      }
    }
  };

  const persistNow = () => {
    try {
      const result = adapter.save({ v: SETTINGS_VERSION, settings: diffFromDefaults(settings) });
      if (result && typeof result.catch === 'function') result.catch((err) => console.warn('SharpJS: could not save settings', err));
    } catch (err) {
      console.warn('SharpJS: could not save settings', err);
    }
  };

  const applyLoaded = (payload) => {
    const saved = migrate(payload);
    settings = sanitizeSettings(overrides, sanitizeSettings(saved, base));
  };

  let ready;
  try {
    const loaded = adapter.load();
    if (loaded && typeof loaded.then === 'function') {
      ready = loaded.then(
        (payload) => {
          applyLoaded(payload);
          notify();
          return settings;
        },
        (err) => {
          console.warn('SharpJS: could not load settings', err);
          return settings;
        },
      );
    } else {
      applyLoaded(loaded);
      ready = Promise.resolve(settings);
    }
  } catch (err) {
    console.warn('SharpJS: could not load settings', err);
    ready = Promise.resolve(settings);
  }

  return {
    /** Resolves once an async adapter has loaded (immediately for browser storage). */
    ready,
    /** Which storage is in use: "localStorage", "cookie", "memory" or a custom adapter's kind. */
    get storage() {
      return adapter.kind || 'custom';
    },
    get() {
      return JSON.parse(JSON.stringify(settings));
    },
    /**
     * @param {object} partial
     * @param {{ save?: boolean, silent?: boolean }} [opts]
     * @returns {boolean} whether anything changed
     */
    set(partial, { save = true, silent = false } = {}) {
      const next = sanitizeSettings(partial, settings);
      if (JSON.stringify(next) === JSON.stringify(settings)) return false;
      settings = next;
      if (save) persistNow();
      if (!silent) notify();
      return true;
    },
    reset() {
      settings = sanitizeSettings(overrides, base);
      try {
        const result = adapter.clear ? adapter.clear() : adapter.save({ v: SETTINGS_VERSION, settings: {} });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* ignore */
      }
      notify();
      return this.get();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
