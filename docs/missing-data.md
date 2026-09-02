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
terrain except through the section table. Only the 376 loot-bearing buildings get
full-detail geometry.

## 2. Only the first submesh of each mesh is exported

`mesh_to_obj.parse` extracts the main submesh and size-accounts the rest
(matching NeoXtractor's own scope). Of the 310 unique building meshes we place,
**172 have a second submesh that we drop**:

| | |
| --- | --- |
| single-submesh (fully exported) | 138 |
| multi-submesh (partial) | 172 |
| dropped share of mesh bytes | median 11.4%, mean 13.3%, max 69.4% |

Worst cases: `building_bangqiuchang_01_a` (69.4%), `building_ylc_qiang_01`
(41.4%), `building_zuodao_01_d` (40.8%), `building_xzq_03_a` (37.8%). This is
per-building, so it reads as
individual buildings missing a wing, a roof or a facade rather than as a regional
problem. Porting the non-main submesh path is the highest-value fix available.

## 3. 6 of 382 instances have no geometry at all

This section used to list three causes. Two of them are now fixed and only the
third is left.

~~25 parts fail with `unresolved vertex layout (type=-1, bone_type=0)`~~
**fixed.** That error was a missing case in `mesh_to_obj`'s vertex-layout
resolver, not a missing asset. 24 static building meshes carry a **trailing RGBA8
vertex-colour block** (4 bytes per vertex) after their UV table; the resolver
only tested for that block on float16 meshes, so the float32 ones never resolved
at all. The block sits past the face table, so nothing about the decode was
ambiguous once the case was added — positions and indices are read exactly as
before, and no mesh that already parsed changed. Every mesh in the cache now
parses (310/310, up from 286/310). Details, including the evidence that the block
really is vertex colour rather than extra geometry: smcStuff
`docs/archaeology/neox-mesh-vertex-colour-block.md`.

A user reported the most visible casualty: the **hotel** in `djjd`, whose three
parts (`building_jiudian_a01/a02/a03`) were all in the failing set, so the whole
building was absent. 18 building types across 19 instances were affected — 9
missing entirely, the rest missing a wing or a facade:

| missing entirely | missing 1 part of 2–3 |
| --- | --- |
| `djjd_building_jiudian_a01`, `a02`, `a03` (the hotel) | `aeft_building_new_djt_01` |
| `cbd_building_segu_a09` | `cbd_building_segu_a02`, `a03`, `a10` |
| `msq_building_dxgc_01` | `gly_building_xcj_05` |
| `msq_building_xzq_03`, `xzq_07`, `xzq_15_a` | `hgz_building_lrsz_a02` |
| `xx_building_school_02` | `msq_building_xzq_01` |
| | `tlzx_building_hospital_03`, `hospital_04` |

~~12 parts have comma-joined candidate paths~~ **fixed.** A few `resolved.json`
entries store two candidate `.gim` locations for one part in a single
comma-separated string (the model appears under both `scene\building` and
`scene\items`). `build_chunks.py` now splits on the comma and takes whichever
candidate is on disk.

The two fixes are independent and compose:

| instances with geometry | old path handling | comma-split |
| --- | --- | --- |
| **old parser** | 355 | 367 |
| **vertex-colour fix** | 364 | **376** |

**What is left: 5 building types, 6 instances**, which the name resolver never
mapped to a `.gim` at all — `hjfs_items_inside_hjjd_jizhuangxiang_03` (2),
`msq_building_shigong_03`, `ytq_building_youtingjianzhu_01`,
`ysg_building_meishuguan_01`, `xx_building_sushelou`. That is a name-lookup gap
of the kind described in section 1, not a parser gap: there are now **zero** mesh
parse failures and zero unsplit paths.

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
