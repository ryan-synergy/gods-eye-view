// Pure tests for the job-site recon model. Run with: npm test (node --test). No Cesium, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSite,
  addPin,
  addMeasure,
  removeLast,
  removeItem,
  measureBetween,
  formatFeet,
  formatMeasurement,
  serializeSite,
  parseSite,
  siteFileName,
  normalizeSiteMode,
  MAX_SITE_ITEMS,
} from './siteModel.js';

const A = { lat: 30.2672, lon: -97.7431, height: 150 };

test('a ground-to-eave click pair reports the rise as mount height', () => {
  const eave = { lat: 30.2672, lon: -97.7431, height: 153.048 }; // +10 ft
  const m = measureBetween(A, eave);
  assert.ok(m.horizontalM < 0.001);
  assert.ok(Math.abs(m.verticalM - 3.048) < 1e-9);
  assert.match(formatMeasurement(A, eave), /rise ↑10\.0 ft/);
});

test('horizontal run matches a known distance within 0.5%', () => {
  // 0.001° of latitude ≈ 111.2 m
  const b = { lat: A.lat + 0.001, lon: A.lon, height: A.height };
  const { horizontalM, verticalM, slopeM } = measureBetween(A, b);
  assert.ok(Math.abs(horizontalM - 111.2) / 111.2 < 0.005);
  assert.equal(verticalM, 0);
  assert.equal(slopeM, horizontalM);
});

test('feet formatting keeps a decimal under 100 ft and shows metres', () => {
  assert.equal(formatFeet(3.048), '10.0 ft (3.0 m)');
  assert.equal(formatFeet(100), '328 ft (100 m)');
  assert.equal(formatFeet(NaN), '—');
});

test('pins get default labels, bad points are refused', () => {
  const site = createSite('Smith Residence');
  assert.equal(addPin(site, A).label, 'Pin 1');
  assert.equal(addPin(site, A, '  Rack   closet ').label, 'Rack closet');
  assert.equal(addPin(site, { lat: 91, lon: 0 }), null);
  assert.equal(addPin(site, { lat: NaN, lon: 0 }), null);
  assert.equal(site.pins.length, 2);
});

test('a zero-length measurement is refused', () => {
  const site = createSite();
  assert.equal(addMeasure(site, A, { ...A }), null);
  assert.ok(addMeasure(site, A, { ...A, lat: A.lat + 0.0001 }));
});

test('the site caps its item count', () => {
  const site = createSite();
  for (let i = 0; i < MAX_SITE_ITEMS; i += 1) addPin(site, A);
  assert.equal(addPin(site, A), null);
  assert.equal(addMeasure(site, A, { ...A, lat: 30.3 }), null);
});

test('undo removes the newest item across pins and measures', () => {
  const site = createSite();
  addPin(site, A, 'first');
  const m = addMeasure(site, A, { ...A, lat: 30.3 });
  assert.equal(removeLast(site), true);
  assert.equal(site.measures.length, 0);
  assert.equal(site.pins.length, 1);
  assert.equal(removeItem(site, m.id), false);
  assert.equal(removeLast(site), true);
  assert.equal(removeLast(site), false);
});

test('a site round-trips through its file format, cameras untouched', () => {
  const site = createSite('Lake House');
  site.view = {
    lat: 30,
    lon: -97,
    height: 400,
    heading: 1,
    pitch: -0.6,
    roll: 0,
  };
  addPin(site, A, 'Gate');
  addMeasure(site, A, { ...A, height: 155 }, 'Eave');
  site.cameras = [{ id: 'cam-1', fovDeg: 90 }];
  const { site: back, error, skipped } = parseSite(serializeSite(site));
  assert.equal(error, null);
  assert.equal(skipped, 0);
  assert.equal(back.name, 'Lake House');
  assert.deepEqual(back.view, site.view);
  assert.equal(back.pins[0].label, 'Gate');
  assert.equal(back.measures[0].b.height, 155);
  assert.deepEqual(back.cameras, [{ id: 'cam-1', fovDeg: 90 }]);
});

test('parsing rejects foreign or newer files and skips bad items', () => {
  assert.match(parseSite('nope').error, /JSON/);
  assert.match(parseSite('{"format":"other"}').error, /site file/);
  assert.match(parseSite('{"format":"gev-site","version":99}').error, /newer/);
  const { site, skipped } = parseSite({
    format: 'gev-site',
    version: 1,
    pins: [A, { lat: 'x' }],
    measures: [{ a: A }],
  });
  assert.equal(site.pins.length, 1);
  assert.equal(skipped, 2);
});

test('file names are safe and modes normalize', () => {
  assert.equal(
    siteFileName(createSite('Smith / Residence #2')),
    'smith-residence-2.gev-site.json',
  );
  assert.equal(siteFileName(createSite('')), 'site.gev-site.json');
  assert.equal(normalizeSiteMode('measure'), 'measure');
  assert.equal(normalizeSiteMode('bogus'), 'pin');
});
