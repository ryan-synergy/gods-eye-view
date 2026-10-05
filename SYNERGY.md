# Synergy fork notes

This is a fork of [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view).
The upstream `README.md` describes the app itself. This file covers only what
the fork adds, how to run and test it, and where it stands.

**Status: parked.** Two features are built and working on the branch
`synergy/site-recon`. Nothing is half-done. See [Next steps](#next-steps).

**This repository is public.** See [CLAUDE.md](CLAUDE.md) for what must never be
committed here.

## What the fork adds

Both features live in the app's **DISPLAY** panel, under a **Site** button, and
are meant for planning AV and security installs on a property.

### Job-site recon

- **Pin** — click the map to drop a labelled pin at the ground or roof height
  under the click.
- **Measure** — click two points to get straight-line distance, horizontal run
  and height difference, in feet. Ground to eave gives a mount height.
- **Site file** — name a site and save it in the browser, or export and import
  it as a `.gev-site.json` file. The file carries the map view, so opening it
  flies back to the property.

### Camera coverage planner

- **Place a camera** — choose **Camera**, click the mount point, then click
  where it should look. The **+ ft** field raises the mount above the clicked
  point, for when the click lands on the ground.
- **Lens and resolution** — presets from 2.8 mm to 12 mm and 2 MP to 8 MP.
- **Coverage** — each camera's view is sampled with a 40 × 22 grid of rays cast
  against terrain and 3D buildings. Surfaces it sees are coloured by detail
  level, using the IEC 62676-4 DORI pixel-density bands (Identify 250 px/m,
  Recognize 125, Observe 62, Detect 25). Areas blocked by a wall or tree are
  left empty, so blind spots show as gaps.
- **Recast** — re-runs coverage, for example after 3D buildings finish loading.
- **CSV** — downloads a camera schedule: lens, field of view, resolution, mount
  height, heading, tilt, the distance each detail level reaches, and position.

## Run it

Needs Node.js 24. Install steps and keys are in the upstream
[README](README.md#-quick-start).

```bash
npm ci
npm run dev
```

Open `http://localhost:4173`, then **DISPLAY ▸ Site**.

The app starts without keys on flat satellite imagery. On that map the planner
can only see ground, so blind spots behind buildings do not appear. Real
blocking needs the photoreal 3D map, which needs a Cesium ion token or a Google
Maps key added through the app's **POWER UP** panel. Restart the dev server
after adding a key.

## Test it

```bash
npm test                    # all unit tests, including the fork's
npm run format:check
npm run check:boundaries
npm run build
node scripts/qa-site-camera.mjs --shot /tmp/coverage.png
```

`scripts/qa-site-camera.mjs` needs the dev server running. It drives a real
headless Chrome: two mouse clicks place a camera, it waits for the coverage,
checks the drawn surface and the CSV, then undoes. Add `--photoreal` to cast
against 3D buildings (needs a key). Use this script rather than a browser tab
you are not looking at: a hidden tab does not render, so the map never loads.

## What it stores, and where

| What             | Where                                                  |
| ---------------- | ------------------------------------------------------ |
| Saved sites      | Browser `localStorage`, key `gev.sites.v1`, per device |
| Exported sites   | `.gev-site.json` files the user downloads              |
| Camera schedules | `-cameras.csv` files the user downloads                |
| Provider keys    | Local `.env`, ignored by Git, never committed          |

Nothing the fork adds is sent to a server. Saved sites do not sync between
devices; export the file to move one.

## Where the code is

| File                                     | Role                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `src/annotations/siteModel.js`           | Site file format, measuring maths (no Cesium)   |
| `src/annotations/siteTool.js`            | The Site panel, map clicks, drawing, save/load  |
| `src/annotations/cameraPlan.js`          | Lens, DORI and ray-grid maths, CSV (no Cesium)  |
| `src/annotations/cameraCoverage.js`      | Ray casting against the world, coverage surface |
| `src/ui/templates/display-controls.html` | The Site controls                               |
| `src/ui/styles/controls.css`             | Their styles                                    |
| `scripts/qa-site-camera.mjs`             | Real-browser check of the planner               |

Tests sit next to the code as `siteModel.test.mjs` and `cameraPlan.test.mjs`.

## Known gaps

- A placed camera cannot be edited. Undo it and place it again.
- Coverage does not update on its own when the map changes; press **Recast**.
- Measurement labels overlap when two measurements are close together.
- Lens angles are typical values for a 1/2.8" sensor, not any specific model.
- There is no night or infrared range limit; coverage runs to the Detect
  distance, capped at 200 m.
- The fork's changes are not recorded in upstream's `CHANGELOG.md` or
  `docs/CURRENT-STATE.md`. They would need to be before any upstream PR.

## Licensing

Upstream's licence is not a standard open-source one, and some bundled data is
non-commercial only; read `LICENSE` and `DATA_SOURCES.md`. The free Cesium ion
tier is for personal, non-commercial use. Using this on paid work needs a
commercial Cesium plan or a Google Maps key, and a licence check first.

## Next steps

None is started. In rough order of value:

1. Edit a placed camera (lens, aim, name) in place.
2. A printable coverage sheet: top-down image plus the schedule table.
3. Night coverage capped at each camera's infrared range.
4. Let the site-survey tools import `.gev-site.json` files.
