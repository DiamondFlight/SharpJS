import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchIemRaob,
  fetchIemBufkit,
  fetchIemBufkitForecasts,
  fetchNexradVwp,
  fetchNexradVwpArchive,
} from '../src/sources/index.js';
import { fixture } from './helpers.js';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [match, body] of routes) {
      if (url.includes(match)) {
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => String(body), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
      }
    }
    return { ok: false, status: 404 };
  };
  fn.calls = calls;
  return fn;
}

test('fetchIemRaob builds the IEM request and adds the station location', async () => {
  const fetch = mockFetch([
    ['json/raob.py', fixture('iem-koax-2014061619.json')],
    ['RAOB.geojson', fixture('raob-stations.geojson')],
  ]);
  const s = await fetchIemRaob({ station: 'oax', time: '2014-06-16T19:00:00Z', fetch });
  assert.ok(fetch.calls[0].endsWith('raob.py?station=OAX&ts=2014-06-16T19:00:00Z'));
  assert.equal(s.Title.trim(), 'KOAX 20140616/1900');
  assert.deepEqual(s.Location2, [41.32, 95.6]);
});

test('fetchIemBufkit picks the archive path for the model', async () => {
  const fetch = mockFetch([['bufkit/12/rap/rap_kdsm.buf', fixture('rap_kdsm_2024052612.buf')]]);
  const s = await fetchIemBufkit({ model: 'rap', station: 'kdsm', run: '2024-05-26T12:00:00Z', forecastHour: 3, fetch });
  assert.equal(fetch.calls[0], 'https://mtarchive.geol.iastate.edu/2024/05/26/bufkit/12/rap/rap_kdsm.buf');
  assert.match(s.Title, /F003/);
  await assert.rejects(
    fetchIemBufkit({ model: 'gfs', station: 'kdsm', run: '2024-05-26T06:00:00Z', fetch }),
    /No GFS BUFKIT for KDSM at 06Z 2024-05-26/,
  );
  assert.ok(fetch.calls.at(-1).endsWith('/bufkit/06/gfs/gfs3_kdsm.buf'));
});

test('fetchIemBufkitForecasts parses every forecast from one archive download', async () => {
  const fetch = mockFetch([['bufkit/12/rap/rap_kdsm.buf', fixture('rap_kdsm_2024052612.buf')]]);
  const soundings = await fetchIemBufkitForecasts({
    model: 'rap',
    station: 'kdsm',
    run: '2024-05-26T12:00:00Z',
    fetch,
  });
  assert.equal(fetch.calls.length, 1);
  assert.ok(soundings.length > 1);
  assert.deepEqual(soundings.map((sounding) => sounding.meta.forecastHour), soundings.map((sounding) => sounding.meta.forecastHour).sort((a, b) => a - b));
});

test('fetchNexradVwp lists the hour and loads the newest volume', async () => {
  const listing = '<ListBucketResult><Contents><Key>OAX_NVW_2024_05_26_12_01_43</Key></Contents><Contents><Key>OAX_NVW_2024_05_26_12_08_40</Key></Contents></ListBucketResult>';
  const fetch = mockFetch([
    ['list-type=2', listing],
    ['OAX_NVW_2024_05_26_12_08_40', fixture('OAX_NVW_2024_05_26_12_01_43', null)],
  ]);
  const s = await fetchNexradVwp({ radar: 'KOAX', time: '2024-05-26T12:10:00Z', fetch });
  assert.match(fetch.calls[0], /prefix=OAX_NVW_2024_05_26_12/);
  assert.ok(fetch.calls[1].endsWith('/OAX_NVW_2024_05_26_12_08_40'));
  assert.match(s.Title, /^VWP OAX/);
});

test('fetchNexradVwpArchive loads every volume in the inclusive UTC window incrementally', async () => {
  const fixtureBytes = fixture('OAX_NVW_2024_05_26_12_01_43', null);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes('list-type=2')) {
      const prefix = new URL(url).searchParams.get('prefix');
      const keys = prefix.endsWith('_12')
        ? ['OAX_NVW_2024_05_26_12_01_43', 'OAX_NVW_2024_05_26_12_08_40']
        : prefix.endsWith('_13')
          ? ['OAX_NVW_2024_05_26_13_00_00']
          : [];
      return {
        ok: true,
        status: 200,
        text: async () => `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}</ListBucketResult>`,
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength),
    };
  };
  const progress = [];
  const soundings = await fetchNexradVwpArchive({
    radar: 'KOAX',
    start: '2024-05-26T12:00:00Z',
    end: '2024-05-26T13:00:00Z',
    fetch,
    onVolume(sounding, state) {
      progress.push([sounding, state.index, state.total]);
    },
  });
  assert.equal(soundings.length, 3);
  assert.deepEqual(progress.map(([, index, total]) => [index, total]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(calls.filter((url) => url.includes('list-type=2')).length, 2);
  assert.equal(calls.filter((url) => !url.includes('list-type=2')).length, 3);
});
