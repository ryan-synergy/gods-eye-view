// Pure tests for the camera coverage planner. Run with: npm test (node --test). No Cesium, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aimFromPoints,
  bandDistanceM,
  bandIndexAt,
  cameraLabel,
  camerasCsv,
  compass,
  coverageFraction,
  coverageRangeM,
  doriDistances,
  normalizeCamera,
  rayGridEnu,
  triangulateHits,
  vfovDeg,
  GRID,
} from './cameraPlan.js';

const cam = normalizeCamera({
  lat: 30.27,
  lon: -97.74,
  height: 153,
  groundHeight: 150,
  heading: Math.PI / 2,
  tilt: -0.3,
  lens: '4',
  resolution: '4mp',
});

test('pixel density maths matches the DORI definition', () => {
  // 1920 px across a 90° lens: width at d is 2d, so 250 px/m at d = 3.84 m.
  assert.ok(Math.abs(bandDistanceM(1920, 90, 250) - 3.84) < 1e-9);
  const d = doriDistances(cam);
  assert.deepEqual(
    d.map((b) => b.id),
    ['identify', 'recognize', 'observe', 'detect'],
  );
  for (let i = 1; i < d.length; i += 1)
    assert.ok(d[i].distanceM > d[i - 1].distanceM);
  assert.equal(bandIndexAt(cam, 0.5), 0);
  assert.equal(bandIndexAt(cam, d[3].distanceM + 1), -1);
  assert.equal(coverageRangeM(cam), Math.min(200, d[3].distanceM));
});

test('a narrower lens reaches further for the same resolution', () => {
  const wide = doriDistances({ ...cam, lens: '2.8' })[0].distanceM;
  const tele = doriDistances({ ...cam, lens: '12' })[0].distanceM;
  assert.ok(tele > wide * 3);
});

test('vertical FOV follows 16:9', () => {
  assert.ok(Math.abs(vfovDeg(90) - 58.7) < 0.1);
});

test('aim from two points: due east and slightly down', () => {
  const a = aimFromPoints(
    { lat: 30, lon: -97, height: 10 },
    { lat: 30, lon: -96.9999, height: 7 },
  );
  assert.ok(Math.abs(a.heading - Math.PI / 2) < 1e-6);
  assert.ok(a.tilt < 0);
  assert.equal(aimFromPoints({ lat: 1, lon: 1 }, { lat: 1, lon: 1 }), null);
});

test('ray grid: unit vectors, centre looks along heading/tilt, corners span the FOV', () => {
  const grid = { cols: 3, rows: 3 };
  const dirs = rayGridEnu(cam, grid);
  assert.equal(dirs.length, 9);
  for (const d of dirs) assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
  const c = dirs[4];
  assert.ok(Math.abs(Math.atan2(c[0], c[1]) - cam.heading) < 1e-9);
  assert.ok(Math.abs(Math.asin(c[2]) - cam.tilt) < 1e-9);
  // left and right edge rays are symmetric about the centre and hfov apart
  const l = dirs[3];
  const r = dirs[5];
  const angle = Math.acos(l[0] * r[0] + l[1] * r[1] + l[2] * r[2]);
  assert.ok(Math.abs(angle - (84 * Math.PI) / 180) < 1e-9);
  // top row looks higher than bottom row
  assert.ok(dirs[1][2] > dirs[7][2]);
});

test('triangulation drops misses and occluder edges, bands by furthest corner', () => {
  const grid = { cols: 3, rows: 2 };
  const idLimit = doriDistances(cam)[0].distanceM;
  // cell 0 all near (identify); cell 1 has a depth jump (occluder edge)
  const distances = [1, 1, 5 * idLimit, 1, 1, 5 * idLimit];
  const bands = triangulateHits(cam, distances, grid);
  assert.equal(bands[0].length, 1);
  assert.equal(bands.flat().length, 1);
  const withMiss = triangulateHits(cam, [1, null, 1, 1, 1, 1], grid);
  assert.equal(withMiss.flat().length, 0);
});

test('coverage fraction counts kept cells over the full grid', () => {
  const all = new Array(GRID.cols * GRID.rows).fill(5);
  assert.equal(coverageFraction(cam, all), 1);
  const none = new Array(GRID.cols * GRID.rows).fill(null);
  assert.equal(coverageFraction(cam, none), 0);
});

test('normalize rejects incomplete cameras, clamps tilt, defaults lens', () => {
  assert.equal(normalizeCamera({ lat: 1, lon: 1 }), null);
  const c = normalizeCamera(
    { lat: 1, lon: 1, heading: 0, tilt: 3, lens: 'x' },
    4,
  );
  assert.equal(c.label, 'CAM 5');
  assert.equal(c.lens, '4');
  assert.ok(c.tilt <= Math.PI / 6);
});

test('labels and the CSV schedule read like a quote', () => {
  assert.equal(compass(Math.PI / 4), '045° NE');
  assert.match(
    cameraLabel(cam),
    /^CAM 1 · 4 mm 4 MP · 10 ft up · 090° E · ID ≤\d+ ft$/,
  );
  const csv = camerasCsv([{ ...cam, label: 'Front, porch' }], 'Smith');
  const [head, row] = csv.trim().split('\n');
  assert.match(head, /^Site,Camera,Lens/);
  assert.match(row, /^Smith,"Front, porch",4 mm,84,4 MP,9\.8,090° E,-17,/);
});
