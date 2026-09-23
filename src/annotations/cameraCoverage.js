/**
 * Camera coverage planner: the Cesium half.
 *
 * `castCoverage` samples a planned camera's view with the ray grid from
 * cameraPlan.js, against the world only: the globe (terrain) and any 3D
 * tileset (photoreal buildings). Hits on anything else — live aircraft, our own
 * pins — are ignored, so a plane overhead cannot punch a hole in a plan.
 *
 * This deliberately breaks the CCTV layer's "zero-raycast" rule
 * (src/layers/cctv/geometry.js): that rule protects a per-frame live layer,
 * while a plan is cast once when a camera is placed or recomputed, in time
 * slices so the frame never stalls.
 *
 * `createCoveragePrimitive` turns the hits into one translucent surface per
 * DORI band; occluded regions are simply absent.
 */
import * as Cesium from 'cesium';
import {
  DORI_BANDS,
  GRID,
  coverageRangeM,
  rayGridEnu,
  triangulateHits,
} from './cameraPlan.js';

/** Metres the ray origin is nudged along the view so a wall mount clears its wall. */
const MOUNT_CLEARANCE_M = 0.35;
/** Metres a hit is pulled back toward the camera so the surface never z-fights. */
const SURFACE_LIFT_M = 0.15;
const SLICE_MS = 10;

const isWorldHit = (object) =>
  object instanceof Cesium.Cesium3DTileFeature ||
  object?.primitive instanceof Cesium.Cesium3DTileset;

/** Mount position (ECEF) and the grid's ray directions (ECEF unit vectors). */
export function coverageFrame(cam, grid = GRID) {
  const mount = Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(mount);
  const dirs = rayGridEnu(cam, grid).map((d) =>
    Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        new Cesium.Cartesian3(d[0], d[1], d[2]),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
  );
  // Nudge the origin horizontally along the heading, off the wall it sits on.
  const fwd = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(Math.sin(cam.heading), Math.cos(cam.heading), 0),
    new Cesium.Cartesian3(),
  );
  const origin = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(fwd, MOUNT_CLEARANCE_M, fwd),
    new Cesium.Cartesian3(),
  );
  return { mount, origin, dirs };
}

/** Distance along one ray to the first world surface, or null. */
function castOne(scene, ray, exclude, rangeM) {
  let best = null;
  if (scene.globe?.show) {
    try {
      const g = scene.globe.pick(ray, scene);
      if (g) best = Cesium.Cartesian3.distance(ray.origin, g);
    } catch {
      /* no terrain under this ray yet */
    }
  }
  if (typeof scene.pickFromRay === 'function') {
    try {
      let hit = scene.pickFromRay(ray, exclude);
      if (hit?.position && !isWorldHit(hit.object) && hit.object) {
        // Something non-world is in the way; look past it.
        const all = scene.drillPickFromRay(ray, 4, exclude) || [];
        hit = all.find((h) => h?.position && isWorldHit(h.object)) || null;
      }
      if (hit?.position) {
        const d = Cesium.Cartesian3.distance(ray.origin, hit.position);
        if (best === null || d < best) best = d;
      }
    } catch {
      /* pick pass failed for this ray — keep the globe answer */
    }
  }
  return best !== null && best <= rangeM ? best : null;
}

/**
 * Cast the whole grid in time slices, yielding to the page between them.
 * @param {Cesium.Scene} scene
 * @param {object} cam normalized planned camera
 * @param {{exclude?: object[], onProgress?: Function, isCancelled?: Function}} opts
 * @returns {Promise<{distances: Array<number|null>, frame: object}|null>} null if cancelled
 */
export async function castCoverage(scene, cam, opts = {}) {
  const { exclude = [], onProgress, isCancelled = () => false } = opts;
  const frame = coverageFrame(cam);
  const rangeM = coverageRangeM(cam);
  const distances = new Array(frame.dirs.length).fill(null);
  let i = 0;
  while (i < frame.dirs.length) {
    if (isCancelled()) return null;
    const start = performance.now();
    while (i < frame.dirs.length && performance.now() - start < SLICE_MS) {
      distances[i] = castOne(
        scene,
        new Cesium.Ray(frame.origin, frame.dirs[i]),
        exclude,
        rangeM,
      );
      i += 1;
    }
    onProgress?.(i / frame.dirs.length);
    // A timer, not requestAnimationFrame: rAF never fires in a hidden tab, and
    // a plan should finish casting while the person looks at another window.
    await new Promise((r) => setTimeout(r, 0));
  }
  return { distances, frame };
}

/** One translucent surface per DORI band; occluded cells are absent. */
export function createCoveragePrimitive(
  cam,
  { distances, frame },
  alpha = 0.42,
) {
  const bands = triangulateHits(cam, distances);
  const point = (i) =>
    Cesium.Cartesian3.add(
      frame.origin,
      Cesium.Cartesian3.multiplyByScalar(
        frame.dirs[i],
        Math.max(0, distances[i] - SURFACE_LIFT_M),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
  const instances = [];
  bands.forEach((cells, b) => {
    if (!cells.length) return;
    const used = new Map();
    const flat = [];
    const indexOf = (gi) => {
      if (!used.has(gi)) {
        const p = point(gi);
        used.set(gi, flat.length / 3);
        flat.push(p.x, p.y, p.z);
      }
      return used.get(gi);
    };
    const indices = [];
    for (const [tl, tr, br, bl] of cells) {
      const a = indexOf(tl);
      const c = indexOf(br);
      indices.push(a, indexOf(tr), c, a, c, indexOf(bl));
    }
    const values = new Float64Array(flat);
    instances.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.Geometry({
          attributes: {
            position: new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.DOUBLE,
              componentsPerAttribute: 3,
              values,
            }),
          },
          indices:
            flat.length / 3 > 65535
              ? new Uint32Array(indices)
              : new Uint16Array(indices),
          primitiveType: Cesium.PrimitiveType.TRIANGLES,
          boundingSphere: Cesium.BoundingSphere.fromVertices(flat),
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(DORI_BANDS[b].color).withAlpha(
              alpha,
            ),
          ),
        },
      }),
    );
  });
  if (!instances.length) return null;
  return new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      renderState: { cull: { enabled: false } },
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

/** The four frustum edge rays, to their hit or to range: an outline of the view. */
export function frustumEdges(cam, { distances, frame }, grid = GRID) {
  const rangeM = coverageRangeM(cam);
  const corners = [
    0,
    grid.cols - 1,
    grid.cols * grid.rows - 1,
    grid.cols * (grid.rows - 1),
  ];
  return corners.map((i) =>
    Cesium.Cartesian3.add(
      frame.origin,
      Cesium.Cartesian3.multiplyByScalar(
        frame.dirs[i],
        distances[i] ?? rangeM,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
  );
}

/** Resolve once the globe and tiles in view have finished loading (or timeout). */
export async function whenSceneSettled(scene, timeoutMs = 8000) {
  const start = performance.now();
  const tilesets = () => {
    const out = [];
    const prims = scene.primitives;
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) out.push(p);
    }
    return out;
  };
  while (performance.now() - start < timeoutMs) {
    const globeDone = !scene.globe?.show || scene.globe.tilesLoaded;
    if (globeDone && tilesets().every((t) => t.tilesLoaded)) return true;
    scene.requestRender();
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
