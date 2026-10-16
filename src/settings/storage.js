import { alwaysAvailable } from '../io/general.js';

/**
 * Where settings live. An adapter is any object with
 *   load(): payload | null | Promise<payload | null>
 *   save(payload): void | Promise<void>
 *   clear?(): void | Promise<void>
 * where payload is the JSON-safe object { v, settings }.
 *
 * Hosts with accounts can pass their own adapter (e.g. one that reads and writes a user
 * profile on their server) instead of the browser-storage ones below.
 */

/** localStorage, when the browser allows it (it can throw in private mode or when blocked). */
export function localStorageAdapter(key = 'sharpjs:settings') {
  const storage = () => {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    } catch {
      return null;
    }
  };
  return {
    kind: 'localStorage',
    available() {
      const s = storage();
      if (!s) return false;
      try {
        const probe = `${key}:probe`;
        s.setItem(probe, '1');
        s.removeItem(probe);
        return true;
      } catch {
        return false;
      }
    },
    load() {
      try {
        const raw = storage()?.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save(payload) {
      try {
        storage()?.setItem(key, JSON.stringify(payload));
      } catch {
        /* quota or blocked storage: settings just won't persist */
      }
    },
    clear() {
      try {
        storage()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * A first-party cookie. Settings are a few hundred bytes, well under the 4 KB cookie limit.
 * @param {string} [name]
 * @param {object} [opts]
 * @param {number} [opts.days=365]
 * @param {string} [opts.path='/']
 * @param {string} [opts.sameSite='Lax']
 * @param {string} [opts.domain]  share settings across subdomains, e.g. ".example.com"
 */
export function cookieAdapter(name = 'sharpjs_settings', { days = 365, path = '/', sameSite = 'Lax', domain } = {}) {
  const hasDocument = () => typeof document !== 'undefined' && typeof document.cookie === 'string';
  const read = () => {
    if (!hasDocument()) return null;
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const c = part.trim();
      if (c.startsWith(prefix)) return c.slice(prefix.length);
    }
    return null;
  };
  const write = (value, maxAge) => {
    if (!hasDocument()) return;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    const dom = domain ? `; Domain=${domain}` : '';
    document.cookie = `${name}=${value}; Max-Age=${maxAge}; Path=${path}; SameSite=${sameSite}${dom}${secure}`;
  };
  return {
    kind: 'cookie',
    available() {
      if (!hasDocument()) return false;
      try {
        return navigator.cookieEnabled !== false;
      } catch {
        return true;
      }
    },
    load() {
      try {
        const raw = read();
        return raw ? JSON.parse(decodeURIComponent(raw)) : null;
      } catch {
        return null;
      }
    },
    save(payload) {
      write(encodeURIComponent(JSON.stringify(payload)), Math.round(days * 86400));
    },
    clear() {
      write('', 0);
    },
  };
}

/** Keeps settings for the life of the page only. */
export function memoryAdapter(initial = null) {
  let payload = initial;
  return {
    kind: 'memory',
    available: alwaysAvailable,
    load: () => payload,
    save(next) {
      payload = JSON.parse(JSON.stringify(next));
    },
    clear() {
      payload = null;
    },
  };
}

/**
 * localStorage when available, otherwise a cookie, otherwise memory.
 * Reads fall back too, so settings saved by an older cookie-only build are still found.
 */
export function autoAdapter(key = 'sharpjs:settings') {
  const local = localStorageAdapter(key);
  const cookie = cookieAdapter(key.replace(/[^A-Za-z0-9_-]/g, '_'));
  const primary = local.available() ? local : cookie.available() ? cookie : memoryAdapter();
  return {
    kind: primary.kind,
    available: alwaysAvailable,
    load() {
      return primary.load() ?? (primary !== cookie && cookie.available() ? cookie.load() : null);
    },
    save(payload) {
      primary.save(payload);
    },
    clear() {
      primary.clear?.();
      if (primary !== cookie) cookie.clear?.();
    },
  };
}

/**
 * Turn the `persist` option into an adapter.
 * @param {boolean|'auto'|'local'|'cookie'|'memory'|object} persist
 * @param {string} key
 */
export function resolveAdapter(persist, key = 'sharpjs:settings') {
  if (persist && typeof persist === 'object' && typeof persist.load === 'function' && typeof persist.save === 'function') {
    return persist;
  }
  switch (persist) {
    case false:
    case 'memory':
      return memoryAdapter();
    case 'local':
      return localStorageAdapter(key);
    case 'cookie':
      return cookieAdapter(key.replace(/[^A-Za-z0-9_-]/g, '_'));
    default:
      return autoAdapter(key);
  }
}
