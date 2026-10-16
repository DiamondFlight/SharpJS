/**
 * Create the fixed, chart-width timeline and keep it clear of the controls panel.
 * @param {HTMLElement} element Timeline container.
 * @param {HTMLElement} stage Chart display area.
 * @param {HTMLElement} controls Controls panel.
 * @param {Document} doc Owning document.
 * @param {(index: number, item: object, reset: boolean) => void} onSelect Displays a timeline item.
 * @returns {{ setItems: (items: object[], selected?: number, reset?: boolean) => void, setLoading: (loading: boolean) => void, clear: () => void, destroy: () => void }}
 */
export function createTimeSlider(element, stage, controls, doc, onSelect) {
  const view = doc.defaultView;
  const playButton = doc.createElement('button');
  playButton.type = 'button';
  playButton.className = 'sjs-button sjs-time-play';
  playButton.setAttribute('aria-label', 'Play timeline');
  playButton.textContent = '▶';

  const range = doc.createElement('input');
  range.type = 'range';
  range.className = 'sjs-time-range';
  range.min = '0';
  range.max = '0';
  range.value = '0';
  range.setAttribute('aria-label', 'Sounding time');

  const label = doc.createElement('output');
  label.className = 'sjs-time-label';
  label.setAttribute('aria-live', 'polite');

  element.replaceChildren(playButton, range, label);
  element.hidden = true;

  let items = [];
  let selected = 0;
  let playback = null;
  let resizeObserver = null;
  let hasItems = false;
  let loading = false;

  function pause() {
    if (playback !== null) {
      view.clearInterval(playback);
      playback = null;
    }
    playButton.textContent = '▶';
    playButton.setAttribute('aria-label', 'Play timeline');
    playButton.setAttribute('aria-pressed', 'false');
  }

  function formatTime(milliseconds) {
    const time = new Date(milliseconds);
    const pad = (value) => String(value).padStart(2, '0');
    return `${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())} ${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}Z`;
  }

  function position() {
    if (!hasItems) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const height = Math.min(view.innerHeight * 0.05, 44);
    const controlsRect = controls.isConnected ? controls.getBoundingClientRect() : null;
    const controlsBelowStage = controlsRect
      && controlsRect.top >= rect.bottom - 1
      && controlsRect.top < view.innerHeight
      && controlsRect.bottom > 0;
    if (controlsBelowStage && controlsRect.top < height) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const top = controlsBelowStage ? Math.max(0, controlsRect.top - height) : view.innerHeight - height;
    element.style.left = `${rect.left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${height}px`;
  }

  function select(index, reset = false) {
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, index));
    if (items[next].disabled) {
      range.value = String(selected);
      return;
    }
    selected = next;
    range.value = String(selected);
    label.value = formatTime(items[selected].time);
    label.textContent = label.value;
    onSelect(selected, items[selected], reset);
  }

  function setItems(nextItems, initialIndex = nextItems.length - 1, reset = true) {
    pause();
    const previousTime = items[selected]?.time;
    items = nextItems.filter((item) => Number.isFinite(item.time) || item.disabled);
    const available = items.filter((item) => !item.disabled).length;
    hasItems = available > 0;
    element.hidden = available === 0;
    playButton.hidden = items.length > 0 && items.every((item) => item.kind === 'vwp');
    range.max = String(Math.max(0, items.length - 1));
    range.disabled = available < 2;
    playButton.disabled = loading || available < 2 || playButton.hidden;
    if (available === 0) {
      label.value = '';
      label.textContent = '';
      position();
      return;
    }
    const retainedIndex = !reset && Number.isFinite(previousTime)
      ? items.findIndex((item) => !item.disabled && item.time === previousTime)
      : -1;
    const target = retainedIndex >= 0
      ? retainedIndex
      : items[initialIndex] && !items[initialIndex].disabled
      ? initialIndex
      : items.findIndex((item) => !item.disabled);
    select(target, reset);
    position();
  }

  function setLoading(value) {
    loading = value === true;
    if (loading) pause();
    playButton.disabled = loading || items.filter((item) => !item.disabled).length < 2 || playButton.hidden;
  }

  function advance() {
    let next = selected + 1;
    while (next < items.length && items[next].disabled) next++;
    if (next >= items.length) {
      pause();
      return;
    }
    select(next);
    if (selected >= items.length - 1) pause();
  }

  range.addEventListener('input', () => {
    pause();
    select(Number(range.value));
  });
  playButton.addEventListener('click', () => {
    if (playback !== null || items.length < 2 || loading || playButton.hidden) {
      pause();
      return;
    }
    const lastAvailable = items.findLastIndex((item) => !item.disabled);
    if (selected >= lastAvailable) select(items.findIndex((item) => !item.disabled));
    playButton.textContent = 'Ⅱ';
    playButton.setAttribute('aria-label', 'Pause timeline');
    playButton.setAttribute('aria-pressed', 'true');
    playback = view.setInterval(advance, 1000);
  });

  view.addEventListener('resize', position);
  view.addEventListener('scroll', position, { passive: true });
  if (view.ResizeObserver) {
    resizeObserver = new view.ResizeObserver(position);
    resizeObserver.observe(stage);
    if (controls.isConnected) resizeObserver.observe(controls);
  }

  return {
    setItems,
    setLoading,
    clear() {
      pause();
      items = [];
      hasItems = false;
      loading = false;
      element.hidden = true;
      range.max = '0';
      range.value = '0';
      range.disabled = true;
      playButton.disabled = true;
      playButton.hidden = false;
      label.value = '';
      label.textContent = '';
    },
    destroy() {
      pause();
      resizeObserver?.disconnect();
      view.removeEventListener('resize', position);
      view.removeEventListener('scroll', position);
      element.replaceChildren();
    },
  };
}

/**
 * Expand available BUFKIT forecasts into hourly positions, marking gaps unavailable.
 * @param {object[]} soundings Parsed BUFKIT forecast soundings.
 * @returns {object[]} Hourly slider positions in valid-time order.
 */
export function expandBufkitTimeSeries(soundings) {
  const available = new Map(soundings.map((sounding) => [sounding.meta.forecastHour, sounding]));
  const hours = [...available.keys()].sort((a, b) => a - b);
  if (!hours.length || !hours.every(Number.isInteger)) {
    return soundings.map((sounding) => ({
      kind: 'bufkit',
      time: Date.parse(sounding.meta.valid),
      sounding,
    }));
  }
  const firstHour = hours[0];
  const firstTime = Date.parse(available.get(firstHour).meta.valid);
  const runTime = firstTime - firstHour * 60 * 60 * 1000;
  return Array.from({ length: hours.at(-1) - firstHour + 1 }, (_, index) => {
    const forecastHour = firstHour + index;
    const sounding = available.get(forecastHour);
    return {
      kind: 'bufkit',
      time: runTime + forecastHour * 60 * 60 * 1000,
      sounding,
      disabled: !sounding,
    };
  });
}
