# Changelog

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
