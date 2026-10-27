// Browser tests: `npm run test:e2e` (needs `npx playwright install chromium` once).
// Starts Vite in-process, drives Chromium with Playwright, and mocks the public data
// endpoints with files from test/fixtures so results never depend on the network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name) => fs.readFileSync(path.join(repo, 'test/fixtures', name));
const sampleText = (name) => fs.readFileSync(path.join(repo, 'app/public/samples', name), 'utf8');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push([false, name, err]);
    console.log(`✖ ${name}\n    ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n    ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function mockNetwork(context) {
  await context.route('https://mesonet.agron.iastate.edu/json/raob.py**', (r) => r.fulfill({ body: fixture('iem-koax-2014061619.json'), contentType: 'application/json' }));
  await context.route('https://mesonet.agron.iastate.edu/geojson/**', (r) => r.fulfill({ body: fixture('raob-stations.geojson'), contentType: 'application/json' }));
  await context.route('https://mtarchive.geol.iastate.edu/**', (r) => r.fulfill({ body: fixture('rap_kdsm_2024052612.buf') }));
  await context.route('https://unidata-nexrad-level3.s3.amazonaws.com/**', (r) => {
    if (r.request().url().includes('list-type=2')) {
      return r.fulfill({ body: '<ListBucketResult><Contents><Key>OAX_NVW_2024_05_26_12_01_43</Key></Contents></ListBucketResult>', contentType: 'application/xml' });
    }
    return r.fulfill({ body: fixture('OAX_NVW_2024_05_26_12_01_43') });
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ body: '', contentType: 'text/css' }));
}

const harnessServer = await createServer({ root: repo, configFile: false, logLevel: 'error', server: { port: 0 } });
await harnessServer.listen();
const appServer = await createServer({ configFile: path.join(repo, 'vite.config.js'), logLevel: 'error', server: { port: 0 } });
await appServer.listen();
const harnessUrl = `${harnessServer.resolvedUrls.local[0]}test/e2e/harness.html`;
const appUrl = appServer.resolvedUrls.local[0];

const browser = await chromium.launch();
const pageErrors = [];

async function newPage(url, viewport = { width: 1600, height: 1000 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await mockNetwork(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${url}: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

/** Fraction of non-black pixels on a chart canvas. */
const inked = (page, root, id) => page.evaluate(({ root, id }) => {
  const c = document.querySelector(`${root} [data-sjs="${id}"]`);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  return n / (d.length / 4);
}, { root, id });

try {
  const page = await newPage(harnessUrl);
  await page.waitForFunction(() => window.harnessReady);
  const OUN = sampleText('koun-1999-05-04-00z.txt');
  const BUF = sampleText('kbuf-2014-11-18-12z.txt');

  await check('SharpJS(el, props) draws a sounding', async () => {
    await page.evaluate((t) => { window.h = window.SJS.SharpJS('#chart', { sounding: t, persist: false }); }, OUN);
    const st = await page.evaluate(() => window.h.getState());
    assert(st.hasSounding && /KOUN 19990504\/0000/.test(st.title), `state ${JSON.stringify(st.title)}`);
    for (const id of ['skewT', 'hodograph', 'Values1', 'Values3', 'Values5']) {
      const f = await inked(page, '#chart', id);
      assert(f > 0.01, `${id} looks empty (${f})`);
    }
    assert(await page.locator('#chart .sjs-controls').count() === 1, 'controls panel missing');
  });

  await check('calling SharpJS again updates the same chart', async () => {
    const same = await page.evaluate((t) => window.SJS.SharpJS('#chart', { sounding: t }) === window.h, BUF);
    assert(same, 'returned a different handle');
    const st = await page.evaluate(() => window.h.getState());
    assert(/KBUF/.test(st.title), st.title);
    assert(st.autoPresets.SidePanel === 'Winter', `auto presets ${JSON.stringify(st.autoPresets)}`);
    assert(await page.locator('#chart .sharpjs').count() === 1, 'mounted twice');
  });

  await check('soundingKey keeps parcel / motion choices between frames', async () => {
    await page.evaluate((t) => window.h.update({ sounding: t, soundingKey: 'k1' }), OUN);
    await page.evaluate(() => { window.h.engine.LoadNewParcel('ML'); window.h.engine.LoadNewWind('LM'); });
    await page.evaluate((t) => window.h.update({ sounding: t, soundingKey: 'k1' }), OUN);
    let st = await page.evaluate(() => window.h.getState());
    assert(st.parcel === 'ML' && st.motion === 'LM', `kept ${st.parcel}/${st.motion}`);
    await page.evaluate((t) => window.h.update({ sounding: t, soundingKey: 'k2' }), OUN);
    st = await page.evaluate(() => window.h.getState());
    assert(st.parcel === 'MU' && st.motion === 'RM', `reset ${st.parcel}/${st.motion}`);
  });

  await check('controls drive the chart', async () => {
    const sectionNav = page.locator('#chart .sjs-section-nav');
    assert(await sectionNav.locator('button').count() === 10, 'expected ten section buttons');
    assert(await sectionNav.evaluate((nav) => getComputedStyle(nav).gridTemplateColumns.split(' ').length) === 5, 'section buttons are not in five columns');
    await sectionNav.getByRole('button', { name: 'Parcel' }).click();
    assert(await page.locator('#chart .sjs-section[data-section="parcel"]').isVisible(), 'parcel section did not open');
    assert(await page.locator('#chart .sjs-section[data-section="display"]').isHidden(), 'display section remained open');
    await page.locator('#chart').getByRole('button', { name: 'Surface-Based' }).click();
    await sectionNav.getByRole('button', { name: 'Display' }).click();
    await page.locator('#chart .sjs-section[data-section="display"] button', { hasText: 'Hodograph colors' }).click();
    await sectionNav.getByRole('button', { name: 'Presets' }).click();
    await page.locator('#chart .sjs-section[data-section="presets"] select').first().selectOption('Fire');
    const st = await page.evaluate(() => window.h.getState());
    assert(st.parcel === 'SB', `parcel ${st.parcel}`);
    assert(st.hodographColorTable === 1, `color table ${st.hodographColorTable}`);
    assert(st.presets.WindLapse === 'Fire' && st.presetOverrides.WindLapse === 'Fire', JSON.stringify(st.presets));
    assert(await page.locator('#chart .sjs-section[data-section="parcel"] button').first().getAttribute('aria-pressed') === 'true', 'button not pressed');
  });

  await check('analysis() matches the chart', async () => {
    const a = await page.evaluate(() => window.h.analysis({ parcel: 'MU', motion: 'RM' }));
    assert(a.parcels.SB.cape === 2848 && a.kinematics.layers['0-1km'].srh === 270, JSON.stringify(a.parcels.SB));
  });

  await check('screenshot is a 2000×1200 PNG', async () => {
    const size = await page.evaluate(async () => {
      const url = await window.h.screenshot();
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = url; });
      return [url.slice(0, 22), img.width, img.height];
    });
    assert(size[0] === 'data:image/png;base64,' && size[1] === 2000 && size[2] === 1200, JSON.stringify(size));
  });

  await check('export text round-trips through load()', async () => {
    const n = await page.evaluate(() => {
      const before = window.h.getSounding().Sounding.Slice.length;
      const { text } = window.h.exportText('SharpJS');
      window.h.load(text);
      return [before, window.h.getSounding().Sounding.Slice.length];
    });
    assert(n[0] === n[1], JSON.stringify(n));
  });

  await check('VWP from raw NVW bytes, then back', async () => {
    const st = await page.evaluate(async (b64) => {
      const previous = window.h.getSounding()?.Location;
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const prototype = CanvasRenderingContext2D.prototype;
      const originalFillRect = prototype.fillRect;
      let mapInVwpPanel = false;
      prototype.fillRect = function (x, y, width, height) {
        if (this.canvas.dataset.sjs === 'Values8' && x === 600 && y === 0 && width === 300 && height === 350) {
          mapInVwpPanel = true;
        }
        return originalFillRect.call(this, x, y, width, height);
      };
      await window.h.setVwp(buf);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      prototype.fillRect = originalFillRect;
      const on = window.h.getState();
      const location = window.h.getSounding()?.Location;
      window.h.setVwp(null);
      return [on.vwpActive, on.title, window.h.getState().vwpActive, previous, location, mapInVwpPanel];
    }, fixture('OAX_NVW_2024_05_26_12_01_43').toString('base64'));
    assert(st[0] === true && /^VWP OAX/.test(st[1]) && st[2] === false, JSON.stringify(st));
    assert(st[4] && st[4][0] !== st[3]?.[0], `VWP location was not applied: ${JSON.stringify(st.slice(3))}`);
    assert(st[5], `VWP location inset was not drawn in the panel above the wind barbs: ${JSON.stringify(st.slice(5))}`);
  });

  await check('file drop loads a sounding', async () => {
    await page.evaluate(async (text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'kbuf.txt', { type: 'text/plain' }));
      const viz = document.querySelector('#chart .sjs-viz');
      for (const type of ['dragenter', 'dragover', 'drop']) viz.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 200));
    }, BUF);
    assert(/KBUF/.test(await page.evaluate(() => window.h.getState().title)), 'drop did not load');
  });

  await check('settings persist in localStorage', async () => {
    await page.evaluate(() => { localStorage.clear(); window.h.destroy(); });
    await page.evaluate((t) => { window.h = window.SJS.SharpJS('#chart', { sounding: t, persist: 'local' }); }, OUN);
    await page.evaluate(() => window.h.engine.applyState({ units: 'metric', hodographNumbers: true, presetOverrides: { SidePanel: 'Winter' } }));
    await page.waitForTimeout(50);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sharpjs:settings')));
    assert(stored && stored.settings.units === 'metric' && stored.settings.hodographNumbers === true, JSON.stringify(stored));
    await page.evaluate((t) => { window.h.destroy(); window.h = window.SJS.SharpJS('#chart', { sounding: t, persist: 'local' }); }, OUN);
    const st = await page.evaluate(() => window.h.getState());
    assert(st.units === 'metric' && st.hodographNumbers === true && st.presets.SidePanel === 'Winter', JSON.stringify(st));
  });

  await check('settings persist in a cookie', async () => {
    await page.evaluate((t) => { window.h.destroy(); window.h = window.SJS.SharpJS('#chart', { sounding: t, persist: 'cookie' }); }, OUN);
    await page.evaluate(() => window.h.engine.applyState({ units: 'imperial', skewTSkew: 0.5 }));
    await page.waitForTimeout(50);
    const cookie = await page.evaluate(() => document.cookie);
    assert(/sharpjs_settings=/.test(cookie), cookie);
    await page.evaluate((t) => { window.h.destroy(); window.h = window.SJS.SharpJS('#chart', { sounding: t, persist: 'cookie' }); }, OUN);
    const st = await page.evaluate(() => window.h.getState());
    assert(st.units === 'imperial' && st.skewTSkew === 0.5, JSON.stringify(st));
    await page.evaluate(() => window.h.resetSettings());
    assert(!/sharpjs_settings=/.test(await page.evaluate(() => document.cookie)), 'cookie not cleared by reset');
  });

  await check('two charts on one page stay independent', async () => {
    await page.evaluate(({ a, b }) => {
      window.h.destroy();
      document.body.insertAdjacentHTML('beforeend', '<div id="one" style="width:1200px"></div><div id="two" style="width:1200px"></div>');
      window.one = window.SJS.SharpJS('#one', { sounding: a, persist: false, controls: false });
      window.two = window.SJS.SharpJS('#two', { sounding: b, persist: false, controls: false });
      window.one.engine.LoadNewParcel('ML');
      window.one.engine.applyState({ units: 'metric' });
    }, { a: OUN, b: BUF });
    const st = await page.evaluate(() => [window.one.getState(), window.two.getState()]);
    assert(st[0].parcel === 'ML' && st[1].parcel === 'MU', 'parcel leaked between charts');
    assert(st[0].units === 'metric' && st[1].units === 'default', 'units leaked between charts');
    assert(/KOUN/.test(st[0].title) && /KBUF/.test(st[1].title), 'titles mixed up');
    const srh = await page.evaluate(() => [window.one.analysis().kinematics.layers['0-1km'].srh, window.two.analysis().kinematics.layers['0-1km'].srh]);
    assert(srh[0] === 270, `chart one SRH ${srh[0]}`);
    await page.evaluate(() => window.one.destroy());
    assert(await page.locator('#one .sharpjs').count() === 0, 'destroy left markup behind');
    await page.evaluate(() => window.two.engine.LoadNewWind('LM'));
    assert((await page.evaluate(() => window.two.getState().motion)) === 'LM', 'second chart stopped responding');
  });
  await page.context().close();

  await check('standalone app: sample, archive loaders, persisted settings', async () => {
    const app = await newPage(appUrl);
    await app.waitForFunction(() => window.sharpjs?.getState().hasSounding);
    let st = await app.evaluate(() => window.sharpjs.getState());
    assert(/KOUN 19990504\/0000/.test(st.title) && st.tornadoClimoAvailable, JSON.stringify([st.title, st.tornadoClimoAvailable]));
    await app.locator('#chart .sjs-section-nav').getByRole('button', { name: 'Archive' }).click();
    await app.getByRole('button', { name: 'Load RAOB' }).click();
    await app.waitForFunction(() => /KOAX 20140616\/1900/.test(window.sharpjs.getState().title));
    const bufkitRequests = [];
    app.on('request', (request) => {
      if (request.url().includes('mtarchive.geol.iastate.edu') && request.url().endsWith('.buf')) bufkitRequests.push(request);
    });
    const bufkitSelection = {
      date: await app.getByLabel('Run date').inputValue(),
      run: await app.getByLabel('Run (Z)').inputValue(),
    };
    await app.getByRole('button', { name: 'Load BUFKIT' }).click();
    await app.waitForFunction(() => /^\s*RAP 05-26-2024 12Z - F000/.test(window.sharpjs.getState().title));
    const firstBufkitDownloads = bufkitRequests.length;
    await app.getByLabel('Run date').fill(bufkitSelection.date);
    await app.getByLabel('Run (Z)').fill(bufkitSelection.run);
    await app.getByRole('button', { name: 'Load BUFKIT' }).click();
    await app.waitForTimeout(50);
    const secondBufkitDownloads = bufkitRequests.length;
    assert(firstBufkitDownloads === 1 && secondBufkitDownloads === firstBufkitDownloads, `BUFKIT file was fetched repeatedly (${firstBufkitDownloads} → ${secondBufkitDownloads})`);
    const bufkitRange = app.locator('#chart .sjs-timeslider input[type="range"]');
    assert(await app.locator('#chart .sjs-timeslider').isVisible(), 'BUFKit time slider is hidden');
    const bufkitMax = Number(await bufkitRange.getAttribute('max'));
    assert(bufkitMax > 0, `expected multiple BUFKit times, max=${bufkitMax}`);
    await bufkitRange.evaluate((range) => {
      range.value = range.max;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await app.waitForFunction(() => Number(window.sharpjs.getSounding().meta.forecastHour) > 0);
    const selectedFhour = await app.evaluate(() => window.sharpjs.getSounding().meta.forecastHour);
    assert(await app.getByLabel('F hour').inputValue() === String(selectedFhour), 'BUFKit forecast-hour control did not follow the slider');
    const sliderGeometry = await app.locator('#chart .sjs-timeslider').evaluate((slider) => {
      const bounds = slider.getBoundingClientRect();
      const stage = document.querySelector('#chart .sjs-stage').getBoundingClientRect();
      return { height: bounds.height, left: bounds.left, right: bounds.right, stageLeft: stage.left, stageRight: stage.right };
    });
    assert(sliderGeometry.height <= 50, `slider exceeds 5% of 1000px viewport: ${sliderGeometry.height}px`);
    assert(sliderGeometry.left >= sliderGeometry.stageLeft - 1 && sliderGeometry.right <= sliderGeometry.stageRight + 1, 'slider extends beyond chart display width');
    await app.getByRole('button', { name: 'Latest VWP' }).click();
    await app.waitForFunction(() => window.sharpjs.getState().vwpActive);
    await app.getByRole('button', { name: 'Back to sounding' }).click();
    await app.getByLabel('Archive date (UTC)').fill('2024-05-26');
    await app.getByLabel('Archive hour (UTC)').fill('13');
    await app.getByRole('button', { name: 'Load 3-hour VWP archive' }).click();
    await app.waitForFunction(() => window.sharpjs.getState().vwpActive && document.querySelector('#chart .sjs-timeslider output')?.textContent.includes('2024-05-26'));
    assert(await app.locator('#chart .sjs-timeslider').isVisible(), 'VWP archive time slider is hidden');
    assert(await app.locator('#chart .sjs-time-play').isHidden(), 'VWP playback should be disabled by default');
    await app.locator('#chart .sjs-section-nav').getByRole('button', { name: 'Display' }).click();
    await app.locator('.sjs-section[data-section="display"] select').nth(1).selectOption('metric');
    await app.reload({ waitUntil: 'networkidle' });
    await app.waitForFunction(() => window.sharpjs?.getState().hasSounding);
    st = await app.evaluate(() => window.sharpjs.getState());
    assert(st.units === 'metric', `units after reload ${st.units}`);
    assert(/RAP 05-26-2024/.test(st.title), `last sounding not restored: ${st.title}`);
    await app.context().close();
  });

  await check('phone layout has no horizontal scroll', async () => {
    const app = await newPage(appUrl, { width: 390, height: 844 });
    await app.waitForFunction(() => window.sharpjs?.getState().hasSounding);
    await app.locator('#chart .sjs-section-nav').getByRole('button', { name: 'Archive' }).click();
    await app.getByRole('button', { name: 'Load BUFKIT' }).click();
    await app.waitForFunction(() => document.querySelector('#chart .sjs-timeslider[hidden]'));
    await app.evaluate(() => window.scrollTo(0, 0));
    await app.waitForFunction(() => document.querySelector('#chart .sjs-timeslider:not([hidden])'));
    const bounds = await app.locator('#chart .sjs-timeslider').evaluate((slider) => ({
      slider: slider.getBoundingClientRect().toJSON(),
      controls: document.querySelector('#chart .sjs-controls').getBoundingClientRect().toJSON(),
      stage: document.querySelector('#chart .sjs-stage').getBoundingClientRect().toJSON(),
    }));
    assert(bounds.slider.height <= 844 * 0.05 + 1, `mobile slider exceeds 5% viewport: ${bounds.slider.height}px`);
    assert(bounds.slider.bottom <= bounds.controls.top + 1 || bounds.controls.top >= 844, `mobile slider overlaps controls: ${JSON.stringify(bounds)}`);
    assert(bounds.slider.left >= bounds.stage.left - 1 && bounds.slider.right <= bounds.stage.right + 1, 'mobile slider extends beyond display');
    await app.getByRole('button', { name: 'Load BUFKIT' }).scrollIntoViewIfNeeded();
    await app.waitForFunction(() => document.querySelector('#chart .sjs-timeslider[hidden]'));
    const overflow = await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `overflow ${overflow}px`);
    await app.context().close();
  });

  await check('no uncaught page errors', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  await harnessServer.close();
  await appServer.close();
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
