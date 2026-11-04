import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionTo, distanceMiles, findNearbyTown } from '../src/io/nearby_town.js';

test('findNearbyTown requests a global reverse lookup and returns a town coordinate', async () => {
  let requestUrl;
  let requestOptions;
  const town = await findNearbyTown({ lat: 35.2, lon: -97.4 }, async (url, options) => {
    requestUrl = new URL(url);
    requestOptions = options;
    return {
      ok: true,
      json: async () => ({
        lat: '35.222',
        lon: '-97.444',
        address: { city: 'Norman', town: 'Ignored', state: 'Oklahoma' },
      }),
    };
  });

  assert.equal(requestUrl.hostname, 'nominatim.openstreetmap.org');
  assert.equal(requestUrl.searchParams.get('lat'), '35.2');
  assert.equal(requestUrl.searchParams.get('lon'), '-97.4');
  assert.equal(requestUrl.searchParams.get('zoom'), '10');
  assert.equal(requestOptions.headers['Accept-Language'], 'en');
  assert.deepEqual(town, { name: 'Norman', state: 'Oklahoma', lat: 35.222, lon: -97.444 });
});

test('findNearbyTown returns null when no town is represented in the result', async () => {
  const town = await findNearbyTown({ lat: 0, lon: 0 }, async () => ({
    ok: true,
    json: async () => ({ lat: '0', lon: '0', address: { ocean: 'Atlantic Ocean' } }),
  }));
  assert.equal(town, null);
});

test('findNearbyTown reports invalid coordinates and HTTP errors', async () => {
  await assert.rejects(findNearbyTown({ lat: 91, lon: 0 }, async () => {}), /valid latitude and longitude/);
  await assert.rejects(
    findNearbyTown({ lat: 35, lon: -97 }, async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
});

test('distanceMiles calculates great-circle statute miles', () => {
  assert.equal(distanceMiles({ lat: 35, lon: -97 }, { lat: 35, lon: -97 }), 0);
  assert.ok(Math.abs(distanceMiles({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 69.09) < 0.1);
});

test('directionTo returns the compass direction and handles identical coordinates', () => {
  assert.equal(directionTo({ lat: 35, lon: -97 }, { lat: 36, lon: -96 }), 'NE');
  assert.equal(directionTo({ lat: 35, lon: -97 }, { lat: 35, lon: -97 }), null);
});
