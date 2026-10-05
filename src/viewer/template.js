/**
 * Chart markup. The engine finds every element by its data-sjs attribute (scoped to the chart
 * root) and toggles a few class names for the VWP and side-panel layouts:
 *   hodographInset ↔ hodographInsetVWP, hodographValues ↔ hodographValuesVWP,
 *   Values5 ↔ Values5VWP, skewthidden.
 */

const HELP_HTML = `
  <div class="sjs-help" role="dialog" aria-modal="true" aria-label="SharpJS controls">
    <div class="sjs-help-header">
      <h3>Keyboard, Mouse Controls &amp; Credits</h3>
      <button type="button" class="sjs-help-close" data-sjs-action="help-close" aria-label="Close">&times;</button>
    </div>
    <div class="sjs-help-content">
      <section>
        <h4>Skew-T Controls</h4>
        <ul>
          <li><strong>Alt + mouse down + drag:</strong> Move Skew-T view</li>
          <li><strong>Scroll wheel:</strong> Zoom in/out</li>
          <li class="sjs-help-note"><em>The following controls require "Modify Sounding" to be turned ON:</em></li>
          <li><strong>Mouse down/drag:</strong> Select points to move</li>
          <li><strong>Arrow left:</strong> Remove 1°C from every selected point</li>
          <li><strong>Arrow right:</strong> Add 1°C to every selected point</li>
          <li><strong>M:</strong> Exponentially move dew point to highest level's temperature</li>
          <li><strong>L:</strong> Linearly interpolate from highest to lowest points</li>
          <li><strong>N:</strong> Mix (temp - dry adiabatically, dew - saturated mixing ratio line) from highest point to sfc</li>
        </ul>
      </section>
      <section>
        <h4>Hodograph Controls</h4>
        <ul>
          <li><strong>Scroll wheel:</strong> Zoom in/out</li>
          <li class="sjs-help-note"><em>The following controls require "Modify Sounding" to be turned ON:</em></li>
          <li><strong>Mouse down/drag:</strong> Select points to move</li>
          <li><strong>Arrow keys:</strong> Move selected points 1 unit</li>
          <li><strong>i:</strong> Add 1 kt to selected points' wind speed</li>
          <li><strong>o:</strong> Remove 1 kt from selected points' wind speed</li>
        </ul>
      </section>
      <section>
        <h4>Credits &amp; Attribution</h4>
        <ul>
          <li>Thanks to Amelia Urquhart (<a href="https://github.com/a-urq" target="_blank" rel="noopener">github.com/a-urq</a>) for help with the ECAPE parcel calculations.</li>
          <li>Parts of the thermodynamics follow <a href="https://github.com/sharppy/SHARPpy" target="_blank" rel="noopener">SHARPpy</a> (BSD-3-Clause).</li>
        </ul>
      </section>
    </div>
  </div>`;

const CHART_HTML = `
  <p class="sjs-anim" data-sjs="AnimTxt">Loading…</p>
  <p class="sjs-error" data-sjs="Error">An Error Has Occurred!</p>

  <div class="skewTInset">
    <canvas data-sjs="skewTTitle"></canvas>
    <canvas data-sjs="skewT"></canvas>
    <canvas data-sjs="verticalBar"></canvas>
    <canvas data-sjs="skewTOverHang"></canvas>
    <canvas data-sjs="skewTOverHang2"></canvas>
    <canvas data-sjs="skewTOverHang3"></canvas>
    <canvas data-sjs="barbs"></canvas>
    <canvas data-sjs="skewTNumbers"></canvas>
  </div>

  <div class="mobile-chart-row">
    <div data-sjs="hodoinsetcheck" class="hodographInset">
      <canvas data-sjs="hodograph"></canvas>
      <canvas data-sjs="hodographOverHang"></canvas>
      <canvas data-sjs="hodographOverHang2"></canvas>
      <canvas data-sjs="hodographOverHang3"></canvas>
      <button type="button" class="sjs-button sjs-help-button" data-sjs-action="help-open">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        Help
      </button>
    </div>

    <div data-sjs="hodoselector" class="hodographValues">
      <canvas data-sjs="Values5" class="Values5"></canvas>
      <canvas data-sjs="Values7" class="skewthidden"></canvas>
      <canvas data-sjs="Values8" class="skewthidden"></canvas>
      <canvas data-sjs="Values4"></canvas>
      <canvas data-sjs="Values6" class="skewthidden"></canvas>
    </div>
  </div>

  <div class="skewTValues">
    <canvas data-sjs="Values1"></canvas>
    <canvas data-sjs="Values2"></canvas>
    <canvas data-sjs="Values3"></canvas>
    <canvas data-sjs="Values11"></canvas>
  </div>

  <div data-sjs="modifySkewTModal" class="modify-skewt-modal">
    <div class="modify-skewt-header">
      <h3>Modify Sounding Data</h3>
      <button type="button" data-sjs="closeModifySkewTModal" class="modify-skewt-close" aria-label="Close">&times;</button>
    </div>
    <div class="modify-skewt-content">
      <table class="modify-skewt-table">
        <thead>
          <tr>
            <th>Pressure (mb)</th>
            <th>Height (m)</th>
            <th>Temperature (°C)</th>
            <th>Dewpoint (°C)</th>
            <th>Wind Direction (°)</th>
            <th>Wind Speed (kts)</th>
          </tr>
        </thead>
        <tbody data-sjs="modifySkewTBody"></tbody>
      </table>
    </div>
  </div>
  <div data-sjs="editHelper" class="edit-helper">Press Enter to save changes or Esc to cancel</div>

  <div class="sjs-help-overlay" data-sjs="helpOverlay" hidden>${HELP_HTML}</div>
`;

/**
 * Build the chart inside `host`.
 * @param {HTMLElement} host
 * @returns {HTMLElement} the chart root (pass it to createEngine)
 */
export function renderChart(host) {
  const viz = document.createElement('div');
  viz.className = 'sjs-viz';
  viz.innerHTML = CHART_HTML;
  host.appendChild(viz);
  return viz;
}
