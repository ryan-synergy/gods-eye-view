/**
 * Job-site recon: the pure half. No Cesium, no DOM.
 *
 * A site is a named, saveable record of one property: the camera view that
 * frames it, labelled pins (gear locations, entry points, panel), and
 * point-to-point measurements (cable runs, mount heights), and planned
 * security cameras (see cameraPlan.js).
 *
 * Measurements keep the HEIGHT of both ends — the whole point is that a click
 * on the ground and a click on an eave gives a mount height — so unlike the
 * whiteboard (see `finishSpec` in drawMode.js) nothing is draped.
 */
import { normalizeCamera } from './cameraPlan.js';

export const SITE_FORMAT = 'gev-site';
export const SITE_VERSION = 1;
export const SITE_MODES = Object.freeze(['pin', 'measure', 'camera']);
export const MAX_SITE_ITEMS = 200;
export const FEET_PER_METER = 3.280839895;
const EARTH_RADIUS_M = 6371008.8;
const MAX_LABEL = 120;
const MAX_NAME = 80;

const toRad = (d) => (d * Math.PI) / 180;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Whether `p` is a usable world point: finite lat/lon in range, optional finite height. */
export function isSitePoint(p) {
  return (
    !!p &&
    finite(p.lat) &&
    finite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180 &&
    (p.height === undefined || finite(p.height))
  );
}

const cleanPoint = (p) => ({
  lat: p.lat,
  lon: p.lon,
  height: finite(p.height) ? p.height : 0,
});
const cleanText = (s, max) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Normalize a mode word; anything unknown is a pin. */
export function normalizeSiteMode(mode) {
  return SITE_MODES.includes(mode) ? mode : 'pin';
}

/** Great-circle ground distance between two points, metres (haversine). */
export function horizontalM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The three numbers an installer wants from two clicks.
 * @returns {{horizontalM: number, verticalM: number, slopeM: number}}
 *   `verticalM` is signed: positive when `b` is higher than `a`.
 */
export function measureBetween(a, b) {
  const h = horizontalM(a, b);
  const v =
    (finite(b.height) ? b.height : 0) - (finite(a.height) ? a.height : 0);
  return { horizontalM: h, verticalM: v, slopeM: Math.hypot(h, v) };
}

/** Feet with one decimal under 100 ft, whole feet above; metres in brackets. */
export function formatFeet(m) {
  if (!finite(m)) return '—';
  const ft = m * FEET_PER_METER;
  const abs = Math.abs(ft);
  const ftText = abs < 100 ? ft.toFixed(1) : String(Math.round(ft));
  const mText = Math.abs(m) < 100 ? m.toFixed(1) : String(Math.round(m));
  return `${ftText} ft (${mText} m)`;
}

/** One-line readout for a measurement: run, rise, straight line. */
export function formatMeasurement(a, b) {
  const { horizontalM: h, verticalM: v, slopeM: s } = measureBetween(a, b);
  const rise =
    Math.abs(v) < 0.05 ? '0 ft' : formatFeet(Math.abs(v)).split(' (')[0];
  const dir = v > 0.05 ? '↑' : v < -0.05 ? '↓' : '';
  return `${formatFeet(s).split(' (')[0]} · run ${formatFeet(h).split(' (')[0]} · rise ${dir}${rise}`;
}

/** A fresh, empty site. */
export function createSite(name = '') {
  return {
    format: SITE_FORMAT,
    version: SITE_VERSION,
    name: cleanText(name, MAX_NAME),
    savedAt: null,
    view: null,
    pins: [],
    measures: [],
    cameras: [],
  };
}

const itemCount = (site) =>
  site.pins.length + site.measures.length + site.cameras.length;
let idSeq = 0;
// Time and sequence lead so ids sort in creation order across kinds (undo).
const nextId = (prefix) =>
  `${Date.now().toString(36)}${(idSeq++ % 1679616).toString(36).padStart(4, '0')}-${prefix}`;

/** Add a labelled pin. Returns the pin, or null (bad point / site full). */
export function addPin(site, point, label = '') {
  if (!isSitePoint(point) || itemCount(site) >= MAX_SITE_ITEMS) return null;
  const pin = {
    id: nextId('pin'),
    label: cleanText(label, MAX_LABEL) || `Pin ${site.pins.length + 1}`,
    ...cleanPoint(point),
  };
  site.pins.push(pin);
  return pin;
}

/** Add a two-point measurement. Returns it, or null. */
export function addMeasure(site, a, b, label = '') {
  if (!isSitePoint(a) || !isSitePoint(b) || itemCount(site) >= MAX_SITE_ITEMS)
    return null;
  if (
    horizontalM(a, b) < 0.01 &&
    Math.abs((a.height || 0) - (b.height || 0)) < 0.01
  )
    return null;
  const m = {
    id: nextId('msr'),
    label: cleanText(label, MAX_LABEL),
    a: cleanPoint(a),
    b: cleanPoint(b),
  };
  site.measures.push(m);
  return m;
}

/**
 * Add a planned camera (mount, aim, lens, resolution). Returns the normalized
 * camera, or null.
 */
export function addCamera(site, raw) {
  if (itemCount(site) >= MAX_SITE_ITEMS) return null;
  const cam = normalizeCamera(raw, site.cameras.length);
  if (!cam) return null;
  cam.id = nextId('cam');
  site.cameras.push(cam);
  return cam;
}

/** Remove a pin, measurement or camera by id. */
export function removeItem(site, id) {
  const before = itemCount(site);
  site.pins = site.pins.filter((p) => p.id !== id);
  site.measures = site.measures.filter((m) => m.id !== id);
  site.cameras = site.cameras.filter((c) => c.id !== id);
  return itemCount(site) < before;
}

/** Remove the most recently added pin, measurement or camera. */
export function removeLast(site) {
  const last = [...site.pins, ...site.measures, ...site.cameras]
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .pop();
  return last ? removeItem(site, last.id) : false;
}

const cleanView = (v) =>
  v &&
  isSitePoint(v) &&
  finite(v.heading) &&
  finite(v.pitch) &&
  finite(v.roll ?? 0)
    ? {
        lat: v.lat,
        lon: v.lon,
        height: finite(v.height) ? v.height : 0,
        heading: v.heading,
        pitch: v.pitch,
        roll: v.roll ?? 0,
      }
    : null;

/** Serialize for a file or localStorage. */
export function serializeSite(site) {
  return JSON.stringify(
    { ...site, format: SITE_FORMAT, version: SITE_VERSION },
    null,
    2,
  );
}

/**
 * Parse and validate a site file. Unknown fields are dropped and bad items
 * are skipped rather than failing the whole file.
 * @returns {{site: object|null, error: string|null, skipped: number}}
 */
export function parseSite(text) {
  let raw;
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { site: null, error: 'Not valid JSON.', skipped: 0 };
  }
  if (!raw || typeof raw !== 'object' || raw.format !== SITE_FORMAT)
    return { site: null, error: "Not a God's Eye View site file.", skipped: 0 };
  if (!(raw.version <= SITE_VERSION))
    return {
      site: null,
      error: `Site file version ${raw.version} is newer than this app.`,
      skipped: 0,
    };
  const site = createSite(raw.name);
  site.savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : null;
  site.view = cleanView(raw.view);
  let skipped = 0;
  for (const p of Array.isArray(raw.pins) ? raw.pins : []) {
    const pin = addPin(site, p, p?.label);
    if (!pin) skipped += 1;
  }
  for (const m of Array.isArray(raw.measures) ? raw.measures : []) {
    const msr = addMeasure(site, m?.a, m?.b, m?.label);
    if (!msr) skipped += 1;
  }
  for (const c of Array.isArray(raw.cameras) ? raw.cameras : []) {
    if (!addCamera(site, c)) skipped += 1;
  }
  return { site, error: null, skipped };
}

/** A filesystem-safe file name for an exported site. */
export function siteFileName(site) {
  const base =
    cleanText(site.name, MAX_NAME)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site';
  return `${base}.gev-site.json`;
}

/** Hint line for the panel. */
export function siteHint(mode, pending) {
  if (mode === 'camera')
    return pending
      ? 'Now click where the camera should look.'
      : 'Click the mount point (eave, wall, pole), then where it should look.';
  if (mode === 'measure')
    return pending
      ? 'Click the second point. Esc cancels.'
      : 'Click two points: ground → eave gives mount height; A → B gives a run.';
  return 'Click the world to drop a pin. Type the label first. Backspace undoes.';
}
