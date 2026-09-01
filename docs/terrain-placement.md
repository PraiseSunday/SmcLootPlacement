# Terrain tile placement (bw_all06)

How the ground/road/bridge LOD tiles are positioned in world space, and where the
numbers come from.

## The answer

```
world_centre(xi, yi) = (xi * 1664 + 416,  yi * 1664 + 416)
```

Tile meshes are `model_new/scene/bw_all06_xc/bw_all06_content/lodmodels/l1_<xi>_<yi>_0.mesh`.
Their vertex data is **tile-local and tile-centred** (local coords run about ±832
around 0, with some overhang where props straddle the seam), so a tile needs only
its world centre — no rotation or scale. Y is already world-space elevation.

Tile indices are signed and centred on the map origin: `xi ∈ [-16, 15]`,
`yi ∈ [-15, 15]` — 763 non-empty tiles out of a 32×32 grid.

No regional or per-tile corrections are needed or used.

## Where it comes from

The client loads `scene/bw_all06_xc/bw_all06.scn` (named by `cSceneName` in
`build/configs/map_config.json`). That is a NeoX property file, magic
`0x0D4159C1` — the same container as `.gim`/`.mtl`. Decode it with the sibling
smcStuff repo's `build/scn_parse.py` (format documented in its
`docs/10-asset-formats.md`, "NeoX scene files"); its `Terrain`/`Landscape` node
states:

| field        | value    |
| ------------ | -------- |
| `GridSize`   | 26       |
| `NumColumns` | 2048     |
| `NumRows`    | 2048     |
| `OffsetX`    | -27040   |
| `OffsetZ`    | -27040   |
| `PatchSize`  | 128      |
| `HeightMin`  | -319.97  |
| `HeightMax`  | 1588.77  |

So the heightfield covers `26 × 2048 = 53248` units, spanning **-27040 → +26208**
on both axes. That is exactly 32 tiles of `53248 / 32 = 1664`, and the same file
confirms 1664 directly as a `LODChunk` `ChunkSize`. Three LOD tiers appear:
**832** (`l0`), **1664** (`l1`, what we use), **6656** (coarsest).

Tile `xi = -16` has its low edge on the heightfield's low corner at -27040, so its
*centre* is at `-27040 + 832 = -26208`, giving `centre(xi) = xi * 1664 + 416`.

Sanity checks that all agree: `map_config.json`'s walkable box is
`[-26950, -26000] → [26175, 26175]`, and the built terrain's actual bbox is
X `[-26730, 26042]`, Z `[-25065, 25482]` — both sit snugly inside the declared
heightfield extent, and the terrain and building layers now terminate together.

## Independent confirmation

The `l1_*` meshes are whole-scene LOD chunks: they contain **simplified copies of
the buildings** we already place exactly from `house_info.json`. So the correct
placement is the one that drops those LOD copies onto the real buildings, which
makes this a 2D point-cloud registration problem with an unambiguous answer.

Zero-mean FFT cross-correlation of the terrain vertices against the building
vertices (16-unit raster, whole map) recovers the offset with no prior:

| candidate                        | recovered shift  | peak  | SNR   |
| -------------------------------- | ---------------- | ----- | ----- |
| pitch 1664, origin **0**         | **+416, +416**   | 13664 | 14.9  |
| pitch 1664, origin **416**       | **0, 0**         | 13664 | 16.0  |
| old fit 1691/1651                | -304, +176       |  5714 |  4.6  |

A direct occupancy-overlap sweep at 4-unit resolution gives a single clean peak
at exactly (416, 416), and the pitch sweep spikes hard at exactly 1664:

```
pitch  1660 -> 43912    1662 -> 53169    1664 -> 132744    1666 -> 54058    1668 -> 43526
```

Being 2 units off in pitch halves the score. The previously-deployed 1691/1651
fit scores 23913 — 5.5× worse.

## The decode trap that hid this

smcStuff's `material_parse.py` reads this container's string-table counts as a
single byte. That is correct for every material (all have <128 names), but a
`.scn` has 68 element + **172** attribute names, and 172 is a two-byte LEB128
varint. Read as `u8`, the second table's count is swallowed as the tail of the
first table's last name, names split across the boundary (`OffsetX` / `ffsetZ`),
and every offset after that is wrong — which is why an earlier pass at this file
produced garbled, unusable candidates and the whole `.scn` route looked like a
dead end. Fixed in `material_parse.py`, and `scn_parse.py` uses a varint.

## Why the earlier statistical fits failed

Two things, worth remembering for any similar job:

1. **Wrong pitch cannot be rescued by any offset.** A pitch error produces a
   placement error that grows linearly with distance from the origin, so a
   single global shift can only ever fix one band of the map. This is exactly
   why earlier per-region correction patches appeared necessary, and why regions
   far from the calibration point "seemed like they did not even get the offset".
   Those regional patches were compensating for the pitch being wrong, not for
   any genuine local variation. They are all gone now.

2. **Bounding-box containment is far too slack a metric.** Scoring a fit by
   "does building X fall somewhere inside predicted tile Y" tolerates errors of
   hundreds of units, because tiles are 1664 units wide. It reported 99.5%
   "coverage" for a fit that was visibly ~450 units out. Registering the actual
   geometry — which is possible here precisely *because* the LOD tiles duplicate
   the buildings — is both stricter and easier.

## Known remaining cosmetic issue

Because `l1_*` tiles bake in simplified copies of the buildings, every building
is now drawn twice: once as its full-detail mesh, once as coincident LOD
geometry inside the terrain tile. With the placement correct these overlap
exactly rather than sitting apart, but they still z-fight. Culling the
building-like geometry out of the terrain tiles is a separate job.
