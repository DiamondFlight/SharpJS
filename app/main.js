import { SharpJS, VERSION, exportSounding } from '../src/index.js';
import * as sources from '../src/sources/index.js';

const LAST_SOUNDING_KEY = 'sharpjs:lastSounding';
const samplesSelect = document.getElementById('samples');
document.getElementById('version').textContent = `v${VERSION}`;

const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const chart = SharpJS('#chart', {
  sources,
  persist: 'auto',
  onLoad(sounding) {
    // Remember the last sounding so a reload brings it back (best effort; the text is small).
    const data = exportSounding(sounding, 'SharpJS');
    if (data && data.text.length < 500_000) storage.set(LAST_SOUNDING_KEY, { text: data.text, location: sounding.Coords || null });
  },
});

let samples = [];

async function loadSample(file) {
  const res = await fetch(`./samples/${file}`);
  if (!res.ok) throw new Error(`Sample ${file}: HTTP ${res.status}`);
  const entry = samples.find((s) => s.file === file);
  chart.load(await res.text(), { location: entry?.location });
}

samplesSelect.addEventListener('change', () => {
  const file = samplesSelect.value;
  if (file) loadSample(file).catch((err) => console.error(err));
});

samples = await fetch('./samples/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
for (const s of samples) {
  const opt = document.createElement('option');
  opt.value = s.file;
  opt.textContent = s.label;
  samplesSelect.append(opt);
}

const last = storage.get(LAST_SOUNDING_KEY);
if (last && typeof last.text === 'string') {
  chart.load(last.text, { location: last.location || undefined });
} else if (samples.length) {
  samplesSelect.value = samples[0].file;
  await loadSample(samples[0].file);
}

// Handy from the browser console.
window.sharpjs = chart;
