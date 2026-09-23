/**
 * Job-site recon: the Cesium + DOM half.
 *
 * DISPLAY ▸ Site turns a click on the world into a labelled pin or one end of
 * a measurement, keeps them in a named site (see siteModel.js), and saves /
 * loads / exports that site with the camera view that frames it.
 *
 * Pointer rules are the Draw tool's (drawTool.js): the tool holds the shared
 * pointer claim while active and borrows Cesium's stock click/double-click for
 * the session, giving both back on the way out. `destroy()` releases every
 * listener, handler, data source and the window handle.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from './annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import {
  addMeasure,
  addPin,
  createSite,
  formatMeasurement,
  normalizeSiteMode,
  parseSite,
  removeLast,
  serializeSite,
  siteFileName,
  siteHint,
} from './siteModel.js';

/** The id this tool claims the pointer under. */
export const SITE_POINTER_OWNER = 'site';
const DATA_SOURCE_NAME = 'gev-site';
const STORAGE_KEY = 'gev.sites.v1';
const PIN_COLOR = Cesium.Color.fromCssColorString('#ffb547');
const MEASURE_COLOR = Cesium.Color.fromCssColorString('#5dff9f');
const PENDING_COLOR = Cesium.Color.fromCssColorString('#8be9ff');

const readStore = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
};
const writeStore = (store) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
};

/**
 * Wire the Site control.
 * @param {{viewer: Cesium.Viewer}} deps
 * @returns {{destroy: Function}|null}
 */
export function initSiteTool({ viewer }) {
  const $ = (id) => document.getElementById(id);
  const toggle = $('site-toggle');
  const modeRow = $('site-mode-row');
  const labelRow = $('site-label-row');
  const fileRow = $('site-file-row');
  const labelInput = $('site-label-input');
  const nameInput = $('site-name-input');
  const loadSelect = $('site-load-select');
  const fileInput = $('site-import-input');
  const hint = $('site-hint');
  if (!viewer || !toggle) return null;

  let active = false;
  let destroyed = false;
  let mode = 'pin';
  let site = createSite();
  let pending = null; // first end of a measurement in progress
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let cursor = null;
  let status = '';
  const domListeners = [];
  const listen = (target, type, fn, options) => {
    if (!target) return;
    target.addEventListener(type, fn, options);
    domListeners.push([target, type, fn, options]);
  };

  const dataSource = new Cesium.CustomDataSource(DATA_SOURCE_NAME);
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );
  const cart = (p) =>
    Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0);
  const labelStyle = (text, color) => ({
    text,
    font: '600 12px "JetBrains Mono", monospace',
    fillColor: color,
    outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    showBackground: true,
    backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
    pixelOffset: new Cesium.Cartesian2(0, -18),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  const dot = (color, size = 9) => ({
    pixelSize: size,
    color,
    outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });

  // The rubber band from the pending point to the pointer.
  const rubber = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new Cesium.CallbackProperty(
        () => (pending && cursor ? [cart(pending), cursor] : []),
        false,
      ),
      width: 2,
      material: new Cesium.PolylineDashMaterialProperty({
        color: PENDING_COLOR.withAlpha(0.9),
        dashLength: 12,
      }),
    },
  });
  const rendered = [];

  const setHint = () => {
    if (!hint) return;
    const counts = `${site.pins.length} pin${site.pins.length === 1 ? '' : 's'}, ${site.measures.length} measurement${site.measures.length === 1 ? '' : 's'}`;
    hint.textContent = [active ? siteHint(mode, !!pending) : '', counts, status]
      .filter(Boolean)
      .join(' · ');
  };

  function render() {
    if (destroyed) return;
    rendered.splice(0).forEach((e) => dataSource.entities.remove(e));
    for (const pin of site.pins) {
      rendered.push(
        dataSource.entities.add({
          position: cart(pin),
          point: dot(PIN_COLOR),
          label: labelStyle(pin.label, PIN_COLOR),
        }),
      );
    }
    for (const m of site.measures) {
      const a = cart(m.a);
      const b = cart(m.b);
      const mid = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
      const text =
        (m.label ? `${m.label}: ` : '') + formatMeasurement(m.a, m.b);
      rendered.push(
        dataSource.entities.add({
          polyline: {
            positions: [a, b],
            width: 3,
            material: MEASURE_COLOR,
            depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
              color: MEASURE_COLOR.withAlpha(0.45),
              dashLength: 10,
            }),
          },
        }),
        dataSource.entities.add({ position: a, point: dot(MEASURE_COLOR, 7) }),
        dataSource.entities.add({ position: b, point: dot(MEASURE_COLOR, 7) }),
        dataSource.entities.add({
          position: mid,
          label: labelStyle(text, MEASURE_COLOR),
        }),
      );
    }
    if (pending) {
      rendered.push(
        dataSource.entities.add({
          position: cart(pending),
          point: dot(PENDING_COLOR),
        }),
      );
    }
    rubber.show = !!pending;
    setHint();
    viewer.scene.requestRender();
  }

  // ---- clicks ------------------------------------------------------------
  const worldAt = (position) => {
    const c = viewer.scene.canvas;
    return pickWorldFromScreen(
      viewer,
      position.x / (c.clientWidth || c.width || 1),
      position.y / (c.clientHeight || c.height || 1),
    );
  };
  const takeLabel = () => {
    const text = labelInput?.value || '';
    if (labelInput) labelInput.value = '';
    return text;
  };
  const onClick = (event) => {
    if (!active || destroyed) return;
    const p = worldAt(event.position);
    status = '';
    if (!p) {
      status = 'That point is off the globe.';
    } else if (mode === 'pin') {
      if (!addPin(site, p, takeLabel())) status = 'Could not add that pin.';
    } else if (!pending) {
      pending = p;
    } else {
      if (!addMeasure(site, pending, p, takeLabel()))
        status = 'Those two points are the same spot.';
      pending = null;
      cursor = null;
    }
    render();
  };
  const onMove = (event) => {
    if (!pending || destroyed) return;
    const p = worldAt(event.endPosition);
    cursor = p ? cart(p) : null;
    viewer.scene.requestRender();
  };

  // ---- keys -------------------------------------------------------------
  const typingElsewhere = (t) =>
    t &&
    t !== labelInput &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const onKey = (event) => {
    if (!active || destroyed || typingElsewhere(event.target)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pending) {
        pending = null;
        cursor = null;
        render();
      } else setActive(false);
    } else if (event.key === 'Backspace' && event.target !== labelInput) {
      event.preventDefault();
      undo();
    }
  };

  function undo() {
    if (pending) pending = null;
    else removeLast(site);
    status = '';
    render();
  }

  // ---- mode on / off ------------------------------------------------------
  function setActive(next) {
    if (destroyed || next === active) return active;
    if (next) {
      lease = claimPointer(SITE_POINTER_OWNER);
      if (!lease) {
        status = `${pointerOwner()} is using the pointer — close it first.`;
        setHint();
        return active;
      }
    }
    active = next;
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
    for (const row of [modeRow, labelRow, fileRow])
      row?.classList.toggle('visible', active);
    document.body.classList.toggle('gev-siting', active);
    if (active) {
      status = '';
      refreshLoadList();
      bindSceneHandler();
    } else {
      pending = null;
      cursor = null;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
    }
    render();
    return active;
  }

  function bindSceneHandler() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    const stock = viewer.screenSpaceEventHandler;
    savedSingleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
    savedDoubleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
      null;
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    listen(document, 'keydown', onKey, true);
  }

  function releaseSceneHandler() {
    handler?.destroy();
    handler = null;
    const stock = viewer.screenSpaceEventHandler;
    if (savedSingleClick)
      stock.setInputAction(
        savedSingleClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    if (savedDoubleClick)
      stock.setInputAction(
        savedDoubleClick,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    savedSingleClick = null;
    savedDoubleClick = null;
    for (let i = domListeners.length - 1; i >= 0; i -= 1) {
      const [target, type, fn, options] = domListeners[i];
      if (fn !== onKey) continue;
      target.removeEventListener(type, fn, options);
      domListeners.splice(i, 1);
    }
  }

  // ---- site file: save / load / export / import ---------------------------
  const captureView = () => {
    const c = viewer.camera.positionCartographic;
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      height: c.height,
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch,
      roll: viewer.camera.roll,
    };
  };
  const flyToView = (view) => {
    if (!view) return;
    viewer.trackedEntity = undefined;
    viewer.camera.flyTo({
      destination: cart(view),
      orientation: {
        heading: view.heading,
        pitch: view.pitch,
        roll: view.roll,
      },
      duration: 2,
    });
  };
  function refreshLoadList() {
    if (!loadSelect) return;
    const names = Object.keys(readStore()).sort((a, b) => a.localeCompare(b));
    loadSelect.replaceChildren(
      new Option(names.length ? 'Open saved…' : 'No saved sites', ''),
      ...names.map((n) => new Option(n, n)),
    );
  }
  function adopt(next, note) {
    site = next;
    pending = null;
    if (nameInput) nameInput.value = site.name;
    status = note;
    render();
    flyToView(site.view);
  }
  function save() {
    const name = (nameInput?.value || '').trim();
    if (!name) {
      status = 'Name the site first.';
      nameInput?.focus();
      return setHint();
    }
    site.name = name;
    site.view = captureView();
    site.savedAt = new Date().toISOString();
    const store = readStore();
    store[name] = JSON.parse(serializeSite(site));
    status = writeStore(store)
      ? `Saved “${name}” with this view.`
      : 'Browser storage is full or blocked — use Export.';
    refreshLoadList();
    setHint();
  }
  function load(name) {
    const { site: next, error } = parseSite(readStore()[name]);
    if (!next) {
      status = error;
      return setHint();
    }
    adopt(next, `Opened “${name}”.`);
  }
  function exportFile() {
    if (nameInput?.value.trim()) site.name = nameInput.value.trim();
    site.view = captureView();
    site.savedAt = new Date().toISOString();
    const url = URL.createObjectURL(
      new Blob([serializeSite(site)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = siteFileName(site);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status = `Exported ${a.download}.`;
    setHint();
  }
  async function importFile(file) {
    if (!file) return;
    const { site: next, error, skipped } = parseSite(await file.text());
    if (!next) {
      status = error;
      return setHint();
    }
    adopt(
      next,
      `Imported “${next.name || file.name}”${skipped ? ` (${skipped} bad items skipped)` : ''}.`,
    );
  }
  function newSite() {
    site = createSite();
    pending = null;
    if (nameInput) nameInput.value = '';
    status = 'New site.';
    render();
  }

  // ---- control bindings ---------------------------------------------------
  listen(toggle, 'click', () => setActive(!active));
  const modeButtons = [
    ...(modeRow?.querySelectorAll('.pp-mode-btn[data-site-mode]') || []),
  ];
  const selectMode = (next) => {
    mode = normalizeSiteMode(next);
    pending = null;
    cursor = null;
    for (const btn of modeButtons) {
      const on = btn.dataset.siteMode === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    }
    render();
  };
  for (const btn of modeButtons)
    listen(btn, 'click', () => selectMode(btn.dataset.siteMode));
  listen($('site-undo'), 'click', undo);
  listen($('site-new'), 'click', newSite);
  listen($('site-save'), 'click', save);
  listen($('site-export'), 'click', exportFile);
  listen($('site-import'), 'click', () => fileInput?.click());
  listen(fileInput, 'change', () => {
    void importFile(fileInput.files?.[0]);
    fileInput.value = '';
  });
  listen(loadSelect, 'change', () => {
    if (loadSelect.value) load(loadSelect.value);
    loadSelect.value = '';
  });
  listen(nameInput, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
  setHint();

  const api = {
    get active() {
      return active;
    },
    get mode() {
      return mode;
    },
    get site() {
      return site;
    },
    setActive,
    setMode: selectMode,
    /** Test seam: a click on the world at lon/lat/height. */
    clickAt(lon, lat, height = 0) {
      const p = { lon, lat, height };
      if (!active) return false;
      if (mode === 'pin') addPin(site, p, takeLabel());
      else if (!pending) pending = p;
      else {
        addMeasure(site, pending, p, takeLabel());
        pending = null;
      }
      render();
      return true;
    },
    undo,
    save,
    load,
    newSite,
    exportJson: () => serializeSite(site),
    importJson(text) {
      const { site: next, error } = parseSite(text);
      if (next) adopt(next, 'Imported.');
      return error;
    },
    whenSettled: () => attaching,
    destroy() {
      if (destroyed) return attaching;
      if (active) setActive(false);
      destroyed = true;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
      for (const [target, type, fn, options] of domListeners.splice(0))
        target.removeEventListener(type, fn, options);
      dataSource.entities.removeAll();
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
      document.body.classList.remove('gev-siting');
      if (window.__gevSiteTool === api) delete window.__gevSiteTool;
      return attaching;
    },
  };
  window.__gevSiteTool = api;
  return api;
}
