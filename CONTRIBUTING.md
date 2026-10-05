# Contributing to SharpJS

Thanks for helping! This page explains how the code fits together, how to add things without breaking
saved settings or embedders, and what is planned.

## Setup

```sh
npm install
npx playwright install chromium   # once, for the browser tests
npm run dev                       # standalone site at http://localhost:5173 (hot reload)
npm test && npm run test:e2e && npm run lint
```

## How the pieces fit

```
app/main.js ──► SharpJS(el, props)                  src/viewer/index.js
                 ├─ renderChart()                    src/viewer/template.js   chart markup (data-sjs="…")
                 ├─ injectStyles()                   src/viewer/styles.js     all CSS, scoped to .sharpjs
                 ├─ createSettingsStore()            src/settings/            schema · store · storage adapters
                 ├─ createEngine(root, options)      src/viewer/engine.js     drawing + interaction
                 │    └─ calc/*                      src/calc/                thermodynamics, parcels, kinematics, ECAPE
                 └─ createControls()                 src/viewer/controls.js   the built-in panel (optional)

parseSounding / fromArrays / exportSounding          src/io/                  pure, no DOM
analyze / levelAt                                    src/analysis.js          pure, no DOM
fetchIemRaob / fetchIemBufkit / fetchNexradVwp       src/sources/             only module that touches the network
```

Rules of thumb:

- **`calc/`, `io/`, `analysis.js` and `settings/` never touch the DOM.** They run in Node, which is how
  `sharpjs/core` and the unit tests work. (`DrawInsetParams` in `calc/skewtCalcs.js` is the one exception left;
  it takes its canvas as an argument and has a no-draw mode used by `analyze()`.)
- **The engine never reads form controls.** Every option arrives as a function argument or through
  `applyState()`, and is reported back through `getState()`. That is what lets the built-in panel, a host's own UI
  and saved settings all drive the same chart.
- **Only `sources/` fetches.** Apps with their own data pipeline pass soundings in and never load it.

### The engine (`src/viewer/engine.js`)

This is the original single-file SharpJS chart code, wrapped in `createEngine(root, options)`, so every chart on
a page has its own state. The body keeps the original layout and indentation. Changes from the original are:

- `document.getElementById('x')` → `$('x')`, which looks up `[data-sjs="x"]` inside the chart root.
- Window keyboard / mouse-up listeners are attached by `attach()` and removed by `detach()`.
- Functions that used to read inputs now take arguments (`LoadNewParcel('CU', 850)`,
  `LoadNewWind('CM', true, { direction, speed })`, `LoadNewSfc('New', 'tmp', { temperature, dewpoint, unit })`,
  `LoadNewLapseLyr('N', { bottom, top, mode })`, …). Toggles accept an explicit value or cycle when called with none.
- `getState()` reports every user-facing option; `applyState(partial)` sets several and redraws once.
- Every public method is wrapped so that (1) the calc module's shared storm motion / presets are set for *this*
  chart first and (2) `emit('change')` fires afterwards. The `SharpJS()` wrapper diffs `getState()` after each
  change and saves the settings that moved.
- Presets have overrides: `setPreset(type, value)` pins one; `'auto'` follows `autoSetPresetsFromSounding()`.

### Adding a setting

1. Add the key, its validator and its default to `src/settings/schema.js` (`SETTINGS_SCHEMA`, `DEFAULT_SETTINGS`).
   Saved settings from older versions simply pick up the default; no migration is needed for new keys.
2. If the chart engine uses it: read it in `applyState()`, report it in `getState()`, and add it to
   `ENGINE_SETTINGS` in `src/viewer/index.js`. Otherwise read and write it from the controls through the store.
3. Add a control in `src/viewer/controls.js` and render its current value in `render()`.
4. Add it to the `Settings` type in `src/index.d.ts`.

Renaming or changing the meaning of a key: bump `SETTINGS_VERSION` and add a step to `MIGRATIONS` in
`schema.js`, so people keep their choice.

### Releasing

Bump `version` in `package.json` **and** `src/version.js` (a unit test checks they match). The chart credit shows
the major.minor part ("SharpJS v1.61"). Add a CHANGELOG entry.

## How the port was verified

The open-source engine was checked against the previous SharpJS 1.61 chart by drawing both in the same
headless Chromium and comparing every chart canvas pixel by pixel. The check covered:

- the five samples, the BUFKIT, IEM RAOB and VWP pipelines;
- parcel, storm-motion, preset, side-panel, unit, skew, custom-layer, surface-edit and reset actions.

Once the fixes listed in the CHANGELOG were applied to both builds, all 33 steps were identical. If you change
drawing code, take before/after screenshots (`npm run dev`, then `chart.screenshot()` in the console) to catch
unintended changes.

## Roadmap

Ideas for continuing the cleanup, roughly in order of payoff:

1. **Split `engine.js` by panel**: `skewt.js` (axes, adiabats, profiles, parcel), `hodograph.js`, `tables.js`
   (`DrawBoxes`, `DrawValues`, `DrawWindParams`, insets), `side-panels.js` (height graph, tornado climatology,
   winter), `vertical-bars.js`, `interaction.js` (cursor, modify, front), passing one chart context object instead
   of closure variables.
2. **Have `DrawSkewT` call `computeThermo()`** (as `LoadWithWind` already calls `computeWindParams()`), so all
   parcel and wind numbers come from `calc/params.js`.
3. Move `DrawInsetParams`' drawing half out of `calc/skewtCalcs.js`, leaving calc DOM-free.
4. Document the sounding object (`Sounding`, `Info`, parcel results) with JSDoc types and give fields readable names.
5. Async NEXRAD VWP decoding (`DecompressionStream`) so compressed products work in browsers without pako.
6. A built-in map inset for the standalone site (e.g. a small coastline/state outline drawn on canvas).

## Known issues (not changed during the port)

These behave the same as SharpJS 1.61. They are listed here so they can be fixed deliberately.

- **ECAPE is hidden for many very unstable soundings.** `LiftParcel` shows ECAPE as "--" when `MPL <= EL`, and
  `MPL` is accumulated as an integral that can come out negative (e.g. −9407 m for KOUN 00Z 4 May 1999).
- `compute_NCAPE` (`calc/ecapeCalc.js`) declares `var T1 = []`, shadowing its `T1` (warmest mixed-phase
  temperature) argument. This is harmless today because `r_sat` is called with `ice_flag = 0`.
- The IEM RAOB moisture extrapolation uses the index of the last moist level in the *unfiltered* profile, then
  applies it to the processed profile.
- Omega scale differs by source:
  - arrays / model data store −ω(Pa/s)/50;
  - the SharpJS text format divides its OMEGA column by 10 on import;
  - BUFKIT keeps OMEG/30 in an extra column.

  So exporting and re-importing a model sounding changes the omega bars.
- `Location` is `[lat, lon]` for most sources but `[lat, west-positive lon]` for BUFKIT. `Location2` is always
  west-positive. New code should use `Coords: { lat, lon }`.
- The modify table re-adds its close-button listener every time it refreshes.
- Turning on Modify Sounding turns Read-out off, and that is remembered as a setting.
- Adding or clearing comparisons redraws the stored original of the main sounding, which drops in-progress edits.
- Titles from SHARPpy text keep the leading spaces of the title line.
