const IEM_BUFKIT = 'https://mtarchive.geol.iastate.edu';
const AVIATION_STATIONS = new URL('../data/stations.json', import.meta.url);
const TILE_SERVER = 'https://tile.openstreetmap.org';
const TILE_SIZE = 256;
const stationCatalogByModelRun = new Map();
let aviationStationCatalog = null;
let nextDialogId = 0;
const SVG_NS = 'http://www.w3.org/2000/svg';
const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands',
};

/**
 * Creates a plain-JavaScript BUFKIT location picker button and its map dialog.
 * @param {object} options Picker configuration.
 * @param {Document} options.document Document used to create the picker UI.
 * @param {HTMLElement} options.host SharpJS host used for theming and dialog placement.
 * @param {() => string} options.getModel Returns the selected BUFKIT model.
 * @param {() => Date} options.getRun Returns the selected BUFKIT run date and hour.
 * @param {(station: string) => void} options.onSelect Receives the selected station code.
 * @returns {{button: HTMLButtonElement, destroy: () => void}} Picker button and cleanup function.
 */
export function createBufkitMapButton({ document: doc, host, getModel, getRun, onSelect }) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'sjs-button';
  button.textContent = 'Choose station from map…';
  button.setAttribute('aria-haspopup', 'dialog');

  const dialog = doc.createElement('dialog');
  dialog.className = 'sjs-bufkit-map-dialog';
  const titleId = `sjs-bufkit-map-title-${++nextDialogId}`;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `
    <style>
      .sjs-bufkit-map-dialog {
        width: min(960px, 96vw);
        max-width: 96vw;
        max-height: 92vh;
        padding: 0;
        color: var(--sjs-text, #e8eef2);
        background: var(--sjs-surface, #0d1014);
        border: 1px solid var(--sjs-border, rgba(255, 255, 255, .28));
        border-radius: 8px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, .65);
        font: 14px/1.4 var(--sjs-font, "Segoe UI", Arial, sans-serif);
      }
      .sjs-bufkit-map-dialog::backdrop { background: rgba(0, 0, 0, .72); }
      .sjs-bufkit-map-shell { padding: 14px; }
      .sjs-bufkit-map-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .sjs-bufkit-map-header h2 { margin: 0; font-size: 1rem; }
      .sjs-bufkit-map-close {
        border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer;
        color: inherit; background: var(--sjs-button-bg, #1f262e); font: inherit;
      }
      .sjs-bufkit-map-tools { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
      .sjs-bufkit-map-search {
        flex: 1; min-width: 0; padding: 7px 9px; color: inherit;
        background: var(--sjs-surface-2, #161b21);
        border: 1px solid var(--sjs-border, rgba(255, 255, 255, .28)); border-radius: 4px; font: inherit;
      }
      .sjs-bufkit-map-status { min-height: 1.4em; margin: 0 0 6px; color: var(--sjs-muted, #8ea3b3); font-size: .82rem; }
      .sjs-bufkit-map-viewport {
        position: relative; width: 100%; height: min(62vh, 590px); min-height: 280px;
        overflow: hidden; background: #17232c; border: 1px solid var(--sjs-border, rgba(255, 255, 255, .28));
        border-radius: 5px; touch-action: none; cursor: grab;
      }
      .sjs-bufkit-map-viewport.is-dragging { cursor: grabbing; }
      .sjs-bufkit-map-svg { display: block; width: 100%; height: 100%; }
      .sjs-bufkit-map-marker { fill: #f4b942; stroke: #111820; stroke-width: 1.5; cursor: pointer; }
      .sjs-bufkit-map-marker:hover, .sjs-bufkit-map-marker:focus { fill: #fff; stroke: #e65353; stroke-width: 2.5; outline: none; }
      .sjs-bufkit-map-tooltip {
        position: absolute; z-index: 2; display: none; max-width: 260px; padding: 7px 9px;
        color: #fff; background: rgba(10, 14, 18, .94); border: 1px solid rgba(255, 255, 255, .3);
        border-radius: 4px; pointer-events: none; font-size: .8rem; box-shadow: 0 2px 8px #0008;
      }
      .sjs-bufkit-map-attribution {
        position: absolute; right: 4px; bottom: 3px; padding: 2px 5px;
        color: #17212a; background: rgba(255, 255, 255, .8); font-size: 10px;
      }
      .sjs-bufkit-map-attribution a { color: #17212a; }
      .sjs-bufkit-map-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--sjs-muted, #8ea3b3); font-size: .75rem; }
      .sjs-bufkit-map-zoom { display: flex; gap: 4px; }
      .sjs-bufkit-map-zoom button {
        min-width: 30px; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer;
        color: inherit; background: var(--sjs-button-bg, #1f262e); font: inherit;
      }
      @media (max-width: 600px) {
        .sjs-bufkit-map-shell { padding: 10px; }
        .sjs-bufkit-map-viewport { height: 58vh; min-height: 240px; }
        .sjs-bufkit-map-footer { flex-direction: column; }
      }
    </style>
    <div class="sjs-bufkit-map-shell">
      <div class="sjs-bufkit-map-header">
        <h2 id="${titleId}">Choose a BUFKIT station</h2>
        <button class="sjs-bufkit-map-close" type="button" aria-label="Close station map">Close</button>
      </div>
      <div class="sjs-bufkit-map-tools">
        <input class="sjs-bufkit-map-search" type="search" autocomplete="off" placeholder="Find by station, city, state, or country" aria-label="Search BUFKIT stations">
        <div class="sjs-bufkit-map-zoom">
          <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
        </div>
      </div>
      <p class="sjs-bufkit-map-status" role="status" aria-live="polite"></p>
      <div class="sjs-bufkit-map-viewport" aria-label="BUFKIT station map">
        <svg class="sjs-bufkit-map-svg" role="group" aria-label="Station locations"></svg>
        <div class="sjs-bufkit-map-tooltip" role="tooltip"></div>
        <div class="sjs-bufkit-map-attribution">Map tiles © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></div>
      </div>
      <div class="sjs-bufkit-map-footer">
        <span>Hover or focus a marker for its city, state, country, and station code. Click to fill Station.</span>
        <span>Station metadata: <a href="https://aviationweather.gov/" target="_blank" rel="noopener noreferrer">Aviation Weather Center</a></span>
      </div>
    </div>
  `;
  host.append(dialog);

  const viewport = dialog.querySelector('.sjs-bufkit-map-viewport');
  const svg = dialog.querySelector('.sjs-bufkit-map-svg');
  const tooltip = dialog.querySelector('.sjs-bufkit-map-tooltip');
  const status = dialog.querySelector('.sjs-bufkit-map-status');
  const search = dialog.querySelector('.sjs-bufkit-map-search');
  let stations = [];
  let visibleStations = [];
  let stationsByCode = new Map();
  let center = { lat: 39.5, lon: -98.5 };
  let zoom = 4;
  let pointer = null;
  let dragging = false;
  let destroyed = false;
  let resizeObserver = null;

  /**
   * Opens the station map, loads the selected model's available sites, and focuses search.
   * @returns {Promise<void>} Resolves when the request and initial drawing finish.
   */
  async function openMap() {
    if (!dialog.open) dialog.showModal();
    search.value = '';
    status.textContent = 'Loading BUFKIT stations…';
    svg.replaceChildren();
    try {
      const model = String(getModel() || 'hrrr').toLowerCase();
      const run = getRun();
      const [stationCodes, catalog] = await Promise.all([
        listBufkitStationCodes(model, run),
        getAviationStationCatalog(),
      ]);
      stations = matchStationMetadata(stationCodes, catalog);
      visibleStations = stations;
      stationsByCode = new Map();
      for (const station of stations) stationsByCode.set(station.code, station);
      if (!stations.length) {
        status.textContent = `The ${model.toUpperCase()} archive listing had no stations that could be matched to location metadata.`;
      } else {
        const missing = stationCodes.length - stations.length;
        status.textContent = `${stations.length} ${model.toUpperCase()} locations available${missing ? `; ${missing} station code${missing === 1 ? '' : 's'} lack map metadata` : ''}. Drag to pan or use the wheel to zoom.`;
      }
      requestAnimationFrame(drawMap);
      search.focus();
    } catch (error) {
      console.log(error);
      status.textContent = error.message || String(error);
    }
  }

  /**
   * Converts a geographic point to Web Mercator world-pixel coordinates.
   * @param {number} lat Latitude in degrees.
   * @param {number} lon Longitude in degrees.
   * @param {number} atZoom Slippy-map zoom level.
   * @returns {{x: number, y: number}} Projected world-pixel coordinate.
   */
  function project(lat, lon, atZoom) {
    const size = TILE_SIZE * (2 ** atZoom);
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sin = Math.sin(clampedLat * Math.PI / 180);
    return {
      x: ((lon + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  }

  /**
   * Converts Web Mercator world-pixel coordinates back to latitude and longitude.
   * @param {number} x Projected x-coordinate.
   * @param {number} y Projected y-coordinate.
   * @param {number} atZoom Slippy-map zoom level.
   * @returns {{lat: number, lon: number}} Geographic coordinate.
   */
  function unproject(x, y, atZoom) {
    const size = TILE_SIZE * (2 ** atZoom);
    return {
      lon: (x / size) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI,
    };
  }

  /**
   * Creates an SVG element in the map's namespace.
   * @param {string} tag SVG tag name.
   * @param {object} attrs Attributes to assign.
   * @returns {SVGElement} Constructed SVG element.
   */
  function svgElement(tag, attrs = {}) {
    const element = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    return element;
  }

  /**
   * Draws OSM tiles and matching station markers for the current view.
   * @returns {void}
   */
  function drawMap() {
    if (destroyed || !dialog.open) return;
    const bounds = viewport.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const centerPoint = project(center.lat, center.lon, zoom);
    const left = centerPoint.x - width / 2;
    const top = centerPoint.y - height / 2;
    const firstX = Math.floor(left / TILE_SIZE);
    const lastX = Math.floor((left + width) / TILE_SIZE);
    const firstY = Math.floor(top / TILE_SIZE);
    const lastY = Math.floor((top + height) / TILE_SIZE);
    const worldTiles = 2 ** zoom;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    for (let tileY = firstY; tileY <= lastY; tileY++) {
      if (tileY < 0 || tileY >= worldTiles) continue;
      for (let tileX = firstX; tileX <= lastX; tileX++) {
        const wrappedX = ((tileX % worldTiles) + worldTiles) % worldTiles;
        const image = svgElement('image', {
          x: tileX * TILE_SIZE - left,
          y: tileY * TILE_SIZE - top,
          width: TILE_SIZE,
          height: TILE_SIZE,
          href: `${TILE_SERVER}/${zoom}/${wrappedX}/${tileY}.png`,
          preserveAspectRatio: 'none',
        });
        svg.append(image);
      }
    }

    const markerRadius = zoom >= 7 ? 5 : zoom >= 5 ? 4 : 3;
    for (const station of visibleStations) {
      const point = project(station.lat, station.lon, zoom);
      const x = point.x - left;
      const y = point.y - top;
      if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
      const marker = svgElement('circle', {
        class: 'sjs-bufkit-map-marker',
        'data-station-code': station.code,
        cx: x,
        cy: y,
        r: markerRadius,
        tabindex: 0,
        role: 'button',
        'aria-label': stationAriaLabel(station),
      });
      svg.append(marker);
    }
  }

  /**
   * Prevents a station marker press from starting a map pan.
   * @param {PointerEvent} event Marker pointer event.
   * @returns {void}
   */
  function handleMarkerPointerDown(event) {
    if (event.target.classList.contains('sjs-bufkit-map-marker')) event.stopPropagation();
  }

  /**
   * Selects the station represented by an activated SVG marker.
   * @param {Event} event Marker activation event.
   * @returns {void}
   */
  function handleMarkerClick(event) {
    const code = event.target.dataset.stationCode;
    const station = stationsByCode.get(code);
    if (station) selectStation(event, station);
  }

  /**
   * Shows station metadata when a marker is hovered or receives keyboard focus.
   * @param {Event} event Bubbling pointer or focus event.
   * @returns {void}
   */
  function handleMarkerHover(event) {
    const station = stationsByCode.get(event.target.dataset.stationCode);
    if (station) showTooltip(event, station);
  }

  /**
   * Hides marker metadata when the pointer or keyboard focus leaves the marker.
   * @param {Event} event Bubbling pointer or focus event.
   * @returns {void}
   */
  function handleMarkerLeave(event) {
    const marker = event.target.closest?.('.sjs-bufkit-map-marker');
    const next = event.relatedTarget?.closest?.('.sjs-bufkit-map-marker');
    if (marker && marker !== next) hideTooltip();
  }

  /**
   * Activates a focused station marker with Enter or Space.
   * @param {KeyboardEvent} event Marker keyboard event.
   * @returns {void}
   */
  function handleMarkerKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const station = stationsByCode.get(event.target.dataset.stationCode);
    if (!station) return;
    event.preventDefault();
    selectStation(event, station);
  }

  /**
   * Formats the four station fields shown to users and assistive technology.
   * @param {{code:string, city:string, state:string, country:string}} station Station metadata.
   * @returns {string} Accessible station description.
   */
  function stationAriaLabel(station) {
    return `${station.city}, ${station.state}, ${station.country}; station ${station.code}`;
  }

  /**
   * Positions and displays the station information tooltip.
   * @param {Event} event Pointer or focus event.
   * @param {{code:string, city:string, state:string, country:string}} station Station metadata.
   * @returns {void}
   */
  function showTooltip(event, station) {
    tooltip.replaceChildren();
    const city = doc.createElement('strong');
    city.textContent = station.city;
    tooltip.append(city, doc.createElement('br'));
    tooltip.append(doc.createTextNode(`State: ${station.state} · Country: ${station.country}`), doc.createElement('br'));
    tooltip.append(doc.createTextNode(`Station code: ${station.code}`));
    tooltip.style.display = 'block';
    moveTooltip(event);
  }

  /**
   * Moves the tooltip near a pointer event while keeping it within the map viewport.
   * @param {Event} event Pointer or focus event.
   * @returns {void}
   */
  function moveTooltip(event) {
    const rect = viewport.getBoundingClientRect();
    const clientX = Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2;
    tooltip.style.left = `${Math.max(4, Math.min(rect.width - 270, clientX - rect.left + 12))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(rect.height - 75, clientY - rect.top + 12))}px`;
  }

  /**
   * Hides the currently visible station tooltip.
   * @returns {void}
   */
  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  /**
   * Writes a clicked station code to the controls and closes the picker.
   * @param {Event} event Click or keyboard activation event.
   * @param {{code:string}} station Selected station metadata.
   * @returns {void}
   */
  function selectStation(event, station) {
    event.stopPropagation();
    onSelect(station.code);
    dialog.close();
  }

  /**
   * Filters map stations by code and place fields, then pans to a unique match.
   * @returns {void}
   */
  function filterStations() {
    const query = search.value.trim().toLocaleLowerCase();
    if (!query) {
      visibleStations = stations;
      status.textContent = `${stations.length} BUFKIT locations shown. Drag to pan or use the wheel to zoom.`;
      drawMap();
      return;
    }
    const matches = [];
    for (const station of stations) {
      const description = `${station.code} ${station.city} ${station.state} ${station.country}`.toLocaleLowerCase();
      if (description.includes(query)) matches.push(station);
    }
    visibleStations = matches;
    if (matches.length === 1) {
      center = { lat: matches[0].lat, lon: matches[0].lon };
      zoom = Math.max(zoom, 6);
    }
    status.textContent = `${matches.length} matching ${matches.length === 1 ? 'station' : 'stations'} shown.`;
    drawMap();
  }

  /**
   * Starts a pointer drag unless the user pressed a station marker.
   * @param {PointerEvent} event Pointer down event.
   * @returns {void}
   */
  function startPan(event) {
    if (event.target.classList.contains('sjs-bufkit-map-marker')) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    dragging = true;
    viewport.classList.add('is-dragging');
    viewport.setPointerCapture(event.pointerId);
  }

  /**
   * Updates the map center while dragging the pointer.
   * @param {PointerEvent} event Pointer move event.
   * @returns {void}
   */
  function panMap(event) {
    if (!dragging || !pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    const centerPoint = project(center.lat, center.lon, zoom);
    center = unproject(centerPoint.x - dx, centerPoint.y - dy, zoom);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    drawMap();
  }

  /**
   * Finishes a pointer drag and restores the map cursor.
   * @param {PointerEvent} event Pointer up or cancellation event.
   * @returns {void}
   */
  function stopPan(event) {
    if (pointer && event.pointerId !== pointer.id) return;
    pointer = null;
    dragging = false;
    viewport.classList.remove('is-dragging');
  }

  /**
   * Changes zoom while keeping the current map center fixed.
   * @param {number} delta Zoom increment, normally 1 or -1.
   * @returns {void}
   */
  function changeZoom(delta) {
    zoom = Math.max(2, Math.min(10, zoom + delta));
    drawMap();
  }

  /**
   * Closes the map dialog from its close button.
   * @returns {void}
   */
  function closeDialog() {
    dialog.close();
  }

  /**
   * Handles zoom-in button activation.
   * @returns {void}
   */
  function zoomIn() {
    changeZoom(1);
  }

  /**
   * Handles zoom-out button activation.
   * @returns {void}
   */
  function zoomOut() {
    changeZoom(-1);
  }

  /**
   * Zooms in or out in response to the mouse wheel.
   * @param {WheelEvent} event Wheel event over the map.
   * @returns {void}
   */
  function zoomByWheel(event) {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 1 : -1);
  }

  button.addEventListener('click', openMap);
  dialog.querySelector('.sjs-bufkit-map-close').addEventListener('click', closeDialog);
  dialog.querySelector('[data-zoom="in"]').addEventListener('click', zoomIn);
  dialog.querySelector('[data-zoom="out"]').addEventListener('click', zoomOut);
  search.addEventListener('input', filterStations);
  svg.addEventListener('pointerdown', handleMarkerPointerDown);
  svg.addEventListener('click', handleMarkerClick);
  svg.addEventListener('mouseover', handleMarkerHover);
  svg.addEventListener('mousemove', moveTooltip);
  svg.addEventListener('mouseout', handleMarkerLeave);
  svg.addEventListener('focusin', handleMarkerHover);
  svg.addEventListener('focusout', handleMarkerLeave);
  svg.addEventListener('keydown', handleMarkerKeyDown);
  viewport.addEventListener('pointerdown', startPan);
  viewport.addEventListener('pointermove', panMap);
  viewport.addEventListener('pointerup', stopPan);
  viewport.addEventListener('pointercancel', stopPan);
  viewport.addEventListener('wheel', zoomByWheel, { passive: false });
  dialog.addEventListener('close', hideTooltip);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(drawMap);
    resizeObserver.observe(viewport);
  }

  /**
   * Removes the picker dialog, button, and resize observer.
   * @returns {void}
   */
  function destroyPicker() {
    destroyed = true;
    resizeObserver?.disconnect();
    dialog.close();
    dialog.remove();
    button.remove();
  }

  return { button, destroy: destroyPicker };
}

/**
 * Finds recent BUFKIT archive listings for all cycles on the selected run date.
 * @param {string} model BUFKIT model directory.
 * @param {Date} run Selected run date.
 * @returns {Promise<string[]>} Available station ids in the model archive.
 */
async function listBufkitStationCodes(model, run) {
  if (!(run instanceof Date) || Number.isNaN(run.getTime())) {
    throw new Error('Choose a valid BUFKIT run date before opening the station map.');
  }
  const selectedRun = run;
  const cacheKey = `${model}:${selectedRun.toISOString().slice(0, 10)}`;
  if (stationCatalogByModelRun.has(cacheKey)) return stationCatalogByModelRun.get(cacheKey);

  const request = Promise.all([
    fetchBufkitDirectory(model, selectedRun, 0),
    //fetchBufkitDirectory(model, selectedRun, 6),
    //fetchBufkitDirectory(model, selectedRun, 12),
    //fetchBufkitDirectory(model, selectedRun, 18),
  ]).then(combineStationLists);
  stationCatalogByModelRun.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    stationCatalogByModelRun.delete(cacheKey);
    throw error;
  }
}

/**
 * Merges station IDs returned by the four possible model initialization cycles.
 * @param {string[][]} lists BUFKIT directory station lists.
 * @returns {string[]} Sorted unique station IDs.
 */
function combineStationLists(lists) {
  return [...new Set(lists.flat())].sort();
}

/**
 * Fetches and parses one IEM model-run directory listing.
 * @param {string} model BUFKIT model directory.
 * @param {Date} run Selected run date.
 * @param {number} hour Forecast initialization hour in UTC.
 * @returns {Promise<string[]>} Station ids found in the directory.
 */
async function fetchBufkitDirectory(model, run, hour) {
  const day = new Date(Date.UTC(run.getUTCFullYear(), run.getUTCMonth(), run.getUTCDate()));
  const datePath = `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`;
  const directory = `${IEM_BUFKIT}/${datePath}/bufkit/${pad(hour)}/${encodeURIComponent(model)}/`;
  const response = await fetch(directory);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not load the IEM BUFKIT station list (HTTP ${response.status}).`);

  const html = await response.text();
  const prefix = model === 'gfs' ? 'gfs3' : model === 'nam' && (hour === 6 || hour === 18) ? 'namm' : model;
  const ids = [];
  const listing = new DOMParser().parseFromString(html, 'text/html');
  for (const link of listing.querySelectorAll('a')) {
    const fileName = link.textContent.trim();
    if (!fileName.toLowerCase().endsWith('.buf')) continue;
    const stem = fileName.slice(0, -4);
    const marker = `${prefix}_`;
    if (stem.toLowerCase().startsWith(marker.toLowerCase())) {
      const code = stem.slice(marker.length).trim();
      if (code) ids.push(code);
    }
  }
  return ids;
}

/**
 * Retrieves and caches the public Aviation Weather Center station metadata.
 * @returns {Promise<object[]>} Station records with identifiers and geographic metadata.
 */
async function getAviationStationCatalog() {
  aviationStationCatalog ??= fetch(AVIATION_STATIONS)
    .then(parseAviationStationResponse)
    .then(validateAviationStationRecords)
    .catch(resetAviationStationCatalog);
  return aviationStationCatalog;
}

/**
 * Parses the HTTP response from the aviation station catalog.
 * @param {Response} response Station catalog response.
 * @returns {Promise<unknown>} Parsed station JSON.
 */
function parseAviationStationResponse(response) {
  if (!response.ok) throw new Error(`Could not load station location metadata (HTTP ${response.status}).`);
  return response.json();
}

/**
 * Ensures the aviation station catalog has the expected array shape.
 * @param {unknown} records Parsed station data.
 * @returns {object[]} Valid station records.
 */
function validateAviationStationRecords(records) {
  if (!Array.isArray(records)) throw new Error('The station location service returned an invalid catalog.');
  return records;
}

/**
 * Clears a rejected catalog request so that a later map opening can retry.
 * @param {Error} error Catalog loading error.
 * @returns {never} Rethrows the loading error.
 */
function resetAviationStationCatalog(error) {
  aviationStationCatalog = null;
  throw error;
}

/**
 * Matches IEM BUFKIT ids to aviation station records and keeps map-ready entries.
 * @param {string[]} codes BUFKIT ids taken from the IEM file names.
 * @param {object[]} records Aviation station catalog.
 * @returns {Array<{code:string, city:string, state:string, country:string, lat:number, lon:number}>} Mapped BUFKIT sites.
 */
function matchStationMetadata(codes, records) {
  const index = new Map();
  /**
   * Adds a normalized identifier unless another station already owns it.
   * @param {string} id Station identifier.
   * @param {object} record Station metadata.
   * @returns {void}
   */
  function addId(id, record) {
    const key = String(id || '').trim().toUpperCase();
    if (key && !index.has(key)) index.set(key, record);
  }
  for (const record of records) {
    for (const key of ['icaoId', 'faaId', 'iataId', 'id', 'wmoId']) addId(record[key], record);
  }
  for (const record of records) {
    for (const key of ['icaoId', 'faaId', 'iataId', 'id', 'wmoId']) {
      const id = String(record[key] || '').trim().toUpperCase();
      if (/^K[A-Z0-9]{3}$/.test(id)) addId(id.slice(1), record);
      if (/^[A-Z0-9]{3}$/.test(id)) addId(`K${id}`, record);
    }
  }

  const mapped = [];
  for (const code of codes) {
    const record = index.get(String(code).toUpperCase());
    const lat = Number(record?.lat);
    const lon = Number(record?.lon);
    if (!record || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    mapped.push({
      code,
      city: String(record.site || code).trim(),
      state: stationStateName(record.state, record.country),
      country: countryName(record.country),
      lat,
      lon,
    });
  }
  return mapped.sort(compareStationCodes);
}

/**
 * Expands US state and territory abbreviations while retaining other region labels.
 * @param {string} state State or province code from the station catalog.
 * @param {string} country Country code from the station catalog.
 * @returns {string} Human-readable state or province name.
 */
function stationStateName(state, country) {
  const code = String(state || '').trim().toUpperCase();
  if (!code) return 'Unknown';
  return String(country || '').toUpperCase() === 'US' ? US_STATE_NAMES[code] || code : code;
}

/**
 * Expands a country code using the browser's localized region-name data.
 * @param {string} country Country code from the station catalog.
 * @returns {string} Human-readable country name, or the source code if unknown.
 */
function countryName(country) {
  const code = String(country || '').trim().toUpperCase();
  if (!code) return 'Unknown';
  const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  return displayNames.of(code) || code;
}

/**
 * Sorts mapped stations by their BUFKIT station code.
 * @param {{code:string}} a First station.
 * @param {{code:string}} b Second station.
 * @returns {number} Locale-aware ordering result.
 */
function compareStationCodes(a, b) {
  return a.code.localeCompare(b.code);
}

/**
 * Formats an integer as a zero-padded UTC date or hour component.
 * @param {number} value Integer to format.
 * @returns {string} Two-character string.
 */
function pad(value) {
  return String(value).padStart(2, '0');
}
