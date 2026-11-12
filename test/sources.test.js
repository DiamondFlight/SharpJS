import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchIemRaob,
  fetchIemBufkit,
  fetchIemBufkitForecasts,
  fetchNexradVwp,
  fetchNexradVwpArchive,
  listAcarsArchive,
  fetchAcarsArchive,
  fetchNexradVwpRadarStations,
} from '../src/sources/index.js';
import { fixture, sample } from './helpers.js';

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
  assert.match(s.Title, /Location: 41\.53N, 93\.65W$/);
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
    location: { lat: -34.9, lon: 138.6 },
    fetch,
  });
  assert.equal(fetch.calls.length, 1);
  assert.ok(soundings.length > 1);
  assert.deepEqual(soundings.map((sounding) => sounding.meta.forecastHour), soundings.map((sounding) => sounding.meta.forecastHour).sort((a, b) => a - b));
  assert.deepEqual(soundings[0].Coords, { lat: -34.9, lon: 138.6 });
  assert.deepEqual(soundings[0].Location, [-34.9, 138.6]);
  assert.deepEqual(soundings[0].Location2, [-34.9, -138.6]);
  assert.match(soundings[0].Title, /Location: 34\.90S, 138\.60E$/);
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

test('ACARS listing scans the inclusive six-hour UTC window and filters archive timestamps', async () => {
  const calls = [];
  const fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/2026/03/20/10/')) {
      return { ok: true, text: async () => '<a href="ABQ_0959.txt">ABQ_0959.txt</a><a href="ABQ_1000.txt">ABQ_1000.txt</a>' };
    }
    if (url.endsWith('/2026/03/20/16/')) {
      return { ok: true, text: async () => '<a href="SAN_1600.txt">SAN_1600.txt</a><a href="SAN_1640.txt">SAN_1640.txt</a>' };
    }
    return { ok: false, status: 404 };
  };
  const reports = await listAcarsArchive({
    time: '2026-03-20T16:00:00Z',
    baseUrl: 'https://proxy.example/acars/',
    fetch,
  });
  assert.deepEqual(reports.map(({ station, time }) => [station, new Date(time).toISOString()]), [
    ['ABQ', '2026-03-20T10:00:00.000Z'],
    ['SAN', '2026-03-20T16:00:00.000Z'],
  ]);
  assert.equal(calls.length, 7, 'scans the start and end hour directories');
  assert.ok(calls[0].startsWith('https://proxy.example/acars/2026/03/20/10/'));
  assert.ok(calls.at(-1).startsWith('https://proxy.example/acars/2026/03/20/16/'));
  await assert.rejects(listAcarsArchive({ time: '2026-03-20T16:00:00Z', hours: 25, fetch }), /no more than 24/);
});

test('ACARS archive parses SHARPpy files, attaches airport coordinates, and reports progress', async () => {
  const calls = [];
  const reportText = sample('koun-1999-05-04-00z.txt').replace('KOUN 19990504/0000', 'SAN 260320/1559');
  const fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/2026/03/20/16/')) {
      if (url.endsWith('/16/')) return { ok: true, text: async () => '<a href="SAN_1600.txt">SAN_1600.txt</a>' };
      return { ok: true, text: async () => reportText };
    }
    if (url.endsWith('/stations.json')) {
      return {
        ok: true,
        json: async () => [{
          id: 'KSAN', icaoId: 'KSAN', iataId: 'SAN', faaId: 'SAN',
          site: 'San Diego Intl Arpt', state: 'CA', country: 'US', lat: 32.73645, lon: -117.19727,
        }],
      };
    }
    return { ok: false, status: 404 };
  };
  const progress = [];
  const soundings = await fetchAcarsArchive({
    time: '2026-03-20T16:00:00Z',
    fetch,
    onSounding(sounding, state) {
      progress.push([sounding, state.index, state.total, state.station]);
    },
  });
  assert.equal(soundings.length, 1);
  assert.equal(soundings[0].meta.source, 'acars');
  assert.equal(soundings[0].meta.station, 'SAN');
  assert.equal(soundings[0].meta.archiveTime, '2026-03-20T15:59:00.000Z');
  assert.equal(soundings[0].meta.fileTime, '2026-03-20T16:00:00.000Z');
  assert.match(soundings[0].Title, /^ACARS OBSERVED: SAN - VALID 03 20 2026 - 1559Z$/);
  assert.deepEqual(soundings[0].Coords, { lat: 32.73645, lon: -117.19727 });
  assert.ok(soundings[0].Sounding.Slice.length > 2);
  assert.deepEqual(progress.map(([, index, total, station]) => [index, total, station]), [[1, 1, 'SAN']]);
  assert.ok(calls.some((url) => url.endsWith('/SAN_1600.txt')));
  assert.ok(calls.some((url) => url.startsWith('https://sharp.weather.ou.edu/soundings/acars/')));
});

test('ACARS network failures explain the cross-origin proxy requirement', async () => {
  await assert.rejects(
    listAcarsArchive({
      time: '2026-03-20T16:00:00Z',
      fetch: async () => { throw new TypeError('Failed to fetch'); },
    }),
    /same-origin deployment or configure a CORS-enabled ACARS proxy/,
  );
});

test('fetchNexradVwpRadarStations returns mapped WSR-88D locations only', async () => {
  const fetch = mockFetch([[
    'api.weather.gov/radar/stations',
    JSON.stringify({
      features: [
        { properties: { id: 'KOAX', name: 'Omaha', stationType: 'WSR-88D' }, geometry: { coordinates: [-96.367, 41.32] } },
        { properties: { id: 'KXYZ', name: 'Other sensor', stationType: 'TDWR' }, geometry: { coordinates: [-90, 40] } },
      ],
    }),
  ]]);
  const stations = await fetchNexradVwpRadarStations({ fetch });
  assert.deepEqual(stations, [{
    code: 'OAX', city: 'Omaha', state: '', country: 'United States', lat: 41.32, lon: -96.367,
  }]);
});
