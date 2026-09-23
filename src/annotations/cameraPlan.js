/**
 * Camera coverage planner: the pure half. No Cesium, no DOM.
 *
 * A planned camera is a mount point, an aim (heading + tilt), a lens and a
 * sensor resolution. From those this module derives:
 *
 * - the ray grid that samples the camera's view (local east-north-up
 *   directions, a real rectangular pinhole frustum, not a cone), and
 * - the DORI band each sampled surface point falls in. DORI (IEC 62676-4) is
 *   the pixel density on target: Detect 25 px/m, Observe 62, Recognize 125,
 *   Identify 250. Pixel density falls off with distance, so the bands are
 *   concentric distance limits along each ray.
 *
 * The Cesium half (cameraCoverage.js) casts the rays against the world and
 * uses `triangulateHits` to turn the hits into a coloured surface. A cell
 * whose corners land at very different distances straddles an occluder edge
 * and is dropped, which is what leaves a blind spot visible as a gap.
 */

export const DORI_BANDS = Object.freeze([
  { id: 'identify', label: 'Identify', pxPerM: 250, color: '#5dff9f' },
  { id: 'recognize', label: 'Recognize', pxPerM: 125, color: '#39d0ff' },
  { id: 'observe', label: 'Observe', pxPerM: 62, color: '#ffb547' },
  { id: 'detect', label: 'Detect', pxPerM: 25, color: '#ff6b6b' },
]);

/** Common fixed lenses on a 1/2.8"-class sensor → horizontal FOV, degrees. */
export const LENSES = Object.freeze([
  { id: '2.8', label: '2.8 mm', hfovDeg: 103 },
  { id: '4', label: '4 mm', hfovDeg: 84 },
  { id: '6', label: '6 mm', hfovDeg: 54 },
  { id: '8', label: '8 mm', hfovDeg: 40 },
  { id: '12', label: '12 mm', hfovDeg: 27 },
]);

/** Sensor horizontal pixel counts (16:9). */
export const RESOLUTIONS = Object.freeze([
  { id: '2mp', label: '2 MP', widthPx: 1920 },
  { id: '4mp', label: '4 MP', widthPx: 2688 },
  { id: '8mp', label: '8 MP (4K)', widthPx: 3840 },
]);

export const ASPECT = 9 / 16;
export const MAX_RANGE_M = 200;
export const MIN_RANGE_M = 2;
export const GRID = Object.freeze({ cols: 40, rows: 22 });
/** Neighbouring hits further apart than this ratio straddle an occluder edge. */
export const EDGE_RATIO = 1.3;

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const FT = 3.280839895;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export const lensById = (id) => LENSES.find((l) => l.id === id) || LENSES[1];
export const resolutionById = (id) =>
  RESOLUTIONS.find((r) => r.id === id) || RESOLUTIONS[1];

/** Vertical FOV (degrees) for a horizontal FOV at 16:9. */
export function vfovDeg(hfov) {
  return (2 * Math.atan(Math.tan((hfov * DEG) / 2) * ASPECT)) / DEG;
}

/** Pixels per metre across the image width at distance `d` metres. */
export function pxPerMAt(widthPx, hfov, d) {
  return widthPx / (2 * d * Math.tan((hfov * DEG) / 2));
}

/** Furthest distance (m) at which a band's pixel density is still met. */
export function bandDistanceM(widthPx, hfov, pxPerM) {
  return widthPx / (2 * pxPerM * Math.tan((hfov * DEG) / 2));
}

/** All four DORI limits for a camera, metres, in band order. */
export function doriDistances(cam) {
  const { widthPx } = resolutionById(cam.resolution);
  const { hfovDeg } = lensById(cam.lens);
  return DORI_BANDS.map((b) => ({
    ...b,
    distanceM: bandDistanceM(widthPx, hfovDeg, b.pxPerM),
  }));
}

/** Index into DORI_BANDS for a point `d` metres away, or -1 beyond Detect. */
export function bandIndexAt(cam, d) {
  const limits = doriDistances(cam);
  return limits.findIndex((b) => d <= b.distanceM);
}

/** How far to cast rays: the Detect limit, clamped. */
export function coverageRangeM(cam) {
  const detect = doriDistances(cam)[3].distanceM;
  return Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, detect));
}

/**
 * Heading (radians clockwise from north) and tilt (radians, negative = down)
 * from a mount to an aim point, on a local flat-earth approximation that is
 * exact enough over a property.
 */
export function aimFromPoints(mount, aim) {
  const dx =
    (aim.lon - mount.lon) * DEG * EARTH_RADIUS_M * Math.cos(mount.lat * DEG);
  const dy = (aim.lat - mount.lat) * DEG * EARTH_RADIUS_M;
  const dz = (aim.height || 0) - (mount.height || 0);
  const ground = Math.hypot(dx, dy);
  if (ground < 0.01 && Math.abs(dz) < 0.01) return null;
  return {
    heading: (Math.atan2(dx, dy) + 2 * Math.PI) % (2 * Math.PI),
    tilt: Math.atan2(dz, ground),
    distanceM: Math.hypot(ground, dz),
  };
}

/**
 * Unit ray directions for the camera, in the mount's local ENU frame
 * ([east, north, up]), row-major from top-left. A true pinhole: rays pass
 * through an evenly spaced grid on the image plane.
 */
export function rayGridEnu(cam, grid = GRID) {
  const h = cam.heading;
  const t = cam.tilt;
  const f = [Math.sin(h) * Math.cos(t), Math.cos(h) * Math.cos(t), Math.sin(t)];
  const r = [Math.cos(h), -Math.sin(h), 0];
  // up = r × f
  const u = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  const hfov = lensById(cam.lens).hfovDeg;
  const tx = Math.tan((hfov * DEG) / 2);
  const ty = Math.tan((vfovDeg(hfov) * DEG) / 2);
  const dirs = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const sy = ty * (1 - (2 * row) / (grid.rows - 1));
    for (let col = 0; col < grid.cols; col += 1) {
      const sx = tx * ((2 * col) / (grid.cols - 1) - 1);
      const d = [0, 1, 2].map((i) => f[i] + sx * r[i] + sy * u[i]);
      const n = Math.hypot(d[0], d[1], d[2]);
      dirs.push([d[0] / n, d[1] / n, d[2] / n]);
    }
  }
  return dirs;
}

/**
 * Triangulate a grid of ray-hit distances (row-major, `null` = no hit within
 * range) into cells grouped by DORI band. A cell is kept only when all four
 * corners hit and their distances agree within EDGE_RATIO; its band is that of
 * its FURTHEST corner (conservative: never over-promise detail).
 * @returns {Array<Array<[number, number, number, number]>>} per band, a list of
 *   cells as corner indices [tl, tr, br, bl].
 */
export function triangulateHits(cam, distances, grid = GRID) {
  const limits = doriDistances(cam).map((b) => b.distanceM);
  const bands = DORI_BANDS.map(() => []);
  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let col = 0; col < grid.cols - 1; col += 1) {
      const tl = row * grid.cols + col;
      const idx = [tl, tl + 1, tl + grid.cols + 1, tl + grid.cols];
      const ds = idx.map((i) => distances[i]);
      if (ds.some((d) => !finite(d) || d <= 0)) continue;
      const far = Math.max(...ds);
      if (far / Math.min(...ds) > EDGE_RATIO) continue;
      const band = limits.findIndex((lim) => far <= lim);
      if (band >= 0) bands[band].push(idx);
    }
  }
  return bands;
}

/** Share of the view (0–1) that reaches a surface within Detect range. */
export function coverageFraction(cam, distances, grid = GRID) {
  const cells = triangulateHits(cam, distances, grid).reduce(
    (n, b) => n + b.length,
    0,
  );
  return cells / ((grid.rows - 1) * (grid.cols - 1));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** 045° NE */
export function compass(headingRad) {
  const deg = Math.round(((headingRad / DEG) % 360) + 360) % 360;
  return `${String(deg).padStart(3, '0')}° ${COMPASS[Math.round(deg / 45) % 8]}`;
}

/** Normalize a planned camera (from a click, or from a site file). */
export function normalizeCamera(raw, index = 0) {
  if (
    !raw ||
    !finite(raw.lat) ||
    !finite(raw.lon) ||
    !finite(raw.heading) ||
    !finite(raw.tilt)
  )
    return null;
  return {
    id:
      typeof raw.id === 'string'
        ? raw.id
        : `cam-${Date.now().toString(36)}-${index}`,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 60)
        : `CAM ${index + 1}`,
    lat: raw.lat,
    lon: raw.lon,
    height: finite(raw.height) ? raw.height : 0,
    groundHeight: finite(raw.groundHeight) ? raw.groundHeight : null,
    heading: raw.heading,
    tilt: Math.max(-Math.PI / 2, Math.min(Math.PI / 6, raw.tilt)),
    lens: lensById(raw.lens).id,
    resolution: resolutionById(raw.resolution).id,
  };
}

/** Mount height above ground, feet, or null when ground is unknown. */
export function mountHeightFt(cam) {
  return finite(cam.groundHeight) ? (cam.height - cam.groundHeight) * FT : null;
}

/** One-line map label. */
export function cameraLabel(cam) {
  const mh = mountHeightFt(cam);
  const ident = doriDistances(cam)[0].distanceM * FT;
  return [
    cam.label,
    `${lensById(cam.lens).label} ${resolutionById(cam.resolution).label}`,
    mh === null ? null : `${Math.round(mh)} ft up`,
    compass(cam.heading),
    `ID ≤${Math.round(ident)} ft`,
  ]
    .filter(Boolean)
    .join(' · ');
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Camera schedule for a quote. */
export function camerasCsv(cameras, siteName = '') {
  const head = [
    'Site',
    'Camera',
    'Lens',
    'HFOV deg',
    'Resolution',
    'Mount height ft',
    'Heading',
    'Tilt deg',
    'Identify to ft',
    'Recognize to ft',
    'Observe to ft',
    'Detect to ft',
    'Latitude',
    'Longitude',
  ];
  const rows = cameras.map((c) => {
    const lens = lensById(c.lens);
    const d = doriDistances(c).map((b) => Math.round(b.distanceM * FT));
    const mh = mountHeightFt(c);
    return [
      siteName,
      c.label,
      lens.label,
      lens.hfovDeg,
      resolutionById(c.resolution).label,
      mh === null ? '' : mh.toFixed(1),
      compass(c.heading),
      String(Math.round(c.tilt / DEG) || 0),
      ...d,
      c.lat.toFixed(6),
      c.lon.toFixed(6),
    ];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
