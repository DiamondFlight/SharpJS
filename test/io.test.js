import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSounding, fromArrays, exportSounding, parseBufkit, listBufkitForecastHours, isBufkitText,
  parseIemRaob, buildVwpSounding, toSounding, withLocation,
} from '../src/core.js';
import { fixture, sample } from './helpers.js';

test('parses SHARPpy text', () => {
  const s = parseSounding(sample('koun-1999-05-04-00z.txt'));
  assert.equal(s.Title.trim(), 'KOUN 19990504/0000');
  assert.equal(s.Sounding.Slice.length, 59);
  const [p, h, t, d, wd, ws] = s.Sounding.Slice[0];
  assert.deepEqual([p, h, t, d, wd, ws], [959, 362, 22.3, 19.1, 160, 18]);
  assert.equal(s.Sounding.Slice[0].length, 8, 'rows are [P, H, T, D, WD, WS, WB, OMEGA]');
});

test('rejects text it cannot read', () => {
  assert.throws(() => parseSounding('hello world'), /unrecognized sounding format/);
  assert.throws(() => parseSounding(''), /empty/);
});

test('SHARPpy export round-trips', () => {
  const s = parseSounding(sample('koax-2014-06-16-19z.txt'));
  for (const format of ['Default', 'SharpJS']) {
    const { text, filename } = exportSounding(s, format, { savedBy: 'test' });
    assert.match(text, /^%TITLE%\n/);
    assert.match(text, /Saved by: test/);
    assert.match(filename, /^SharpJS_Sounding_koax_20140616_1900\.txt$/);
    const back = parseSounding(text);
    assert.equal(back.Sounding.Slice.length, s.Sounding.Slice.length);
    back.Sounding.Slice.forEach((row, i) => {
      for (let c = 0; c < 6; c++) assert.ok(Math.abs(row[c] - s.Sounding.Slice[i][c]) < 0.01, `${format} row ${i} col ${c}`);
    });
  }
});

test('CM1 export can be read back', () => {
  const s = parseSounding(sample('koun-2013-05-20-12z.txt'));
  const { text, filename } = exportSounding(s, 'CM1');
  assert.equal(filename, 'input_sounding.txt');
  const back = parseSounding(text);
  assert.equal(back.Sounding.Slice.length, s.Sounding.Slice.length - 1);
  // CM1 heights are above ground; compare temperature 3 km above the surface
  const sfc = s.Sounding.Slice[0][1];
  const t3 = (snd, base) => snd.Sounding.Slice.find((r) => r[1] - base >= 3000)[2];
  assert.ok(Math.abs(t3(back, 0) - t3(s, sfc)) < 1, `${t3(back, 0)} vs ${t3(s, sfc)}`);
});

test('fromArrays: dewpoint + direction/speed', () => {
  const s = fromArrays({
    pressure: [1000, 850, 700, 500, 300],
    height: [110, 1500, 3100, 5700, 9400],
    temperature: [25, 15, 6, -10, -40],
    dewpoint: [20, 12, 0, -25, -55],
    windDirection: [160, 200, 230, 250, 260],
    windSpeed: [10, 30, 40, 50, 70],
  }, { title: 'Test', location: { lat: 35, lon: -97 } });
  assert.equal(s.Title, 'Test');
  assert.equal(s.Sounding.Slice.length, 5);
  assert.deepEqual(s.Location, [35, -97]);
  assert.deepEqual(s.Location2, [35, 97]);
  assert.equal(s.meta.isModel, false);
});

test('fromArrays: Kelvin, RH, u/v in m/s, omega, computed heights, any order', () => {
  const s = fromArrays({
    pressure: [300, 500, 700, 850, 1000],
    temperature: [233.15, 263.15, 279.15, 288.15, 298.15],
    relativeHumidity: [20, 30, 60, 80, 75],
    u: [30, 20, 10, 5, 0],
    v: [10, 5, 5, 5, 5],
    omega: [-0.5, -1, -0.2, 0, 0],
  }, { units: { temperature: 'K' }, isModel: true, elevation: 300 });
  const sfc = s.Sounding.Slice[0];
  assert.equal(sfc[0], 1000);
  assert.equal(sfc[1], 300);
  assert.ok(Math.abs(sfc[2] - 25) < 1e-6);
  assert.ok(sfc[3] < 25 && sfc[3] > 19, 'dewpoint from 75% RH');
  assert.ok(Math.abs(sfc[5] - 5 * 1.943844) < 0.01, 'wind speed in knots');
  assert.equal(Math.round(sfc[4]), 180, 'v=+5 is a south wind');
  const top = s.Sounding.Slice.at(-1);
  assert.ok(top[1] > 9000 && top[1] < 9700, 'hypsometric 300 mb height');
  assert.equal(s.Sounding.OMEGA[2], 0.004, '-omega/50 at 700 mb');
  assert.equal(s.meta.isModel, true);
});

test('BUFKIT: columns from SNPARM, forecast hours, location', () => {
  const text = fixture('rap_kdsm_2024052612.buf');
  assert.ok(isBufkitText(text));
  const hours = listBufkitForecastHours(text);
  assert.deepEqual(hours.slice(0, 4), [0, 1, 2, 3]);
  const s = parseBufkit(text, { forecastHour: 3, model: 'rap' });
  assert.equal(s.Title.trim(), 'RAP 05-26-2024 12Z - F003; Valid: 05-26-2024 15Z; Location: 41.53N, -93.65W');
  assert.equal(s.Sounding.Slice.length, 50);
  assert.deepEqual(s.Coords, { lat: 41.53, lon: -93.65 });
  assert.equal(s.meta.forecastHour, 3);
  // LF line endings work too
  const lf = parseBufkit(text.replace(/\r\n/g, '\n'), { forecastHour: 3, model: 'rap' });
  assert.deepEqual(lf.Sounding.Slice, s.Sounding.Slice);
  // parseSounding detects BUFKIT and uses the file name for the model
  assert.match(parseSounding(text, { fileName: 'rap_kdsm.buf' }).Title, /^\s*RAP 05-26-2024 12Z - F000/);
  assert.throws(() => parseBufkit(text, { forecastHour: 999 }), /F999 not found/);
});

test('IEM RAOB JSON', () => {
  const s = parseIemRaob(JSON.parse(fixture('iem-koax-2014061619.json')));
  assert.equal(s.Title.trim(), 'KOAX 20140616/1900');
  assert.equal(s.Sounding.Slice.length, 147);
  assert.equal(s.meta.station, 'KOAX');
  assert.throws(() => parseIemRaob({ profiles: [] }), /no RAOB launches/);
});

test('NEXRAD VWP', () => {
  const bytes = fixture('OAX_NVW_2024_05_26_12_01_43', null);
  const s = buildVwpSounding(bytes);
  assert.equal(s.Title, 'VWP OAX — valid 26 May 2024 12:01 UTC');
  assert.equal(s.Sounding.W.length, 11, 'surface + radar gates');
  assert.equal(s.Sounding.W[0].H, 0);
  assert.deepEqual(s.Location, [41.32, -96.367]);
  const over = buildVwpSounding(bytes, { background: parseSounding(sample('koax-2014-06-16-19z.txt')) });
  assert.equal(over.Sounding.W.length, 11);
});

test('toSounding / withLocation', () => {
  const parsed = parseSounding(sample('kbuf-2014-11-18-12z.txt'));
  assert.equal(toSounding(parsed), parsed);
  assert.throws(() => toSounding(42), /expected sounding text/);
  withLocation(parsed, { lat: 42.93, lon: 281.3 });
  assert.equal(parsed.Coords.lat, 42.93);
  assert.ok(Math.abs(parsed.Coords.lon - -78.7) < 1e-9, 'longitude wrapped to [-180, 180]');
});
