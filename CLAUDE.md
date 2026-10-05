# Working rules for agents

Read [SYNERGY.md](SYNERGY.md) first. It says what this fork adds, how to run and
test it, what it stores and its known gaps. This file is the rules.

## What this is

A fork of `bilawalsidhu/gods-eye-view` (a CesiumJS live-data 3D globe) with two
additions for planning AV and security installs: job-site recon and a camera
coverage planner. Work is on the branch `synergy/site-recon`.

**The project is parked.** Both features work and are pushed. Nothing is
half-done. Do not start new work unless the owner asks for it.

## This repository is public

It is a public fork, and GitHub does not allow a fork to be made private.
Everything committed here is public, including commit messages.

Never commit:

- credentials, API keys or tokens (keys live in the local `.env`, which is
  ignored by Git; never print, copy or move a key's value)
- client names, real site addresses or their coordinates
- pricing of any kind
- email addresses, legal names or device IDs
- exported `.gev-site.json` files or camera CSVs from real jobs

Tests and examples use public landmarks only. Keep it that way.

Making this private would mean copying it into a new private repository. The
owner has not asked for that. Do not do it on your own initiative.

## What not to touch

- **Upstream's files, beyond what a feature needs.** The fork must keep merging
  cleanly from `upstream/main`. Put new code in new files where possible. The
  fork's own code is listed in SYNERGY.md.
- **`README.md`.** It is upstream's. The fork keeps one pointer line at the top
  and nothing else; fork notes go in `SYNERGY.md`.
- **The CCTV layer's "zero-raycast" rule** (`src/layers/cctv/`). It protects a
  live per-frame layer. The planner casts rays on purpose, once per camera, in
  its own files. Do not move ray casting into the CCTV layer.
- **`.env`.** Keys are added by the owner through the app's POWER UP panel.

## How to work here

- Node 24 is required. If `node` is not on `PATH`, it may be installed per-user
  under `~/.local/node/bin`.
- Follow upstream's conventions: `CONTRIBUTING.md`, `docs/CODE-BOUNDARIES.md`,
  `docs/UI-OWNERSHIP.md`. Two-space indent, single quotes, semicolons.
- A new source file must be listed in `scripts/package-boundaries.json`, and a
  new Material Symbols icon in the `icon_names` list in `index.html`, or the
  checks fail.
- Before committing, all of these must pass:

  ```bash
  npm test
  npm run format:check
  npm run check:boundaries
  npm run build
  node scripts/qa-site-camera.mjs   # dev server must be running
  ```

- Test in the real browser with the QA script, not a background tab. A hidden
  tab does not render, so the map never loads and coverage reads 0%.
- Update `SYNERGY.md` and this file in the same commit as the change they
  describe.

## How to ship

Commit to `synergy/site-recon` and push to `origin` (the fork). There is no
deployment; the app runs locally. Do not open a pull request against upstream
unless the owner asks.

## Decisions made, and why

- **Fork and clone, not the one-click installer.** The code is edited, and the
  installer keeps its own hidden copy that is awkward to change and track.
- **Goals are job-site recon, camera coverage planning, and keeping the app's
  demo appeal.** Rebranding and adding it to the company's tool hub were
  declined for now.
- **Measurements are in feet**, with metres kept internally.
- **Coverage is shown as DORI bands**, because those map directly onto what a
  camera is quoted to do (identify, recognize, observe, detect).
- **Real blocking uses a ray grid, not the existing geometric cone**, because
  the cone ignores walls and the point is to find blind spots.
- **A hand-raised mount measures from the clicked point**, not from a separate
  terrain lookup; the two disagree by a few tenths of a metre.
- **Casting yields with a timer, not `requestAnimationFrame`**, so it finishes
  in a tab the user is not looking at.
- **Sites are saved in the browser and as files**, not on a server.

## Exact next step

There is none in progress. If the owner restarts the work, the candidate list
is in [SYNERGY.md](SYNERGY.md#next-steps); ask which one first.
