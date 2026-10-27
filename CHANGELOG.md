# Changelog

## 1.7.1 — 2026-10-27

### Added
- A `GetSWV` calculation API for streamwise and crosswise vorticity and streamwiseness.
- Optional EHI in wind boxes and HGZ/DGZ CAPE annotations on the Skew-T.
- Section-navigation buttons in the controls panel to make settings and analysis choices easier to find.
- Streamwise-vorticity diagnostics in wind parameter boxes and the vertical-profile display.

### Changed
- Wind-layer SRH, shear, and mean-wind calculations now use the requested upper pressure bound instead of stopping 1 hPa below it.
- Lapse-rate calculations can return two decimal places and skip unneeded wind interpolation.
- Parcel calculations reuse environmental and virtual-temperature data while constructing the parcel profile and scanning for the LFC; Bunkers-motion calculations reuse an available effective-inflow layer.
- Persist the EHI and CAPE display options with the other chart settings.

### Fixed
- Prevent negative layer contributions from reducing integrated parcel CAPE.
- Controls now switch between sections using navigation buttons rather than nested dropdowns.

## 1.7.0 — 2026-10-15

First Public Release

### Added
- A BUFKIT station picker in the controls with a searchable, zoomable map. Station locations
  come from the bundled station catalog, while available station IDs are read from the IEM archive.
- A location inset on the hodograph showing OpenStreetMap tiles around the sounding, with a marker
  for the sounding location and map attribution.
- A UTC time slider for BUFKIT forecast hours and archived NEXRAD VWP volumes. BUFKIT slider
  selections update the forecast hour from the same file; VWP archives can be loaded for a chosen
  date and hour, covering the preceding three hours.
- Function documentation throughout the viewer engine and reusable canvas path/line helpers.

### Changed
- BUFKIT archive downloads now load and cache all forecast hours together, reducing repeat requests
  when selecting different hours from the same run. VWP location maps are shown in the panel above
  the wind-barb display, and VWP timeline playback is disabled.
- Bunkers right/left storm motions now use the parcel-based method described by Bunkers et al. (2014),
  with the SHARPpy non-parcel calculation retained as a fallback; related kinematic reference values
  and tests were updated.
- Updated parcel, layer-interpolation, thermodynamic, SRH, and severe-weather calculation logic as part
  of the analysis alignment and verification work.
- Updated package and chart versioning to `v1.7.0` and refreshed repository links and release guidance.

### Fixed
- Corrected ECAPE supporting calculations, including storm-relative wind components and NCAPE
  integration over the sounding's height grid.
- Corrected parcel and thermodynamic edge cases in LCL, virtual-temperature, layer, and buoyancy
  calculations.

## 1.61.0 — 2026-10-02

First open-source release of SharpJS.

### Added
- `SharpJS(element, props)`: one call draws an interactive sounding with its controls. Calling it again with
  new props updates the same chart. Several charts can share a page.
- Headless `sharpjs/core`: `parseSounding`, `fromArrays`, `analyze`, `levelAt`, `exportSounding` — runs in Node.
- Remembered settings with a versioned schema (localStorage, cookie, memory or a custom adapter). Presets can
  be pinned or left on automatic.
- Standalone site (`app/`) with sample soundings, drag-and-drop, and archive loaders for IEM RAOBs, IEM BUFKIT
  files and Unidata NEXRAD VWPs (`sharpjs/sources`). It remembers the last sounding.
- Reading BUFKIT files directly (column order from `SNPARM`, any forecast hour) and NEXRAD VWP files.
- TypeScript declarations, unit tests and browser tests.

### Changed
- No hosted services, data or branding. Hosts set their own credit with `brandLabel`, `savedBy` and
  `filePrefix`.
- The map inset in the hodograph is now supplied by the host through `mapImage` (there was a Mapbox call).
- ACARS loading and the model/location pickers were removed; hosts pass their data in.
- Help text: arrow left/right on the Skew-T subtract/add 1 °C (the text had them swapped).

### Fixed
- The Skew-T skew reset to Default on every full redraw.
- ECAPE and the custom 0–2 km SRH used the *previous* storm motion when a sounding was first drawn (often
  showing "--").
- A custom storm motion was replaced by 0°/10 kt whenever the chart fully redrew.
- Surface edits ignored zero values: 32 °F / 0 °C kept the old temperature, 0 kt became 10 kt, a north wind
  became 180°.
- A height-based custom lapse-rate layer was recomputed as if its heights were pressures after a redraw.
- CM1 export wrote heights above sea level instead of above ground.
- `GetSRH(..., "Hght")` threw a ReferenceError; `ecape_parcel` used Python's `True` as a default value.
- Loading a sounding while comparisons were shown passed them as "ghost" soundings.
- Reading a CM1 file overwrote the chart's parameter state.
