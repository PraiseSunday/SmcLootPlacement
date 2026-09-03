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
terrain except through the section table. Only the 382 loot-bearing buildings get
full-detail geometry.

## 2. ~~Only the first submesh of each mesh is exported~~ resolved

This section used to call the dropped second submesh "the highest-value fix
available", on the assumption that it held visual geometry — a missing wing,
roof or facade. It does not. `offsets[1]` is the mesh's **collision block**: no
UVs, no material split, and named as a `CollisionBlock` in the owning `.gim`. Its
bounding box matches the visual mesh's within 5% on 143 of the 174 that have one,
and where it differs it is larger (a coarse blocker volume, confirmed against the
`.gim`'s own `BoundingInfo`). Nothing visible is lost by skipping it. Layout in
smcStuff `docs/10-asset-formats.md`.

The real gap behind "this building has no interior" was a naming one, and it is
now fixed — see [`interiors.md`](interiors.md).

## 3. ~~6 of 382 instances have no geometry at all~~ resolved

This section used to list three causes. All three are now fixed; every
`house_info` instance has full-detail geometry. Kept for the record.

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

~~What is left: 5 building types, 6 instances~~ **fixed — the map is now
382/382.** Those five were a name-lookup gap, not a parser gap: the resolver
derives a model name from the `house_info` type by stripping the district
prefix, and these five spell theirs differently. `scene_model_inf.json` (5282
scene model names) supplies the real spelling, and probing every known
`model_new\scene\...` directory for it finds all 17 parts packaged:

| `house_info` type | model name(s) | directory |
| --- | --- | --- |
| `ysg_building_meishuguan_01` | `x_building_meishuguan_{a_01,a_03,b_01..b_04}` + `building_meishuguan_a_02` (7 parts) | `x_model\08_nex`, `building\common` |
| `msq_building_shigong_03` | `building_common_shigong_03` | `building\common` |
| `ytq_building_youtingjianzhu_01` | `building_common_youtingjianzhu_01{,a,b,c}` | `building\common` |
| `xx_building_sushelou` | `building_xuexiao_sushelou_{a,b,d}` | `building\xuexiao` |
| `hjfs_items_inside_hjjd_jizhuangxiang_03` | `items_inside_jizhuangxiang_03` | `items\inside` |

The visible one is `ysg_building_meishuguan_01`, the art museum — a 3320 × 1380
complex with two lobes joined by a colonnaded forecourt. Players had already
pinned five chests inside its footprint; with no geometry to hit, every one of
those pins fell through to the `y = 0` fallback plane. All five names are
recorded in `tools/extra_resolved.json` alongside the other hand-found ones.

### The museum ships twice, and only one of the two can be placed

Picking `building_meishuguan_{a,b}_{01..04}` — the obvious eight-part match —
put both upper storeys on top of each other in the middle of the building. That
set is a **component library**: `_a_03` and `_a_04` are authored around their own
centre (bbox exactly ±968 × ±291 × ±574 and ±683 × ±237 × ±430), so they carry no
position, and applying the instance transform stacks them at the origin. The
give-away is vertical — a part that stands on the ground has its floor at y ≈ 0,
while these straddle that plane evenly, 291 units of geometry below it. The
"basement" an earlier version of this doc reported was exactly that artefact.

`model_new\scene\x_model\08_nex` holds the same building split **by location**
instead: `x_building_meishuguan_a_01` is the west lobe (centre x = −604),
`a_03` the east one (x = +727), and the four `b_*` parts are the floors under
them. Same geometry — the two `b` sets differ by a single vertex out of 14,823 —
but every part sits in the whole model's frame. The frames are shared, which is
what makes mixing them safe: `x_building_meishuguan_a_02` is a 100% exact subset
of the plain `building_meishuguan_a_02`, so the plain one is used for the ground
sheet (it also covers the east half, which the `x_` split drops) and the `x_`
parts for everything else.

`build_chunks.py` now warns when a resolved type mixes the two kinds, so a
library module stacked at a building's centre shows up in the build output
instead of only in the viewer.

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
