# What the map is missing, and why it is uneven

Placement is now read from the game's own data ([terrain](terrain-placement.md),
[rotation](building-rotation.md), [handedness](handedness.md)), so what remains is
not *wrong* data — it is *absent* data. The gaps are unevenly distributed, which
is why some districts look convincing and others look sparse or half-built.

## 1. There is no scene object graph available (the big one)

`house_info.json` is a **gameplay** config (`configs/item_control/bw_all06/`), not
a scene file: 382 instances of 210 building types, and it exists to say which
buildings contain loot. Compare it with the game's own map image — roads, walls,
terrain props, trees, fences, small structures and any building without loot are
simply not in it, and there is no other reachable source.

The real scene graph is streamed from the `ContentPath` named in `bw_all06.scn`
(`scene\bw_all06_xc\bw_all06_content`), and those filenames are not derivable —
~1,260 candidate paths hash to zero `res*.npk` entries. The `.scn` itself carries
no instances at all (its `house` / `road` / `tree` elements are LOD-distance
categories). Details in smcStuff `docs/10-asset-formats.md`.

**Correction to an earlier version of this doc**, which claimed scenery-heavy
districts therefore render empty. They do not. The `l1` tiles are whole-*scene*
LOD chunks, so the rocks, props and non-loot structures are already present —
baked into the terrain layer as simplified copies. Their `.gim` section names
even identify them individually (`rock` 4112 sections, `items` 3701, `building`
157; see smcStuff `docs/10-asset-formats.md`).

So the accurate statement is narrower: scenery renders at **LOD quality only**,
cannot be placed or manipulated independently, and cannot be told apart from
terrain except through the section table. Only the 355 loot-bearing buildings get
full-detail geometry.

## 2. Only the first submesh of each mesh is exported

`mesh_to_obj.parse` extracts the main submesh and size-accounts the rest
(matching NeoXtractor's own scope). Of the 308 unique building meshes we place,
**170 have a second submesh that we drop**:

| | |
| --- | --- |
| single-submesh (fully exported) | 138 |
| multi-submesh (partial) | 170 |
| dropped share of mesh bytes | median 11.4%, mean 13.4%, max 69.4% |

Worst cases: `building_bangqiuchang_01_a` (69.4%), `building_ylc_qiang_01`
(41.3%), `building_zuodao_01_d` (40.8%). This is per-building, so it reads as
individual buildings missing a wing, a roof or a facade rather than as a regional
problem. Porting the non-main submesh path is the highest-value fix available.

## 3. 27 of 382 instances have no geometry at all

- 25 parts fail with `unresolved vertex layout (type=-1, bone_type=0)` — a vertex
  format `mesh_to_obj` does not yet identify
- 12 parts have comma-joined candidate paths (two alternative `.gim` locations in
  one string) that the resolver never splits
- 5 building types are unresolved entirely

## 4. Cosmetic, known

- ~~Buildings render **twice**~~ **fixed.** They used to: the full mesh plus the
  simplified copy baked into the `l1` tiles, z-fighting the whole map. The tiles'
  `.gim` section tables now let `build_terrain.py` cut the duplicates out exactly
  (143,137 faces, 17.8%). Coincident building/terrain vertices went from 7.81% to
  0.06%, and `surface_*` ground coverage is provably untouched — 31,596 cells
  before and after.
- 5 instances have a negative `scale` component. That is authored mirroring, not a
  bug; it inverts winding, which is harmless under `DoubleSide` but will matter if
  backface culling is ever turned on.
