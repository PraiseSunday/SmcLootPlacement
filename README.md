# SMC Loot Placement

A crowdsourced chest/loot map for **Super Mecha Champions**' Battle Royale map
(`bw_all06`), rendered from the game's own geometry rather than a drawn image.
Players fly the map in 3D, drop pins where they actually find chests, and vote on
each other's pins. Static site — GitHub Pages plus Supabase for the pin data.

## Why real geometry

A flat map image cannot answer "which floor" or "which side of the building",
which is exactly what loot pins need. So the site renders the real thing:

- **763 terrain tiles** — ground, roads, bridges and scenery, from the game's LOD
  chunks
- **376 buildings** — full-detail meshes, individually placed and rotated

Both are streamed in around the camera, so the whole 75 MB of geometry is never
loaded at once.

## Running it locally

```bash
python3 -m http.server 8934      # from the repo root
# then open http://localhost:8934/index.html
```

The `data/` directory is committed, so the site runs as-is. You only need the
build tools below if you want to regenerate it.

## Rebuilding the geometry

The builders read the extracted game assets through the sibling
[`smcStuff`](../smcStuff) repo, which must sit next to this one. They rely on
`tools/_cache/` (gitignored): extracted `.mesh` files for buildings and terrain
tiles, the tiles' `.gim` files, and `resolved.json` mapping building types to mesh
paths.

```bash
python3 tools/build_chunks.py     # buildings  -> data/chunks/    + data/manifest.json
python3 tools/build_terrain.py    # terrain    -> data/terrain/   + data/terrain_manifest.json
```

Both emit a compact binary blob per cell (`SLPC` magic, little-endian: `u32`
vertex count, `u32` face count, then `vertex_count × 3` float32 positions and
`face_count × 3` uint32 indices) plus a JSON manifest of bounding boxes used for
streaming.

> **Filenames are grid indices**, so a rebuild can reuse a filename for entirely
> different content. Neither `python -m http.server` nor GitHub Pages sends
> `Cache-Control` or `ETag`, so the app requests all data with `cache: "no-cache"`
> — without that, a browser serves stale chunks and the map looks broken in a way
> that mimics a placement bug.

## Coordinates

The viewer renders **mirrored in Z** relative to the game, because NeoX is
left-handed and three.js is not. The database and the on-screen coordinate
readout use **true game coordinates**; `toViewer` / `toGame` in `app.js` flip Z
at that boundary. See
[`docs/handedness.md`](docs/handedness.md).

## Documentation

| Doc | What's inside |
|-----|---------------|
| [`docs/terrain-placement.md`](docs/terrain-placement.md) | Where the tile grid comes from (pitch 1664, origin 416), read from the game's scene file; the FFT/occupancy verification, and why earlier statistical fits failed |
| [`docs/building-rotation.md`](docs/building-rotation.md) | `house_info.json`'s `rot` is row-vector convention, so apply the transpose; why the error was invisible at yaw 0/180 |
| [`docs/handedness.md`](docs/handedness.md) | The map really was mirrored; the proof against the game's own minimap image, and the caveat on what it does and doesn't establish |
| [`docs/missing-data.md`](docs/missing-data.md) | What is absent and why the map is uneven — no reachable scene object graph, unexported submeshes, 27 unparsed instances |

Asset format specs (`.scn`, `.gim`, the mesh exporter) live in smcStuff's
`docs/10-asset-formats.md`; the reconstruction story is in its
`docs/archaeology/bw-all06-map-reconstruction.md`.

## Layout

```
index.html  app.js  style.css   the site
admin-setup.html                one-off admin helper
db/schema.sql                   Supabase tables + row-level security policies
data/                           committed geometry (chunks, terrain, manifests)
tools/                          the builders
docs/                           how the placement was derived
```
