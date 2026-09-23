#!/usr/bin/env node
/**
 * Prove the Site tool's camera coverage planner in a real browser: two real
 * mouse clicks place a camera, its coverage is cast against the loaded world
 * and drawn, the schedule exports, and undo tears the coverage down.
 *
 * Needs the dev server: npm run dev, then node scripts/qa-site-camera.mjs
 * [--url http://localhost:4173] [--shot path.png] [--photoreal]
 *
 * --photoreal switches to the 3D-tiles stack (needs a Cesium ion token or
 * Google key) so the cast runs against real buildings.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = arg('--url', 'http://localhost:4173');
const shot = arg('--shot', null);
const photoreal = args.includes('--photoreal');

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevSiteTool && window.__godsEyeView,
    {
      timeout: 90_000,
    },
  );

  if (photoreal) {
    const stack = await page.evaluate(async () => {
      const maps = window.__godsEyeView.mapStackController;
      if (!maps.isStackAvailable('photoreal')) return 'unavailable';
      await maps.setStack('photoreal');
      return maps.getActiveId();
    });
    assert.equal(stack, 'photoreal', 'photoreal 3D stack is active');
  }

  // Look down on the Texas Capitol grounds and let the world load.
  await page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    const C3 = v.camera.positionWC.constructor;
    v.camera.setView({
      destination: C3.fromDegrees(-97.7404, 30.2718, 480),
      orientation: { heading: 0, pitch: -0.9, roll: 0 },
    });
    const start = performance.now();
    while (performance.now() - start < 30_000) {
      v.scene.requestRender();
      let ready = !v.scene.globe.show || v.scene.globe.tilesLoaded;
      for (let i = 0; i < v.scene.primitives.length; i += 1) {
        const p = v.scene.primitives.get(i);
        if (p?.show && 'tilesLoaded' in p && !p.tilesLoaded) ready = false;
      }
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  // Camera mode, 12 ft mount, 4 mm / 4 MP, via the real controls.
  await page.evaluate(() => {
    document.getElementById('site-toggle').click();
    document.querySelector('[data-site-mode="camera"]').click();
    document.getElementById('site-mount-input').value = '12';
    document.getElementById('site-label-input').value = 'Front lawn';
  });
  // Mount near the lower middle of the view, aim further up the screen.
  await page.mouse.click(640, 560);
  await page.mouse.click(640, 470);

  const placed = await page.evaluate(() => {
    const c = window.__gevSiteTool.site.cameras[0];
    return (
      c && {
        label: c.label,
        raisedFt: (c.height - c.groundHeight) * 3.280839895,
        tilt: c.tilt,
      }
    );
  });
  assert.ok(placed, 'two clicks placed a camera');
  assert.equal(placed.label, 'Front lawn');
  assert.ok(
    Math.abs(placed.raisedFt - 12) < 0.5,
    `mount raised 12 ft (${placed.raisedFt})`,
  );
  // Aim follows the clicked point, terrain slope included (the grounds rise
  // toward the Capitol), so only require a sane, near-level-or-down tilt.
  assert.ok(placed.tilt < 0.1, `aimed at the clicked ground (${placed.tilt})`);

  await page.waitForFunction(() => window.__gevSiteTool.coverage()[0]?.cast, {
    timeout: 90_000,
  });
  const result = await page.evaluate(() => {
    const t = window.__gevSiteTool;
    const v = window.__godsEyeView.viewer;
    // The coverage surface: translucent, unpickable, per-band coloured.
    let coveragePrimitives = 0;
    for (let i = 0; i < v.scene.primitives.length; i += 1) {
      const p = v.scene.primitives.get(i);
      if (
        p?.allowPicking === false &&
        p.appearance?.constructor?.name === 'PerInstanceColorAppearance' &&
        p.appearance.translucent
      )
        coveragePrimitives += 1;
    }
    v.scene.requestRender();
    return {
      coverage: t.coverage()[0],
      coveragePrimitives,
      csv: t.camerasCsv(),
      hint: document.getElementById('site-hint').textContent,
      legend: [...document.querySelectorAll('.site-dori-item')].map(
        (e) => e.textContent,
      ),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.coverage.fraction > 0.25, 'a downward camera sees ground');
  assert.ok(
    result.coverage.fraction < 1,
    'the top of the view reaches past Detect range',
  );
  assert.match(result.csv.split('\n')[1], /Front lawn,4 mm,84,4 MP,12\.0,/);
  assert.equal(result.legend.length, 4);
  assert.ok(result.coveragePrimitives >= 1, 'coverage surface is drawn');

  if (shot) {
    // Close in over the camera so the coverage is legible.
    await page.evaluate(async () => {
      const v = window.__godsEyeView.viewer;
      const c = window.__gevSiteTool.site.cameras[0];
      const C3 = v.camera.positionWC.constructor;
      v.camera.setView({
        destination: C3.fromDegrees(c.lon, c.lat - 0.0009, c.height + 110),
        orientation: { heading: c.heading, pitch: -0.95, roll: 0 },
      });
      for (let i = 0; i < 40 && !v.scene.globe.tilesLoaded; i += 1) {
        v.scene.requestRender();
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: shot });
    console.log(`screenshot: ${shot}`);
  }

  // Undo removes the camera and its coverage.
  const after = await page.evaluate(async () => {
    window.__gevSiteTool.undo();
    await new Promise((r) => setTimeout(r, 100));
    return window.__gevSiteTool.coverage().length;
  });
  assert.equal(after, 0);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('qa-site-camera: ok');
} finally {
  await browser.close();
}
