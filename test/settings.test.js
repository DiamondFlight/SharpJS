import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, SETTINGS_VERSION, sanitizeSettings, diffFromDefaults, migrate,
  createSettingsStore, memoryAdapter, cookieAdapter, resolveAdapter,
} from '../src/core.js';

test('sanitize keeps valid values and drops the rest', () => {
  const s = sanitizeSettings({
    units: 'metric',
    skewTSkew: 0.3,
    hodographColorTable: 2,
    presetOverrides: { WindLapse: 'Winter' },
    removedInAnOlderRelease: true,
    readOut: 'yes',
  });
  assert.equal(s.units, 'metric');
  assert.equal(s.skewTSkew, DEFAULT_SETTINGS.skewTSkew);
  assert.equal(s.hodographColorTable, 2);
  assert.deepEqual(s.presetOverrides, { WindLapse: 'Winter', Inset: 'auto', Vertical: 'auto', SidePanel: 'auto' });
  assert.equal(s.readOut, DEFAULT_SETTINGS.readOut);
  assert.ok(!('removedInAnOlderRelease' in s));
});

test('only changed keys are stored, so new defaults reach existing users', () => {
  const s = sanitizeSettings({ units: 'imperial', defaultParcel: 'MU' });
  assert.deepEqual(diffFromDefaults(s), { units: 'imperial' });
});

test('migrate understands the current payload', () => {
  assert.deepEqual(migrate({ v: SETTINGS_VERSION, settings: { units: 'metric' } }), { units: 'metric' });
  assert.deepEqual(migrate(null), {});
});

test('store: set, persist, reload, reset', () => {
  const adapter = memoryAdapter();
  const a = createSettingsStore({ persist: adapter });
  const seen = [];
  a.subscribe((s) => seen.push(s.units));
  assert.equal(a.set({ units: 'metric' }), true);
  assert.equal(a.set({ units: 'metric' }), false, 'no-op when nothing changes');
  assert.deepEqual(seen, ['metric']);
  assert.deepEqual(adapter.load(), { v: SETTINGS_VERSION, settings: { units: 'metric' } });

  const b = createSettingsStore({ persist: adapter });
  assert.equal(b.get().units, 'metric');

  b.reset();
  assert.equal(b.get().units, 'default');
  assert.equal(adapter.load(), null);
});

test('store: host defaults sit under saved settings, overrides on top', () => {
  const adapter = memoryAdapter({ v: 1, settings: { units: 'metric', hodographNumbers: true } });
  const s = createSettingsStore({ persist: adapter, defaults: { units: 'imperial', readOut: false }, overrides: { hodographNumbers: false } });
  const v = s.get();
  assert.equal(v.units, 'metric');
  assert.equal(v.readOut, false);
  assert.equal(v.hodographNumbers, false);
});

test('store: async adapters (e.g. a server profile)', async () => {
  let saved = { v: 1, settings: { units: 'imperial' } };
  const adapter = {
    kind: 'server',
    load: async () => saved,
    save: async (p) => { saved = p; },
  };
  const s = createSettingsStore({ persist: adapter });
  assert.equal(s.get().units, 'default');
  await s.ready;
  assert.equal(s.get().units, 'imperial');
  s.set({ efScale: 'EF0+' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(saved.settings, { units: 'imperial', efScale: 'EF0+' });
  assert.equal(s.storage, 'server');
});

test('cookie adapter', () => {
  const jar = new Map();
  globalThis.document = {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(str) {
      const [pair, ...attrs] = str.split('; ');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a === 'Max-Age=0')) jar.delete(k); else jar.set(k, v);
    },
  };
  try {
    const store = createSettingsStore({ persist: 'cookie', key: 'sharpjs:settings' });
    assert.equal(store.storage, 'cookie');
    store.set({ units: 'metric', presetOverrides: { SidePanel: 'Winter' } });
    assert.ok(jar.has('sharpjs_settings'));
    assert.ok(jar.get('sharpjs_settings').length < 400, 'well under the 4 KB cookie limit');
    const again = createSettingsStore({ persist: cookieAdapter('sharpjs_settings') });
    assert.equal(again.get().units, 'metric');
    assert.equal(again.get().presetOverrides.SidePanel, 'Winter');
    again.reset();
    assert.ok(!jar.has('sharpjs_settings'));
  } finally {
    delete globalThis.document;
  }
});

test('resolveAdapter', () => {
  assert.equal(resolveAdapter(false).kind, 'memory');
  assert.equal(resolveAdapter('memory').kind, 'memory');
  const custom = { load: () => null, save: () => {} };
  assert.equal(resolveAdapter(custom), custom);
  assert.equal(resolveAdapter('auto').kind, 'memory', 'no browser storage in Node');
});
