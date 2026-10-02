# SMC Loot Placement

A crowdsourced loot map for **Super Mecha Champions**' Battle Royale map
(`bw_all06`), rendered in 3D from the game's own geometry. Players fly the map,
drop pins (chests, jump pads, rechargers) and vote on each other's pins.
Pure static front end (three.js) plus a tiny pin API.

## Run it (30 seconds)

```bash
python3 server/server.py          # needs only Python 3, no installs
# open http://localhost:8934
```

This serves the site **and** the pin API, stores pins in `server/pins.db`
(SQLite, created on first run) and seeds it with the 105 pins in
`seed/pins.json`. Options: `PORT=8080`, `DB_PATH=...`, `ADMIN_TOKEN=...`.

**Admin** (deleting pins): click *Admin sign-in* and enter the token
(`ADMIN_TOKEN`, default `admin` -- **change it before hosting publicly**).
Players can add and vote freely; a pin auto-deletes at -10 votes.

**Where pins live:** in `server/pins.db` (SQLite, gitignored). `seed/pins.json`
is only the starting data, loaded when the DB is empty. **Back up / move pins:**
`python3 server/export_pins.py > pins-backup.json` (same format as the seed;
to restore, delete `pins.db`, drop the file at `seed/pins.json`, restart).

**Spam protection:** writes are limited to 30/min per IP (`RATE_LIMIT=0`
disables; behind a reverse proxy set `TRUST_PROXY=1` so the real client IP is
used). Admin requests are exempt.

Needs internet in the browser for three.js (loaded from unpkg, see the import
map in `index.html`).

## Using another database

The front end only talks to `db.js`, which loads one backend chosen in
`config.js`:

| backend | what it is |
|---|---|
| `rest` (default) | any server speaking the 5-endpoint contract at the top of `backends/rest.js`. `server/server.py` is the reference implementation. |
| `supabase` | set `url`/`key` in `config.js`, run `db/schema.sql` (set the admin UID inside). |

To use Postgres/MySQL/Mongo/etc.: create the table from `db/pins.sql`, load
`seed/pins.json`, and change the 5 queries in `server/server.py` (or write the
same endpoints in any language). Nothing in the front end changes. To go
fully custom, add a file in `backends/` exporting `createStore()` with the same
methods as `backends/rest.js` and select it in `db.js`.

Pin rows: `id, x, y, z, kind, tier, note, votes, created_at`.

## Coordinates -- read this before touching positions

- **Pins are stored in true game coordinates** (the same X/Y/Z the game uses;
  Y is up, units are game units). The on-screen readout shows the same values.
- The 3D viewer renders **mirrored in Z** (the game's engine is left-handed,
  three.js is right-handed). `toViewer` / `toGame` in `app.js` just negate Z at
  the DB boundary. If you add a new feature that reads or writes positions,
  convert there -- never store viewer coordinates.
- Geometry in `data/` is already in *viewer* space (Z negated at build time),
  so it needs no conversion at runtime.
- **Where the numbers come from** (all derived from the game's own files, no
  hand-tuning):
  - *Terrain*: 763 tiles; tile `(xi, yi)` is centred at
    `(xi*1664 + 416, yi*1664 + 416)`, from the map's scene file.
  - *Buildings*: 382 instances with position / rotation / scale from the game's
    `house_info.json`. Its rotation is row-vector convention, so the
    **transpose** is applied (invisible at yaw 0/180, wrong at 90/270).
  - *Interiors* ship as separate models; `tools/interior_parts.json` lists them.
  - Map is complete: 382/382 buildings placed.
- Details and proofs: `docs/` (`terrain-placement`, `building-rotation`,
  `handedness`, `interiors`, `missing-data`). Optional reading.

## Using the geometry on its own

`data/manifest.json` (buildings, 2500-unit cells) and `data/terrain_manifest.json`
(terrain tiles) list every `.bin` with its bounding box. Each `.bin` is
little-endian: `"SLPC"` magic, `u32` vertex count, `u32` face count,
`vertex_count x 3` float32 positions, `face_count x 3` uint32 indices. Positions
are already in world space, in the mirrored-Z viewer space described above
(negate Z to get game coordinates). No other transform is needed.

## Files

```
index.html app.js style.css   the site
config.js db.js backends/     pin-storage selection + adapters
server/server.py              local server + SQLite pin API
seed/pins.json                current pin export (105 pins)
db/                           schema.sql (Supabase), pins.sql (portable), migrations/
data/                         shipped geometry: 169 building chunks, 749 terrain tiles
                              (918 .bin files, every one referenced by a manifest)
tools/ docs/                  rebuild scripts (+ tools/lib, tools/config) and how placement was derived
```

## Rebuilding the geometry (optional)

`data/` is committed and the site does not need anything below. Only rebuild if
the game's map changes.

```bash
python3 tools/build_chunks.py     # buildings -> data/chunks/  + data/manifest.json
python3 tools/build_terrain.py    # terrain   -> data/terrain/ + data/terrain_manifest.json
```

Self-contained: the parsers (`tools/lib/`) and the building placement list
(`tools/config/house_info.json`, from the game's configs) are in the repo. Run
from the repo root, Python 3 only. **Verified:** a clean rebuild reproduces the
committed `data/` byte for byte.

Everything the builders need except the raw game meshes is committed:
`tools/_cache/resolved.json` (building type -> mesh files) and
`tools/_cache/terrain_gims/` (the terrain tiles' `.gim` files, 3 MB). The `.gim`
files are used: each lists named sections of a terrain tile's index buffer,
which is how `build_terrain.py` tells real ground (`surface_*`) from baked-in
LOD copies of buildings and cuts the copies out.

**Not in the repo (gitignored, 129 MB):** the raw meshes extracted from the
game's `.npk` archives -- `tools/_cache/meshes/` (building meshes) and
`tools/_cache/terrain_meshes/` (the 763 terrain tile meshes). Nothing here
extracts them; you need the game install and an NeoX `.npk` extractor, then
place the files at the same relative paths the builders read.

`tools/find_interiors.py` (optional; its output `interior_parts.json` is
committed) additionally needs the game archives and the author's `smcStuff`
extractor (`npk_fetch`). Skip it unless new buildings need interiors.

> **Filenames are grid indices**, so a rebuild can reuse a name for different
> content. Compare with `git diff --stat data/` after rebuilding.

Hosting: any static host works for the site if the pin API is reachable at
`config.js`'s `rest.baseUrl`. Serve `data/` with `Cache-Control: no-cache`
(chunk filenames are grid indices and get reused on rebuild; the app already
sends `no-cache` on its requests, and `server.py` sets it).

## Licence / redistribution

The geometry in `data/` is derived from **Super Mecha Champions' game assets**,
which belong to the game's publisher. This project is an unofficial fan tool;
the code is yours to reuse, but check the publisher's terms before hosting
publicly or redistributing `data/`. The extracted source assets are
deliberately not included.
