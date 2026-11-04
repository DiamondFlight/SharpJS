const AVIATION_STATIONS = new URL('../data/stations.json', import.meta.url);
let aviationStationCatalog = null;

/**
 * Load the bundled Aviation Weather Center station catalog.
 * @param {Function} [fetchImpl] Fetch-compatible function.
 * @returns {Promise<object[]>} Station records with geographic metadata.
 */
export async function getAviationStationCatalog(fetchImpl = fetch) {
  if (fetchImpl !== globalThis.fetch) return loadCatalog(fetchImpl);
  aviationStationCatalog ??= loadCatalog(fetchImpl).catch((error) => {
    aviationStationCatalog = null;
    throw error;
  });
  return aviationStationCatalog;
}

/**
 * Index catalog identifiers, including three-letter airport aliases.
 * @param {object[]} records Station records.
 * @returns {Map<string, object>} Normalized station id to metadata.
 */
export function indexAviationStations(records) {
  const index = new Map();
  const add = (id, record) => {
    const key = String(id || '').trim().toUpperCase();
    if (key && !index.has(key)) index.set(key, record);
  };
  for (const record of records) {
    for (const key of ['icaoId', 'faaId', 'iataId', 'id', 'wmoId']) add(record[key], record);
  }
  for (const record of records) {
    for (const key of ['icaoId', 'faaId', 'iataId', 'id', 'wmoId']) {
      const id = String(record[key] || '').trim().toUpperCase();
      if (/^K[A-Z0-9]{3}$/.test(id)) add(id.slice(1), record);
      if (/^[A-Z0-9]{3}$/.test(id)) add(`K${id}`, record);
    }
  }
  return index;
}

async function loadCatalog(fetchImpl) {
  const response = await fetchImpl(AVIATION_STATIONS.href);
  if (!response.ok) throw new Error(`Could not load station location metadata (HTTP ${response.status}).`);
  const records = await response.json();
  if (!Array.isArray(records)) throw new Error('The station location service returned an invalid catalog.');
  return records;
}
